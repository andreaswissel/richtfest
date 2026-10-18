import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { calculateSiteAssessment, createEmptySiteAssessmentInput, siteAssessmentInputSchema, siteAssessmentMethod, ok, type SiteAssessmentInput } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { siteAssessments, siteAssessmentRevisions } from "./schema";

const method = siteAssessmentMethod;
const error = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
const conflict = () => error(409, "revision_conflict", "The assessment changed since it was loaded; reload before saving");
const uuid = z.string().uuid();
const designResult = async (input: SiteAssessmentInput) => input.geometry ? (await import("@richtfest/shared/site-design")).calculateSiteDesign(input) : null;

export function createSiteAssessmentRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  router.get("/projects/:projectId/site-assessment", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read");
      const projectId = uuid.parse(req.params.projectId);
      const project = await d.project(projectId);
      if (!project) throw error(404, "not_found", "Project not found");
      const [row] = await d.db.select().from(siteAssessments).where(and(eq(siteAssessments.tenantId, d.tenantId), eq(siteAssessments.projectId, projectId))).limit(1);
      const { baseRevision: _, ...empty } = createEmptySiteAssessmentInput();
      const assessment = row ? { ...row.input, revision: row.revision, updatedAt: row.updatedAt.toISOString() } : { ...empty, revision: 0, updatedAt: null };
      const input = { ...(row?.input ?? empty), baseRevision: assessment.revision };
      res.json(ok({ assessment, result: calculateSiteAssessment(input), design: await designResult(input), canWrite: d.can("projects:write"), project }));
    } catch (e) { next(e); }
  });
  router.put("/projects/:projectId/site-assessment", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write");
      const projectId = uuid.parse(req.params.projectId);
      const input = siteAssessmentInputSchema.parse(req.body);
      const project = await d.project(projectId);
      if (!project) throw error(404, "not_found", "Project not found");
      const { baseRevision, ...snapshot } = input;
      const result = calculateSiteAssessment(input);
      const design = await designResult(input);
      const saved = await d.db.transaction(async (tx: any) => {
        const [current] = await tx.select().from(siteAssessments).where(and(eq(siteAssessments.tenantId, d.tenantId), eq(siteAssessments.projectId, projectId))).for("update").limit(1);
        if ((current?.revision ?? 0) !== baseRevision) throw conflict();
        const values = { input: snapshot, updatedBy: d.actorId, updatedAt: new Date() };
        const [row] = current
          ? await tx.update(siteAssessments).set({ ...values, revision: current.revision + 1 }).where(eq(siteAssessments.id, current.id)).returning()
          : await tx.insert(siteAssessments).values({ ...values, tenantId: d.tenantId, projectId, createdBy: d.actorId }).onConflictDoNothing().returning();
        if (!row) throw conflict();
        await tx.insert(siteAssessmentRevisions).values({ tenantId: d.tenantId, assessmentId: row.id, revision: row.revision, method, input: snapshot, createdBy: d.actorId });
        await d.audit(tx, "feasibility.site_assessment.saved", "site_assessment", row.id, { projectId, revision: row.revision, method, status: result.status });
        return row;
      });
      // Return the exact committed revision, even if another client saves immediately afterwards.
      res.json(ok({ assessment: { ...saved.input, revision: saved.revision, updatedAt: saved.updatedAt.toISOString() }, result, design, canWrite: d.can("projects:write"), project }));
    } catch (e) { next(e); }
  });
  router.get("/projects/:projectId/site-assessment/report.pdf", async (req,res,next) => {
    try {
      const d=getDeps(req);d.requirePermission("projects:read");const projectId=uuid.parse(req.params.projectId);
      const project=await d.project(projectId);if(!project)throw error(404,"not_found","Project not found");
      const [row]=await d.db.select().from(siteAssessments).where(and(eq(siteAssessments.tenantId,d.tenantId),eq(siteAssessments.projectId,projectId))).limit(1);
      if(!row)throw error(409,"assessment_not_saved","Save the site assessment before exporting a report");
      const {siteAssessmentReportPdf}=await import("./site-report-pdf");
      const pdf=await siteAssessmentReportPdf({project,assessment:{...row.input,baseRevision:row.revision},revision:row.revision,updatedAt:row.updatedAt.toISOString(),language:req.query.lang==="en"?"en":"de"});
      res.setHeader("Content-Type","application/pdf");res.setHeader("Cache-Control","private, no-store");res.setHeader("Content-Disposition",`attachment; filename="grundstueckspruefung-r${row.revision}.pdf"`);res.end(pdf);
    }catch(e){next(e);}
  });
  return router;
}
