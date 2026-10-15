import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { SOURCE_IMAGE_MODEL, SOURCE_IMAGE_QUERY_VERSION, sourceImageQuerySchema, sourceImageAnswersSchema,
  sourceImageClassificationQuestions, type SourceImageQuery, type SourceImageInference, type SourceImageReceipt } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { files, fileVersions, projects, sourceModels } from "./schema";
import { extractSourceVisual } from "./source-text";

export type SourceImageQueryDeps = Pick<AppDeps, "db" | "tenantId" | "requirePermission" | "audit"> & {
  fileStorage: Pick<AppDeps["fileStorage"], "read">;
};
export type SourceImageInfer = (input: SourceImageInference) => Promise<
  { status: "completed"; output: unknown; usage?: unknown } | { status: "unconfigured" }>;
type Entry = { token: string; receipt: SourceImageReceipt; usage?: unknown };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Exact-revision inferred observations only. Unknown dispatches are never replayed. */
export async function querySourceImage(d: SourceImageQueryDeps, projectId: string, raw: SourceImageQuery,
  infer: SourceImageInfer, signal?: AbortSignal): Promise<SourceImageReceipt> {
  d.requirePermission("projects:read");
  d.requirePermission("agent:run");
  const request = sourceImageQuerySchema.parse(raw);
  const questions = request.questions ?? sourceImageClassificationQuestions;
  const { versionId, page } = request;
  const crop = request.crop ?? undefined;
  const base = { versionId, page, ...(crop ? { crop } : {}), provenance: "inferred" as const,
    semanticInspection: false as const, queryVersion: SOURCE_IMAGE_QUERY_VERSION, model: SOURCE_IMAGE_MODEL } as const;
  const receipt = (status: SourceImageReceipt["status"], reason: string): SourceImageReceipt => ({ ...base, status, reason: reason.slice(0, 1000), reused: false });
  // Authorization is deliberately outside and before every cache lookup, including failed entries.
  const [source] = await d.db.select({ version: fileVersions, name: files.name }).from(fileVersions)
    .innerJoin(files, and(eq(files.id, fileVersions.fileId), eq(files.tenantId, d.tenantId), eq(files.projectId, projectId), eq(files.purpose, "project_evidence")))
    .innerJoin(projects, and(eq(projects.id, files.projectId), eq(projects.tenantId, d.tenantId)))
    .where(and(eq(fileVersions.id, versionId), eq(fileVersions.tenantId, d.tenantId), eq(fileVersions.status, "ready")));
  if (!source) throw new Error("Source image not accessible");
  signal?.throwIfAborted();
  const key = createHash("sha256").update(canonical({ ...base, questions })).digest("hex");
  const token = crypto.randomUUID();
  const where = and(eq(sourceModels.versionId, versionId), eq(sourceModels.tenantId, d.tenantId));
  const unknown = receipt("outcome_unknown", "Image inference is pending or its outcome is unknown; no automatic replay and no absence can be inferred.");
  const cached = await d.db.transaction(async (tx: any) => {
    // A legacy revision without an index may cache triage, but querying it must
    // not queue an unrelated generative source-model import.
    await tx.insert(sourceModels).values({ versionId, tenantId: d.tenantId, status: "unsupported" }).onConflictDoNothing();
    const [row] = await tx.select().from(sourceModels).where(where).for("update");
    if (!row) throw new Error("Source model not accessible");
    const entries = { ...row.metadata.imageQueries } as Record<string, Entry>;
    if (entries[key]) return { ...entries[key].receipt, reused: true };
    if (Object.keys(entries).length >= 64) return receipt("limit_reached", "This revision has reached its 64 distinct image-query limit. No absence can be inferred.");
    entries[key] = { token, receipt: unknown };
    await tx.update(sourceModels).set({ metadata: { ...row.metadata, imageQueries: entries }, updatedAt: new Date() }).where(where);
    await d.audit(tx, "projects.source.image.claimed", "source_version", versionId, { page, crop, queryKey: key });
    return null;
  });
  if (cached) return cached;
  const finish = async (result: SourceImageReceipt | null, usage?: unknown) => d.db.transaction(async (tx: any) => {
    const [row] = await tx.select().from(sourceModels).where(where).for("update");
    const entries = { ...row.metadata.imageQueries } as Record<string, Entry>;
    if (entries[key]?.token !== token) return;
    if (result) entries[key] = { token, receipt: result, ...(usage === undefined ? {} : { usage }) };
    else delete entries[key];
    await tx.update(sourceModels).set({ metadata: { ...row.metadata, imageQueries: entries }, updatedAt: new Date() }).where(where);
    await d.audit(tx, "projects.source.image.finished", "source_version", versionId, { page, queryKey: key, status: result?.status ?? "not_dispatched" });
  });
  let usage: unknown;
  try {
    const stream = source.version.storageKey ? await d.fileStorage.read(source.version.storageKey, signal) : null;
    const visual = stream ? await extractSourceVisual(stream, source.version.mimeType ?? "", source.name, { versionId, page, crop }, signal) : null;
    if (visual?.status !== "available" || !visual.image) {
      const result = receipt("unavailable", "The exact source page/crop could not be rendered. No inspection or absence is established.");
      await finish(null); return result;
    }
    signal?.throwIfAborted();
    const result = await infer({ image: visual.image, questions, signal });
    if (result.status === "unconfigured") { await finish(null); return receipt("unconfigured", "Image inference is not configured; no semantic inspection occurred."); }
    usage = result.usage;
    signal?.throwIfAborted();
    const output = result.output as { model?: unknown; answers?: unknown };
    if (output?.model !== SOURCE_IMAGE_MODEL) throw new Error("Unexpected image model");
    const answers = sourceImageAnswersSchema.parse(output.answers);
    if (Object.keys(answers).length !== Object.keys(questions).length) throw new Error("Answer coverage mismatch");
    for (const [id, question] of Object.entries(questions)) {
      const answer = answers[id];
      if (!answer || answer.type !== question.type) throw new Error("Answer type mismatch");
      if (answer.type === "choice" && question.type === "choice") {
        if (!(answer.choice in question.criteria) || Object.keys(answer.probabilities).length !== Object.keys(question.criteria).length
          || Object.keys(question.criteria).some(k => answer.probabilities[k] === undefined)
          || answer.probabilities[answer.choice] !== Math.max(...Object.values(answer.probabilities))
          || Math.abs(Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1) > 1e-6) throw new Error("Invalid choice probabilities");
      }
      if (answer.type === "box" && question.type === "box") {
        const presence = answers[question.presenceQuestion];
        if (presence?.type !== "noul" || Math.abs(presence.noul - answer.presenceProbability) > 1e-6) throw new Error("Box presence mismatch");
        if (presence.noul < 0.9) answer.box = null;
        if (answer.box && crop) answer.box = { left: crop.x + answer.box.left * crop.width, right: crop.x + answer.box.right * crop.width,
          top: crop.y + answer.box.top * crop.height, bottom: crop.y + answer.box.bottom * crop.height };
      }
    }
    const completed = { ...receipt("completed", `${visual.reason} Jev triage only: not direct semantic inspection, verified measurements or proof of absence.`),
      scope: visual.scope, answers };
    await finish(completed, usage); return completed;
  } catch (error) {
    // Only explicit proof that dispatch never happened permits releasing a claim.
    const rejection = error as { code?: string; preDispatch?: boolean };
    if (rejection?.preDispatch === true && rejection.code === "budget_exhausted") await finish(null);
    else await finish(unknown, usage);
    throw error;
  }
}
