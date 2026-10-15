import { Router, type Request } from "express";
import { createHash } from "node:crypto";
import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { acousticInputReviewSchema, acousticInputProvenance, exteriorNoiseFactSchema, acousticDatasetSchema,
  renderAcousticCalculationReceipts, ok, type AcousticInputReview } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { agentRunSteps, agentRuns, artifactRevisions, artifacts, messages } from "./schema";
import { conflict, conversation, createArtifact, missing, sources } from "./workspace";
import { exteriorNoiseVisualAreaObservationKey, reconcileExteriorNoiseInputs } from "./acoustic-extraction";

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
  ].flatMap(p => p.kind === "source" ? [p.versionId] : []).concat(
    review.packets.flatMap(p => (p.visualCandidates ?? []).map(candidate => candidate.provenance.versionId)),
  ))];
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
  visualMappings: z.array(z.discriminatedUnion("decision", [
    z.object({ candidateKey: z.string().regex(/^[a-f0-9]{64}$/), decision: z.literal("confirmed"),
      roomId: z.string().trim().min(1).max(200) }).strict(),
    z.object({ candidateKey: z.string().regex(/^[a-f0-9]{64}$/), decision: z.literal("rejected") }).strict(),
  ])).max(100).default([]),
  visualAreaReviews: z.array(z.discriminatedUnion("decision", [
    z.object({ candidateKey: z.string().regex(/^[a-f0-9]{64}$/), observationKey: z.string().regex(/^[a-f0-9]{64}$/),
      decision: z.literal("approved"), roomId: z.string().trim().min(1).max(200) }).strict(),
    z.object({ candidateKey: z.string().regex(/^[a-f0-9]{64}$/), observationKey: z.string().regex(/^[a-f0-9]{64}$/),
      decision: z.literal("rejected") }).strict(),
  ])).max(100).default([]),
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
        let assembled = reconcileExteriorNoiseInputs(review.packets, review.resolutions, review.visualMappings, review.visualAreaReviews);
        const inventoryBefore = [...new Set((assembled.input?.inventory ?? []).map(item => item.roomId))].sort();
        const mappingState = (candidates: typeof assembled.visualCandidates) => candidates
          .map(candidate => ({ candidateKey: candidate.candidateKey,
            decision: candidate.mappingDecision, roomId: candidate.confirmedRoomId }))
          .sort((a, b) => a.candidateKey.localeCompare(b.candidateKey));
        const mappingsBefore = JSON.stringify(mappingState(assembled.visualCandidates));
        const view = (revisionId: string) => ({ artifactId, revisionId, ...assembled,
          inventoryConfirmation: review.inventoryConfirmation, resolutions: review.resolutions });
        if (method === "get") return view(revision.id);
        const input = responseSchema.parse(req.body);
        if (input.expectedRevisionId !== revision.id) throw conflict("Inputs changed. Reload the latest revision before saving.");
        const seenVisualMappings = new Set<string>();
        for (const mapping of input.visualMappings) {
          if (seenVisualMappings.has(mapping.candidateKey)) throw conflict("Duplicate visual candidate mapping");
          seenVisualMappings.add(mapping.candidateKey);
          if (!assembled.visualCandidates.some(candidate => candidate.candidateKey === mapping.candidateKey))
            throw conflict("Visual candidate changed or is no longer available; reload before reviewing it");
          review.visualMappings.push({ ...mapping, actorId: d.actorId, at: new Date().toISOString(), reason: input.reason });
        }
        // Resolve mappings first so an area can only be approved for the identity
        // that is visibly confirmed in this same saved revision.
        assembled = reconcileExteriorNoiseInputs(review.packets, review.resolutions, review.visualMappings, review.visualAreaReviews);
        const seenVisualAreas = new Set<string>();
        for (const areaReview of input.visualAreaReviews) {
          const key = `${areaReview.candidateKey}:${areaReview.observationKey}`;
          if (seenVisualAreas.has(key)) throw conflict("Duplicate visual floor-area review");
          seenVisualAreas.add(key);
          const candidate = assembled.visualCandidates.find(item => item.candidateKey === areaReview.candidateKey);
          if (!candidate?.floorAreaObservation || candidate.floorAreaObservationKey !== areaReview.observationKey)
            throw conflict("Visual floor-area observation changed or is no longer available; reload before reviewing it");
          if (areaReview.decision === "approved"
            && (candidate.mappingDecision !== "confirmed" || candidate.confirmedRoomId !== areaReview.roomId))
            throw conflict("Confirm this candidate's room identity before approving its floor area for that room");
          review.visualAreaReviews.push({ ...areaReview, actorId: d.actorId, at: new Date().toISOString(), reason: input.reason });
        }
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
        assembled = reconcileExteriorNoiseInputs(review.packets, review.resolutions, review.visualMappings, review.visualAreaReviews);
        const inventoryAfter = [...new Set((assembled.input?.inventory ?? []).map(item => item.roomId))].sort();
        const inventoryChanged = JSON.stringify(inventoryBefore) !== JSON.stringify(inventoryAfter);
        const mappingChanged = mappingsBefore !== JSON.stringify(mappingState(assembled.visualCandidates));
        // Changed candidate-to-room associations need a fresh GET and a later
        // confirmation; the same request cannot confirm an association it just changed.
        if (inventoryChanged || mappingChanged) review.inventoryConfirmation = null;
        const savedRevisionId = crypto.randomUUID();
        let calculation: Awaited<ReturnType<typeof createArtifact>> | undefined;
        if (input.action === "calculate") {
          if (!review.inventoryConfirmation || !assembled.input?.rooms.length)
            throw conflict("Confirm the room inventory and resolve at least one room's input gaps before calculating");
          if (!d.calculateAcoustics) throw conflict("Deterministic calculator is unavailable");
        }
        // Saving an answer advances all independently calculable rooms. Inventory
        // confirmation is a review boundary, not a prerequisite for draft arithmetic.
        if (assembled.input?.rooms.length && d.calculateAcoustics) {
          const dataset = acousticDatasetSchema.parse({ version: 1,
            receipt: { ...d.calculateAcoustics(assembled.input), receiptId: crypto.randomUUID() },
            blockers: [...assembled.blockers, ...assembled.sourceNotes,
              ...(!review.inventoryConfirmation ? ["Rauminventar noch nicht bestätigt; Vollständigkeit fachlich prüfen."] : [])],
            basedOn: { artifactId, revisionId: savedRevisionId } });
          const partial = !dataset.receipt.batch?.complete || !review.inventoryConfirmation;
          calculation = await createArtifact(d, tx, { projectId: chat.projectId!,
            title: partial ? "Schallschutznachweis · Außenlärm · Teilstand" : "Schallschutznachweis · Außenlärm · Geprüfte Eingaben", type: "draft",
            content: ["# Schallschutznachweis · Außenlärm",
              partial ? "Teilstand aus gespeicherten Eingaben. Offene Räume bleiben blockiert; kein vollständiger Nachweis und keine fachliche Freigabe."
                : "Aus bestätigtem Rauminventar und geklärten Eingaben. Berechnung fachlich ungeprüft; keine Freigabe.",
              renderAcousticCalculationReceipts([dataset.receipt], "de"),
              ...(dataset.blockers.length ? ["## Offene Eingaben und Hinweise", ...dataset.blockers.map(n => `- ${n.replace(/[\\`*_{}<>#!|\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ")}`)] : []),
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
          body: `Berechnungseingaben gespeichert (${input.changes.length}); visuelle Zuordnungen geprüft (${input.visualMappings.length}); visuelle Flächen geprüft (${input.visualAreaReviews.length}). ${input.reason}`,
          sourceVersionIds: revision.sourceVersionIds });
        if (calculation) await tx.insert(messages).values({ tenantId: d.tenantId, conversationId,
          authorId: d.actorId, actorKind: "agent", body: "Rechenblatt ohne KI-Aufruf erstellt. Fachliche Prüfung und Freigabe stehen aus.",
          openui: `root = ArtifactPdf(${JSON.stringify(calculation.artifact.id)}, ${JSON.stringify(calculation.revision.id)})`,
          sourceVersionIds: revision.sourceVersionIds });
        await d.audit(tx, "knowledge.acoustic_inputs.resolved", "artifact_revision", saved.id, {
          artifactId, previousRevisionId: revision.id, expectedRevisionId: input.expectedRevisionId,
          changedFields: input.changes.map(c => c.key), reason: input.reason,
          visualMappings: input.visualMappings.map(mapping => ({ candidateKey: mapping.candidateKey,
            decision: mapping.decision, ...(mapping.decision === "confirmed" ? { roomId: mapping.roomId } : {}) })),
          visualAreaReviews: input.visualAreaReviews.map(areaReview => ({ candidateKey: areaReview.candidateKey,
            observationKey: areaReview.observationKey, decision: areaReview.decision,
            ...(areaReview.decision === "approved" ? { roomId: areaReview.roomId } : {}) })),
          inventoryChanged, mappingChanged, inventoryConfirmed: !!review.inventoryConfirmation,
          calculationArtifactId: calculation?.artifact.id,
        });
        return { ...view(saved.id), calculation };
      });
      res.json(ok(result));
    } catch (error) { next(error); }
  });
  router.get(`${path}/visual/:candidateKey`, async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:read");
      d.requirePermission("projects:read");
      d.requirePermission("agent:run");
      const artifactId = z.string().uuid().parse(req.params.artifactId);
      const conversationId = z.string().uuid().parse(req.params.conversationId);
      const candidateKey = z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.candidateKey);
      const chat = await conversation(d, conversationId);
      if (!chat.projectId || !(await d.validateProject(chat.projectId))) throw missing();
      const preview = await d.db.transaction(async (tx: any) => {
        const [artifact] = await tx.select().from(artifacts).where(and(eq(artifacts.id, artifactId),
          eq(artifacts.tenantId, d.tenantId), eq(artifacts.projectId, chat.projectId!)));
        if (!artifact) throw missing();
        const [revision] = await tx.select().from(artifactRevisions).where(and(
          eq(artifactRevisions.artifactId, artifactId), eq(artifactRevisions.tenantId, d.tenantId),
        )).orderBy(desc(artifactRevisions.version)).limit(1);
        const parsed = acousticInputReviewSchema.safeParse(revision?.payload?.acousticInputReview);
        if (!parsed.success || parsed.data.conversationId !== conversationId) throw missing();
        const review: AcousticInputReview = parsed.data;
        const assembled = reconcileExteriorNoiseInputs(review.packets, review.resolutions,
          review.visualMappings, review.visualAreaReviews);
        const candidate = assembled.visualCandidates.find(item => item.candidateKey === candidateKey);
        if (!candidate) throw missing("Visual candidate not found");
        const sourceVersionIds = z.array(z.string().uuid()).parse(revision.sourceVersionIds);
        if (!sourceVersionIds.includes(candidate.provenance.versionId)) throw missing("Visual source is not retained by this review");
        await sources(d, chat.projectId, [candidate.provenance.versionId]);
        if (!artifact.runId) throw missing("Visual inspection receipt is unavailable");
        const [receipt] = await tx.select({ input: agentRunSteps.input, output: agentRunSteps.output })
          .from(agentRunSteps).innerJoin(agentRuns, and(eq(agentRuns.id, agentRunSteps.runId),
            eq(agentRuns.tenantId, d.tenantId), eq(agentRuns.projectId, chat.projectId!),
            or(eq(agentRuns.id, artifact.runId), eq(agentRuns.parentRunId, artifact.runId))))
          .where(and(eq(agentRunSteps.id, candidate.provenance.receiptId),
            eq(agentRunSteps.tenantId, d.tenantId), eq(agentRunSteps.kind, "tool"),
            eq(agentRunSteps.status, "completed"))).limit(1);
        const sameCrop = (left: { x: number; y: number; width: number; height: number } | null | undefined,
          right: { x: number; y: number; width: number; height: number } | null | undefined) => {
          const a = left ?? null, b = right ?? null;
          return a === null || b === null ? a === b
            : a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
        };
        const receiptInput = receipt?.input as { name?: unknown; input?: { versionId?: unknown; page?: unknown; crop?: unknown } } | null;
        const receiptOutput = receipt?.output as { status?: unknown; versionId?: unknown; page?: unknown; crop?: unknown; imageHash?: unknown } | null;
        const sourceRequest = { versionId: candidate.provenance.versionId, page: candidate.provenance.page,
          crop: candidate.provenance.crop };
        if (receiptInput?.name !== "inspect_project_source" || receiptInput.input?.versionId !== sourceRequest.versionId
          || receiptInput.input.page !== sourceRequest.page || !sameCrop(receiptInput.input.crop as typeof sourceRequest.crop, sourceRequest.crop)
          || receiptOutput?.status !== "available" || receiptOutput.versionId !== sourceRequest.versionId
          || receiptOutput.page !== sourceRequest.page || !sameCrop(receiptOutput.crop as typeof sourceRequest.crop, sourceRequest.crop)
          || typeof receiptOutput.imageHash !== "string"
          || receiptOutput.imageHash.toLowerCase() !== candidate.provenance.imageHash.toLowerCase())
          throw conflict("The saved visual inspection receipt does not match this candidate");
        return candidate;
      });
      if (!d.inspectSource) throw conflict("Source image preview is unavailable");
      const request = { versionId: preview.provenance.versionId, page: preview.provenance.page,
        crop: preview.provenance.crop };
      const rendered = await d.inspectSource(chat.projectId, request);
      const sameCrop = (left: typeof request.crop | undefined, right: typeof request.crop | undefined) => {
        const a = left ?? null, b = right ?? null;
        return a === null || b === null ? a === b
          : a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
      };
      if (rendered.status !== "available" || rendered.versionId !== request.versionId || rendered.page !== request.page
        || !sameCrop(rendered.crop, request.crop) || rendered.scope === undefined)
        throw conflict("The exact source image is unavailable; its visual receipt could not be verified");
      const renderedImage = rendered.image;
      if (!renderedImage || renderedImage.mediaType !== "image/jpeg" || typeof renderedImage.data !== "string"
        || renderedImage.data.length > 5_600_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(renderedImage.data))
        throw conflict("The exact source image is unavailable; its visual receipt could not be verified");
      const image = Buffer.from(renderedImage.data, "base64");
      if (image.toString("base64") !== renderedImage.data
        || createHash("sha256").update(image).digest("hex") !== preview.provenance.imageHash.toLowerCase())
        throw conflict("The source image no longer matches this candidate's visual receipt");
      res.json(ok({ candidateKey, apartmentLabel: preview.apartmentLabel, roomLabel: preview.roomLabel,
        mapping: preview.mapping, reviewStatus: preview.reviewStatus,
        provenance: { versionId: preview.provenance.versionId, page: preview.provenance.page,
          crop: preview.provenance.crop, receiptId: preview.provenance.receiptId,
          imageHash: preview.provenance.imageHash },
        image: { mediaType: renderedImage.mediaType, data: renderedImage.data },
      }));
    } catch (error) { next(error); }
  });
  return router;
}
