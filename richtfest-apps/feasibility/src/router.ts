import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { calculateFeasibility, feasibilityMethod, feasibilityStudyInput, ok, type FeasibilityStudy } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { feasibilityStudies, feasibilityStudyRevisions } from "./schema";
import { initialStudy } from "./defaults";

import { createBerlinSiteContextRouter } from "./berlin-site-context";
import { createSiteLocationRouter } from "./site-location";
import { createSiteReferencesRouter } from "./site-references";
import { createEvidenceRouter } from "./evidence-router";
import { createSiteAssessmentRouter } from "./site-assessment-router";

const error = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
const uuid = z.string().uuid();

/** The saved study, or an unsaved starting point (revision 0) from the building model and calculation standards. */
async function readStudy(d: AppDeps, projectId: string) {
  const project = await d.project(projectId);
  if (!project) throw error(404, "not_found", "Project not found");
  const [row] = await d.db.select().from(feasibilityStudies).where(and(eq(feasibilityStudies.tenantId, d.tenantId), eq(feasibilityStudies.projectId, projectId))).limit(1);
  const figures = await d.siteFigures(projectId);
  const study: FeasibilityStudy = row
    ? { site: row.site, scenarios: row.scenarios, notes: row.notes, revision: row.revision, updatedAt: row.updatedAt.toISOString() }
    : { ...initialStudy(figures), revision: 0, updatedAt: null };
  const results = study.scenarios.map(scenario => calculateFeasibility(study.site, scenario));
  return { project, study, results, figures, method: feasibilityMethod };
}

export function createRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  router.use(createSiteAssessmentRouter(getDeps));
  router.use(createEvidenceRouter(getDeps));
  router.use(createSiteLocationRouter(getDeps));
  router.use(createSiteReferencesRouter(getDeps));
  router.use(createBerlinSiteContextRouter(getDeps));

  router.get("/projects/:projectId/study", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read");
      const result = await readStudy(d, uuid.parse(req.params.projectId));
      res.json(ok({ ...result, canWrite: d.can("projects:write") }));
    } catch (e) { next(e); }
  });

  // Saves the whole study under optimistic concurrency; every revision is kept as an immutable snapshot.
  router.put("/projects/:projectId/study", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write");
      const projectId = uuid.parse(req.params.projectId);
      const input = feasibilityStudyInput.parse(req.body);
      if (!(await d.project(projectId))) throw error(404, "not_found", "Project not found");
      await d.db.transaction(async (tx: any) => {
        const [current] = await tx.select().from(feasibilityStudies).where(and(eq(feasibilityStudies.tenantId, d.tenantId), eq(feasibilityStudies.projectId, projectId))).for("update").limit(1);
        if ((current?.revision ?? 0) !== input.baseRevision) throw error(409, "revision_conflict", "The study changed since it was loaded; reload before saving");
        const values = { site: input.site, scenarios: input.scenarios, notes: input.notes, updatedBy: d.actorId, updatedAt: new Date() };
        const [study] = current
          ? await tx.update(feasibilityStudies).set({ ...values, revision: current.revision + 1 }).where(eq(feasibilityStudies.id, current.id)).returning()
          // A concurrent first save loses the unique index race and gets the same conflict as a stale revision.
          : await tx.insert(feasibilityStudies).values({ ...values, tenantId: d.tenantId, projectId, createdBy: d.actorId }).onConflictDoNothing().returning();
        if (!study) throw error(409, "revision_conflict", "The study changed since it was loaded; reload before saving");
        await tx.insert(feasibilityStudyRevisions).values({ tenantId: d.tenantId, studyId: study.id, revision: study.revision, method: feasibilityMethod,
          site: input.site, scenarios: input.scenarios, notes: input.notes, createdBy: d.actorId });
        const results = input.scenarios.map(scenario => calculateFeasibility(input.site, scenario));
        await d.audit(tx, "feasibility.study.saved", "feasibility_study", study.id, { projectId, revision: study.revision, method: feasibilityMethod,
          results: results.map(result => ({ kind: result.kind, status: result.status, residualLandValue: result.residualLandValue === null ? null : Math.round(result.residualLandValue) })) });
      });
      res.json(ok({ ...await readStudy(d, projectId), canWrite: d.can("projects:write") }));
    } catch (e) { next(e); }
  });

  // PDF report of the saved study for banks, investors or authorities; unsaved inputs are never reported.
  router.get("/projects/:projectId/study/report.pdf", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read");
      const result = await readStudy(d, uuid.parse(req.params.projectId));
      if (!result.study.revision) throw error(409, "study_not_saved", "Save the study before exporting a report");
      const { studyReportPdf } = await import("./report-pdf");
      const pdf = await studyReportPdf({ ...result, language: req.query.lang === "en" ? "en" : "de" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Disposition", `attachment; filename="machbarkeit-r${result.study.revision}.pdf"`);
      res.end(pdf);
    } catch (e) { next(e); }
  });

  return router;
}
