import { Router, type Request } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { acousticDatasetSchema, acousticScenarioInputSchema, acousticInputProvenance,
  renderAcousticCalculationReceipts, ok } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { artifacts, artifactRevisions } from "./schema";
import { conflict, createArtifact, missing, sources } from "./workspace";

/** Fork a reviewed input revision into an unreviewed scenario, without inference. */
export function acousticScenariosRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  router.post("/artifacts/:artifactId/calculation-scenarios", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:read");
      d.requirePermission("knowledge:write");
      const artifactId = z.string().uuid().parse(req.params.artifactId);
      const request = acousticScenarioInputSchema.parse(req.body);
      if (!d.calculateAcoustics) throw conflict("Deterministic calculator is unavailable");
      const calculate = d.calculateAcoustics;
      const result = await d.db.transaction(async (tx: any) => {
        const [scope] = await tx.select({ projectId: artifacts.projectId }).from(artifacts).where(and(
          eq(artifacts.id, artifactId), eq(artifacts.tenantId, d.tenantId),
        ));
        if (!scope || !(await d.validateProject(scope.projectId, tx))) throw missing();
        // The same lock as revision writes and approval: a stale approval cannot slip through.
        const [base] = await tx.select().from(artifacts).where(and(
          eq(artifacts.id, artifactId), eq(artifacts.tenantId, d.tenantId),
        )).for("update");
        if (!base) throw missing();
        const [revision] = await tx.select().from(artifactRevisions).where(and(
          eq(artifactRevisions.artifactId, base.id), eq(artifactRevisions.tenantId, d.tenantId),
        )).orderBy(desc(artifactRevisions.version)).limit(1);
        if (!revision || revision.id !== request.expectedRevisionId || base.status !== "approved")
          throw conflict("Use the latest approved input revision as the scenario basis");
        const saved = acousticDatasetSchema.safeParse(revision.payload?.acousticDataset);
        if (!saved.success) throw conflict("This revision has no reusable room inputs");
        const input = structuredClone(saved.data.receipt.input);
        const seen = new Set<string>();
        const changes: { roomId: string; target: string; id: string; field: string; before: number; after: number }[] = [];
        for (const edit of request.adjustments) {
          const key = JSON.stringify([edit.roomId, edit.target, edit.id, edit.field]);
          if (seen.has(key)) throw conflict("Duplicate input adjustment");
          seen.add(key);
          const room = input.rooms.find(r => r.room.id === edit.roomId);
          if (!room) throw conflict("Room has no complete saved calculation inputs");
          const facade = room.facades.find(f => f.id === edit.id);
          const element = room.elements.find(e => e.id === edit.id);
          const target = edit.target === "room" && edit.id === room.room.id ? room.room
            : edit.target === "facade" ? facade : edit.target === "noise" ? facade?.noise
            : edit.target === "element" ? element : undefined;
          const allowed = edit.target === "room" ? ["floorAreaM2"] : edit.target === "facade" ? ["areaM2"]
            : edit.target === "noise" ? ["levelDb"] : element?.kind === "area" ? ["areaM2", "rwDb"]
            : ["dnEWDb", "count", "openingAreaM2"];
          if (!target || !allowed.includes(edit.field)) throw conflict("Unsupported calculation input adjustment");
          const record = target as unknown as Record<string, unknown>;
          const before = record[edit.field];
          if (typeof before !== "number") throw conflict("Calculation field is not numeric");
          if (before === edit.value) continue;
          record[edit.field] = edit.value;
          // A human scenario change is not a quotation from the original source.
          target.provenance = { kind: "assumption", reason: request.reason };
          if (room.fieldEvidence) {
            const field = `${edit.target}/${edit.id}/${edit.field}`;
            room.fieldEvidence = [...room.fieldEvidence.filter(e => e.field !== field), { field, provenance: target.provenance }];
          }
          changes.push({ ...edit, before, after: edit.value });
        }
        // Parse the complete input before execution, including positivity/count/rating limits.
        const checked = acousticDatasetSchema.shape.receipt.shape.input.parse(input);
        const sourceVersionIds = [...new Set([
          ...z.array(z.string().uuid()).parse(revision.sourceVersionIds),
          ...acousticInputProvenance(checked).flatMap(p => p.kind === "source" ? [p.versionId] : []),
        ])];
        await sources(d, base.projectId, sourceVersionIds);
        const dataset = acousticDatasetSchema.parse({ version: 1,
          receipt: { ...calculate(checked), receiptId: crypto.randomUUID() },
          blockers: saved.data.blockers, basedOn: { artifactId: base.id, revisionId: revision.id },
        });
        const text = (value: string) => value.replace(/[\\`*_{}<>#!|\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
        const content = ["# Schallschutznachweis · Außenlärm · Variante",
          "Ungeprüfte Variante aus gespeicherten Eingaben. Keine erneute Quellenextraktion oder Modellbewertung. Fachliche Prüfung und Freigabe stehen aus.",
          `Basis: ${text(revision.title)} · v${revision.version}. Quellenstände bleiben unverändert; neue Uploads werden nicht automatisch übernommen.`,
          `Änderungsgrund: ${text(request.reason)}`,
          "## Eingabeänderungen",
          changes.length ? "| Raum | Objekt | Feld | Bisher | Variante |\n| --- | --- | --- | --- | --- |\n" + changes
            .map(c => `| ${text(c.roomId)} | ${text(c.id)} | ${c.field} | ${c.before} | ${c.after} |`).join("\n") : "Keine Eingabewerte geändert.",
          renderAcousticCalculationReceipts([dataset.receipt], "de"),
          ...(dataset.blockers.length ? ["## Offene Punkte aus der Eingabebasis", ...dataset.blockers.map(b => `- ${text(b)}`)] : []),
        ].join("\n\n");
        const created = await createArtifact(d, tx, { projectId: base.projectId, title: request.title,
          type: "draft", content, sourceVersionIds, payload: { kind: "summary", data: changes } }, undefined, dataset);
        await d.audit(tx, "knowledge.acoustic_scenario.created", "artifact_revision", created.revision.id, {
          artifactId: created.artifact.id, basedOn: dataset.basedOn,
          engine: dataset.receipt.engine, engineVersion: dataset.receipt.version,
          changedFields: changes.length, receiptId: dataset.receipt.receiptId,
        });
        return { ...created, revision: { ...created.revision,
          sourceReferences: await d.sourceReferences(base.projectId, sourceVersionIds) } };
      });
      res.status(201).json(ok(result));
    } catch (error) { next(error); }
  });
  return router;
}
