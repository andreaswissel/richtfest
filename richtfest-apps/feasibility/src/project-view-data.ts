import { and, eq } from "drizzle-orm";
import { boundedProjectViewData, unavailableProjectViewData, type ProjectViewContext, type ProjectViewData } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { feasibilityStudies, siteAssessments } from "./schema";

/** Saved inputs only: no initialStudy/createEmpty defaults, geometry jobs, vendor calls or new calculations. */
export async function readFeasibilityProjectViewData(d: AppDeps, context: ProjectViewContext): Promise<ProjectViewData> {
  d.requirePermission("projects:read");
  if (context.view !== "feasibility") return unavailableProjectViewData("unsupported_view");
  if (!await d.project(context.projectId)) return unavailableProjectViewData("project_not_found");
  if (context.selection.study === "financial") {
    if (!await d.featureEnabled("feasibility_financial_study")) return unavailableProjectViewData("feature_disabled");
    const [study] = await d.db.select({ revision: feasibilityStudies.revision, site: feasibilityStudies.site,
      scenarios: feasibilityStudies.scenarios, notes: feasibilityStudies.notes, updatedAt: feasibilityStudies.updatedAt })
      .from(feasibilityStudies).where(and(eq(feasibilityStudies.tenantId, d.tenantId), eq(feasibilityStudies.projectId, context.projectId))).limit(1);
    return study ? boundedProjectViewData({ study: "financial", savedInputs: study, results: "not_included" })
      : unavailableProjectViewData("not_saved");
  }
  const [assessment] = await d.db.select({ revision: siteAssessments.revision, input: siteAssessments.input,
    updatedAt: siteAssessments.updatedAt }).from(siteAssessments)
    .where(and(eq(siteAssessments.tenantId, d.tenantId), eq(siteAssessments.projectId, context.projectId))).limit(1);
  return assessment ? boundedProjectViewData({ study: "site", savedInputs: assessment, results: "not_included" })
    : unavailableProjectViewData("not_saved");
}
