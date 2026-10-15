import { Router, type Request } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { acousticInputReviewSchema, acousticInputProvenance, exteriorNoiseFactSchema, acousticDatasetSchema,
  renderAcousticCalculationReceipts, ok, type AcousticInputReview } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { artifactRevisions, artifacts, messages } from "./schema";
import { conflict, conversation, createArtifact, missing, sources } from "./workspace";
import { reconcileExteriorNoiseInputs } from "./acoustic-extraction";

/** Server-created review snapshot; generic artifact/model output cannot attach this payload. */
export async function createAcousticInputReview(d: AppDeps, tx: any,
  run: { id: string; projectId: string; conversationId: string | null; messageId: string | null }, packets: unknown[]) {
  if (!run.conversationId) return;
  const review = acousticInputReviewSchema.parse({ version: 1, conversationId: run.conversationId,
    packets, resolutions: [], inventoryConfirmation: null });
  const sourceVersionIds = [...new Set([
    ...review.packets.flatMap(p => p.inventory.map(i => i.provenance)),
    ...review.packets.flatMap(p => (p.facts ?? []).map(f => f.provenance)),
    ...review.packets.flatMap(p => p.rooms.flatMap(r => acousticInputProvenance({ ...r, method: "exterior_noise_facade" }))),
  ].flatMap(p => p.kind === "source" ? [p.versionId] : []))];
  await sources(d, run.projectId, sourceVersionIds);
  const created = await createArtifact(d, tx, { projectId: run.projectId,
    title: "Außenlärm · Eingabenprüfung", type: "draft", sourceVersionIds,
    content: "Quellenbasierte Raumeingaben zur Prüfung. Offene Felder und Widersprüche werden im Gespräch geklärt; keine fachliche Freigabe.",
  }, run.id);
  await tx.update(artifactRevisions).set({ payload: { acousticInputReview: review } }).where(eq(artifactRevisions.id, created.revision.id));
  await tx.insert(messages).values({ tenantId: d.tenantId, conversationId: run.conversationId,
    authorId: d.actorId, actorKind: "agent", runId: run.id, parentMessageId: run.messageId,
    body: "Rauminventar und Berechnungseingaben prüfen. Antworten werden gespeichert; es startet kein weiterer KI-Lauf.",
    openui: `root = AcousticInputReview(${JSON.stringify(created.artifact.id)})`, sourceVersionIds });
  await d.audit(tx, "knowledge.acoustic_inputs.requested", "artifact_revision", created.revision.id, { runId: run.id });
  return created.artifact.id;
}

const responseSchema = z.object({
  expectedRevisionId: z.string().uuid(),
  action: z.enum(["save", "calculate"]),
  reason: z.string().trim().min(1).max(1000),
  confirmInventory: z.boolean().default(false),
  changes: z.array(z.object({ key: z.string().max(1000),
    value: z.union([z.string(), z.number().finite(), z.boolean()]) }).strict()).max(1000),
}).strict();

