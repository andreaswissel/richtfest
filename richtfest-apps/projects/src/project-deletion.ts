import { and, eq, inArray } from "drizzle-orm";
import type { AppDeps } from "./deps";
import { deletedProjectObjects, buildingExtractionJobs, buildingModels, files, fileVersions, projectLocations, projectMembers, projects, sourceExtractions, sourceModels } from "./schema";

const busy = () => Object.assign(new Error("Finish or cancel uploads and wait for project processing to finish before deleting this project."), { status: 409, code: "project_busy" });

export async function deleteProject(d: AppDeps, projectId: string) {
  return d.db.transaction(async (tx: any) => {
    const scope = (table: any) => and(eq(table.tenantId, d.tenantId), eq(table.projectId, projectId));
    const [project] = await tx.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.tenantId, d.tenantId))).for("update");
    if (!project) return false;
    // Lock parents before children, matching upload and worker write ordering.
    const projectFiles = await tx.select().from(files).where(scope(files)).for("update");
    const fileIds = projectFiles.map((row: any) => row.id);
    const versions = fileIds.length ? await tx.select().from(fileVersions).where(and(eq(fileVersions.tenantId, d.tenantId), inArray(fileVersions.fileId, fileIds))).for("update") : [];
    if (versions.some((row: any) => row.status === "pending")) throw busy();
    const versionIds = versions.map((row: any) => row.id);
    if (versionIds.length) for (const table of [sourceExtractions, sourceModels]) {
      const jobs = await tx.select().from(table).where(and(eq(table.tenantId, d.tenantId), inArray(table.versionId, versionIds))).for("update");
      if (jobs.some((row: any) => ["queued", "running"].includes(row.status))) throw busy();
    }
    const models = await tx.select().from(buildingModels).where(scope(buildingModels)).for("update");
    const modelIds = models.map((row: any) => row.id);
    if (modelIds.length) {
      const jobs = await tx.select().from(buildingExtractionJobs).where(and(eq(buildingExtractionJobs.tenantId, d.tenantId), inArray(buildingExtractionJobs.modelId, modelIds))).for("update");
      if (jobs.some((row: any) => ["queued", "running"].includes(row.status))) throw busy();
      // The storey FK is restrictive; remove jobs before the model's cascades.
      await tx.delete(buildingExtractionJobs).where(and(eq(buildingExtractionJobs.tenantId, d.tenantId), inArray(buildingExtractionJobs.modelId, modelIds)));
    }
    const locations = await tx.select().from(projectLocations).where(scope(projectLocations)).for("update");
    if (locations.some((row: any) => ["queued", "running"].includes(row.contextStatus) || ["queued", "running"].includes(row.lidarStatus))) throw busy();
    if (!d.deleteLinkedProjectData) throw Object.assign(new Error("Project deletion is not configured."), { status: 503, code: "unconfigured" });
    const linkedKeys = await d.deleteLinkedProjectData(tx, projectId, [...fileIds, ...versionIds]);
    await tx.delete(buildingModels).where(scope(buildingModels));
    if (fileIds.length) await tx.delete(fileVersions).where(and(eq(fileVersions.tenantId, d.tenantId), inArray(fileVersions.fileId, fileIds)));
    await tx.delete(files).where(scope(files));
    await tx.delete(projectLocations).where(scope(projectLocations));
    await tx.delete(projectMembers).where(scope(projectMembers));
    // Inquiry, mailbox, inbound email and noise-source children cascade here.
    await tx.delete(projects).where(and(eq(projects.id, projectId), eq(projects.tenantId, d.tenantId)));
    await d.audit(tx, "projects.project.deleted", "project", projectId, { name: project.name, fileCount: fileIds.length, versionCount: versionIds.length });
    // Retain a durable cleanup receipt in the same commit. Bucket outages cannot
    // roll back metadata into references to objects already removed.
    const storageKeys = new Set<string>([...linkedKeys, ...versions.flatMap((row: any) => row.storageKey ? [row.storageKey] : [])]);
    if (storageKeys.size) await tx.insert(deletedProjectObjects).values([...storageKeys].map(storageKey => ({ tenantId: d.tenantId, projectId, storageKey })));
    return true;
  });
}
