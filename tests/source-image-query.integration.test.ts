import { expect, test } from "bun:test";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { callImageDecisionModel } from "../richtfest-os/apps/api/src/image-decision-runtime";
import { querySourceImage, type SourceImageInfer } from "../richtfest-apps/projects/src/source-image-query";
import { readSourceModel, runSourceModel } from "../richtfest-apps/projects/src/source-model";
import { projects, files, fileVersions, sourceModels, sourceExtractions, sourcePages } from "../richtfest-apps/projects/src/schema";
import { SOURCE_IMAGE_MODEL, SOURCE_IMAGE_QUERY_VERSION, sourceImageClassificationQuestions, type SourceImageQuestions } from "../richtfest-shared/src/source-image-query";
import { eq } from "../richtfest-apps/projects/node_modules/drizzle-orm";
import { execFileSync } from "node:child_process";

const run = process.env.DATABASE_URL ? test : test.skip;
run("image queries are durable, authorized, exact and conservative; upload classification is bounded", async () => {
  const admin = createDatabase(process.env.DATABASE_URL!);
  const namespace = `image_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.pool.query(`create schema ${namespace}`);
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("options", `-c search_path=${namespace}`);
  const { db, pool } = createDatabase(url.toString());
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), projectId = crypto.randomUUID(), fileId = crypto.randomUUID();
  const versionId = crypto.randomUUID(), revision = crypto.randomUUID();
  try {
    for (const table of ["projects_projects", "projects_files", "projects_file_versions", "projects_source_models", "projects_source_extractions", "projects_source_pages", "projects_source_entities", "projects_source_facts"])
      await pool.query(`create table ${table} (like public.${table} including all)`);
    await db.insert(projects).values({ id: projectId, tenantId, name: "Image test", createdBy: actorId });
    await db.insert(files).values({ id: fileId, tenantId, projectId, name: "image.png", sourceType: "upload", createdBy: actorId });
    await db.insert(fileVersions).values([versionId, revision].map((id, i) => ({ id, tenantId, fileId, version: i + 1,
      status: "ready", storageKey: id, mimeType: "image/png", createdBy: actorId })));
    const png = execFileSync("convert", ["-size", "800x800", "xc:white", "png:-"]);
    let reads = 0, calls = 0;
    let missing = false;
    const d = { db, tenantId, requirePermission: () => {}, audit: async () => {},
      fileStorage: { read: async () => { reads++; return missing ? null : (async function* () { yield png; })(); } } };
    const questions: SourceImageQuestions = { present: { type: "noul", instructions: "Is a legend visible?" },
      region: { type: "box", instructions: "Locate the legend", presenceQuestion: "present" } };
    const infer: SourceImageInfer = input => callImageDecisionModel(input, "synthetic-test-key", {
      fetch: async () => { calls++; return Response.json({ model: SOURCE_IMAGE_MODEL,
        usage: { input_tokens: 8, output_tokens: 4 }, answers: { present: { type: "noul", noul: 0.95 },
          region: { type: "box", box: { left: 0.2, right: 0.8, top: 0.1, bottom: 0.9 }, confidence: 0.8 } } }); },
    });
    const request = { versionId, page: 1, crop: { x: 0.25, y: 0.1, width: 0.5, height: 0.5 }, questions };
    const first = await querySourceImage(d, projectId, request, infer);
    expect(first.status).toBe("completed");
    expect(first.semanticInspection).toBe(false);
    expect(first.answers?.region).toEqual({ type: "box", box: { left: 0.35, right: 0.65, top: 0.1 + 0.1 * 0.5, bottom: 0.55 }, confidence: 0.8, presenceProbability: 0.95 });
    expect((await querySourceImage({ ...d }, projectId, { ...request, questions: { region: questions.region!, present: questions.present! } }, infer)).reused).toBe(true);
    expect(calls).toBe(1); expect(reads).toBe(1);
    for (const [deps, project] of [[{ ...d, tenantId: crypto.randomUUID() }, projectId], [d, crypto.randomUUID()]] as const)
      await expect(querySourceImage(deps, project, request, infer)).rejects.toThrow("not accessible");
    await expect(querySourceImage({ ...d, requirePermission: () => { throw new Error("denied"); } }, projectId, request, infer)).rejects.toThrow("denied");
    expect(reads).toBe(1);
    await querySourceImage(d, projectId, { ...request, versionId: revision }, infer);
    await querySourceImage(d, projectId, { ...request, questions: { ...questions, present: { type: "noul", instructions: "Changed question" } } }, infer);
    expect(calls).toBe(3);
    const unknownRequest = { ...request, crop: undefined };
    await expect(querySourceImage(d, projectId, unknownRequest, async () => { throw new Error("ambiguous"); })).rejects.toThrow("ambiguous");
    expect((await querySourceImage(d, projectId, unknownRequest, infer)).status).toBe("outcome_unknown");
    expect(calls).toBe(3);
    const retry = { ...unknownRequest, questions: { present: questions.present! } };
    expect((await querySourceImage(d, projectId, retry, async () => ({ status: "unconfigured" }))).status).toBe("unconfigured");
    missing = true;
    expect((await querySourceImage(d, projectId, retry, infer)).status).toBe("unavailable");
    missing = false;
    await expect(querySourceImage(d, projectId, retry, async () => { throw Object.assign(new Error("budget"), { code: "budget_exhausted", preDispatch: true }); })).rejects.toThrow("budget");
    expect((await querySourceImage(d, projectId, retry, async () => ({ status: "completed", output: { model: SOURCE_IMAGE_MODEL, answers: { present: { type: "noul", noul: 0.1 } } } }))).status).toBe("completed");
    const nullRequest = { ...request, crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } };
    const nullBox = await querySourceImage(d, projectId, nullRequest, async () => ({ status: "completed", output: {
      model: SOURCE_IMAGE_MODEL, answers: { present: { type: "noul", noul: 0.2 },
        region: { type: "box", box: null, confidence: 0.8, presenceProbability: 0.2 } } } }));
    expect(nullBox.answers?.region).toMatchObject({ box: null });
    const malformed = { ...request, page: 2 };
    expect((await querySourceImage(d, projectId, malformed, infer)).status).toBe("unavailable");
    const invalidRequest = { ...request, questions: { present: { type: "noul" as const, instructions: "Invalid answer test" } } };
    await expect(querySourceImage(d, projectId, invalidRequest, async () => ({ status: "completed", output: { model: SOURCE_IMAGE_MODEL, answers: {} } }))).rejects.toThrow();
    expect((await querySourceImage(d, projectId, invalidRequest, infer)).status).toBe("outcome_unknown");
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pendingRequest = { ...request, questions: { present: { type: "noul" as const, instructions: "Pending test" } } };
    const pending = querySourceImage(d, projectId, pendingRequest, async () => {
      entered(); await gate; throw Object.assign(new Error("unknown budget"), { code: "budget_exhausted" });
    });
    await started;
    expect((await querySourceImage(d, projectId, pendingRequest, infer)).status).toBe("outcome_unknown");
    release(); await expect(pending).rejects.toThrow("unknown budget");
    expect((await querySourceImage(d, projectId, pendingRequest, infer)).status).toBe("outcome_unknown");
    const controller = new AbortController();
    const cancelRequest = { ...pendingRequest, questions: { present: { type: "noul" as const, instructions: "Cancellation test" } } };
    await expect(querySourceImage(d, projectId, cancelRequest, async () => { controller.abort(new Error("cancelled")); throw controller.signal.reason; }, controller.signal)).rejects.toThrow("cancelled");
    expect((await querySourceImage(d, projectId, cancelRequest, infer)).status).toBe("outcome_unknown");
    const defaults = await querySourceImage(d, projectId, { versionId, page: 1 }, async input => ({ status: "completed", output: {
      model: SOURCE_IMAGE_MODEL, answers: Object.fromEntries(Object.entries(input.questions).map(([key, question]) => [key,
        question.type === "choice" ? { type: "choice", choice: "unknown", confidence: 1,
          probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === "unknown" ? 1 : 0])) } : { type: "noul", noul: 0.1 }])) } }));
    expect(defaults.status).toBe("completed");
    expect((await querySourceImage(d, projectId, { versionId, page: 1, questions: sourceImageClassificationQuestions }, infer)).reused).toBe(true);
    const [stored] = await db.select().from(sourceModels).where(eq(sourceModels.versionId, versionId));
    expect(stored!.status).toBe("unsupported"); // A tool query never queues full document interpretation.
    expect(JSON.stringify(stored!.metadata)).not.toContain("/9j/");
    expect(JSON.stringify(stored!.metadata)).toContain("inputTokens");
    expect((await readSourceModel(db, tenantId, versionId))!.metadata.imageQueries).toBeUndefined();
    await db.update(files).set({ purpose: "comparison_only" }).where(eq(files.id, fileId));
    await expect(querySourceImage(d, projectId, request, infer)).rejects.toThrow("not accessible");
    await db.update(files).set({ purpose: "project_evidence" }).where(eq(files.id, fileId));
    await db.update(sourceModels).set({ metadata: { ...stored!.metadata, imageQueries: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [String(i), {}])) } }).where(eq(sourceModels.versionId, versionId));
    expect((await querySourceImage(d, projectId, request, infer)).status).toBe("limit_reached");
    await db.update(sourceModels).set({ metadata: stored!.metadata }).where(eq(sourceModels.versionId, versionId));

    // The worker must merge the existing durable image cache, never replace it.
    await db.update(files).set({ name: "plan.pdf" }).where(eq(files.id, fileId));
    await db.update(fileVersions).set({ mimeType: "application/pdf" });
    await db.update(sourceModels).set({ status: "complete" }).where(eq(sourceModels.versionId, revision));
    await db.update(sourceModels).set({ status: "queued" }).where(eq(sourceModels.versionId, versionId));
    await db.insert(sourceExtractions).values({ versionId, tenantId, status: "complete", result: { status: "available", pages: 30 } });
    await db.insert(sourcePages).values({ versionId, tenantId, page: 1, content: { status: "available", text: "Document text" } });
    const classified: number[] = [];
    expect(await runSourceModel({ ...d, reportError: () => {}, structureDocument: async () => ({ status: "completed", output: { entities: [], facts: [] } }),
      classifyImage: async input => { classified.push(input.page);
        return { versionId, page: input.page, status: "unavailable", provenance: "inferred", semanticInspection: false,
          reason: "Missing", model: SOURCE_IMAGE_MODEL, queryVersion: SOURCE_IMAGE_QUERY_VERSION }; } }, new AbortController().signal)).toBe(true);
    expect(classified).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    const [after] = await db.select().from(sourceModels).where(eq(sourceModels.versionId, versionId));
    expect(after!.status).toBe("complete");
    expect(after!.metadata.imageQueries).toEqual(stored!.metadata.imageQueries);
    expect(after!.metadata.imageClassification).toMatchObject({ totalPages: 30, completedPages: 0, missingPages: 24, uninspectedPages: 30 });
    await db.update(sourceModels).set({ status: "queued" }).where(eq(sourceModels.versionId, versionId));
    let failedCalls = 0;
    await runSourceModel({ ...d, reportError: () => {}, structureDocument: async () => ({ status: "completed", output: { entities: [], facts: [] } }),
      classifyImage: async () => { failedCalls++; throw new Error("independent failure"); } }, new AbortController().signal);
    expect(failedCalls).toBe(1);
    expect((await db.select().from(sourceModels).where(eq(sourceModels.versionId, versionId)))[0]!.status).toBe("complete");
    await db.update(sourceModels).set({ status: "running", leaseUntil: new Date(0) }).where(eq(sourceModels.versionId, versionId));
    await runSourceModel({ ...d, reportError: () => {}, structureDocument: async () => { throw new Error("must not run"); },
      classifyImage: async () => { throw new Error("must not run"); } }, new AbortController().signal);
    expect(classified.length).toBe(24);
  } finally {
    await pool.end();
    await admin.pool.query(`drop schema ${namespace} cascade`);
    await admin.pool.end();
  }
}, 60_000);