export function acousticInputReviewRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  const path = "/conversations/:conversationId/acoustic-inputs/:artifactId";
  for (const method of ["get", "post"] as const) router[method](path, async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:read");
      if (method === "post") d.requirePermission("knowledge:write");
      const artifactId = z.string().uuid().parse(req.params.artifactId);
      const conversationId = z.string().uuid().parse(req.params.conversationId);
      const chat = await conversation(d, conversationId);
      if (!chat.projectId || !(await d.validateProject(chat.projectId))) throw missing();
      if (method === "post" && chat.archivedAt) throw conflict("Conversation is archived");
      const result = await d.db.transaction(async (tx: any) => {
        let query = tx.select().from(artifacts).where(and(eq(artifacts.id, artifactId),
          eq(artifacts.tenantId, d.tenantId), eq(artifacts.projectId, chat.projectId!)));
        if (method === "post") query = query.for("update");
        const [artifact] = await query;
        if (!artifact) throw missing();
        const [revision] = await tx.select().from(artifactRevisions).where(and(
          eq(artifactRevisions.artifactId, artifactId), eq(artifactRevisions.tenantId, d.tenantId),
        )).orderBy(desc(artifactRevisions.version)).limit(1);
        const parsed = acousticInputReviewSchema.safeParse(revision?.payload?.acousticInputReview);
        if (!parsed.success || parsed.data.conversationId !== conversationId) throw missing();
        const review: AcousticInputReview = parsed.data;
        await sources(d, chat.projectId, z.array(z.string().uuid()).parse(revision.sourceVersionIds));
        let assembled = reconcileExteriorNoiseInputs(review.packets, review.resolutions);
        const view = (revisionId: string) => ({ artifactId, revisionId, ...assembled,
          inventoryConfirmation: review.inventoryConfirmation, resolutions: review.resolutions });
        if (method === "get") return view(revision.id);
        const input = responseSchema.parse(req.body);
        if (input.expectedRevisionId !== revision.id) throw conflict("Inputs changed. Reload the latest revision before saving.");
        const seen = new Set<string>();
        for (const change of input.changes) {
          const field = assembled.fields.find(f => f.key === change.key);
          if (!field || seen.has(change.key)) throw conflict("Unknown or duplicate input field");
          seen.add(change.key);
          const candidate = field.candidates.find(c => c.value === change.value);
          const fact = exteriorNoiseFactSchema.parse({ roomId: field.roomId, target: field.target,
            id: field.id, field: field.field, value: change.value,
            provenance: candidate?.provenance ?? { kind: "assumption", reason: input.reason } });
          review.resolutions.push({ fact, reason: input.reason, actorId: d.actorId, at: new Date().toISOString() });
        }
        if (input.confirmInventory) review.inventoryConfirmation = { actorId: d.actorId,
          at: new Date().toISOString(), reason: input.reason };
        assembled = reconcileExteriorNoiseInputs(review.packets, review.resolutions);
        const savedRevisionId = crypto.randomUUID();
        let calculation: Awaited<ReturnType<typeof createArtifact>> | undefined;
        if (input.action === "calculate") {
          if (!review.inventoryConfirmation || !assembled.input || assembled.blockers.length)
            throw conflict("Confirm the room inventory and resolve all input gaps before calculating");
          if (!d.calculateAcoustics) throw conflict("Deterministic calculator is unavailable");
          const dataset = acousticDatasetSchema.parse({ version: 1,
            receipt: { ...d.calculateAcoustics(assembled.input), receiptId: crypto.randomUUID() },
            blockers: assembled.sourceNotes, basedOn: { artifactId, revisionId: savedRevisionId } });
          calculation = await createArtifact(d, tx, { projectId: chat.projectId!,
            title: "Schallschutznachweis · Außenlärm · Geprüfte Eingaben", type: "draft",
            content: ["# Schallschutznachweis · Außenlärm",
              "Aus bestätigtem Rauminventar und geklärten Eingaben. Berechnung fachlich ungeprüft; keine Freigabe.",
              renderAcousticCalculationReceipts([dataset.receipt], "de"),
              ...(assembled.sourceNotes.length ? ["## Hinweise aus der Extraktion", ...assembled.sourceNotes.map(n => `- ${n.replace(/[\\`*_{}<>#!|\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ")}`)] : []),
            ].join("\n\n"), sourceVersionIds: revision.sourceVersionIds,
          }, artifact.runId ?? undefined, dataset);
        }
        const [saved] = await tx.insert(artifactRevisions).values({ id: savedRevisionId, tenantId: d.tenantId, artifactId,
          version: revision.version + 1, title: revision.title, content: revision.content,
          payload: { acousticInputReview: acousticInputReviewSchema.parse(review) },
          sourceVersionIds: revision.sourceVersionIds, createdBy: d.actorId }).returning();
        await tx.update(artifacts).set({ status: "draft" }).where(eq(artifacts.id, artifactId));
        await tx.insert(messages).values({ tenantId: d.tenantId, conversationId,
          authorId: d.actorId, actorKind: "user",
          body: `Berechnungseingaben gespeichert (${input.changes.length}). ${input.reason}`,
          sourceVersionIds: revision.sourceVersionIds });
        if (calculation) await tx.insert(messages).values({ tenantId: d.tenantId, conversationId,
          authorId: d.actorId, actorKind: "agent", body: "Rechenblatt ohne KI-Aufruf erstellt. Fachliche Prüfung und Freigabe stehen aus.",
          openui: `root = ArtifactPdf(${JSON.stringify(calculation.artifact.id)}, ${JSON.stringify(calculation.revision.id)})`,
          sourceVersionIds: revision.sourceVersionIds });
        await d.audit(tx, "knowledge.acoustic_inputs.resolved", "artifact_revision", saved.id, {
          artifactId, previousRevisionId: revision.id, changedFields: input.changes.map(c => c.key),
          inventoryConfirmed: input.confirmInventory, calculationArtifactId: calculation?.artifact.id,
        });
        return { ...view(saved.id), calculation };
      });
      res.json(ok(result));
    } catch (error) { next(error); }
  });
  return router;
}
