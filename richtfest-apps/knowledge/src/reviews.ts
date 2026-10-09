import { Router, type Request } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { ok } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { artifacts, artifactRevisions, drafts } from "./schema";

type GetDeps = (req: Request) => AppDeps;

const reviewInput = z.object({
  expectedRevisionId: z.string().uuid(),
});

const missing = (message = "Artifact not found") =>
  Object.assign(new Error(message), { status: 404, code: "not_found" });

const conflict = (message: string) =>
  Object.assign(new Error(message), { status: 409, code: "invalid_state" });

/**
 * Publishes one exact artifact revision into the reviewed-knowledge surface.
 * The artifact row is also the revision writer's lock, so a new revision cannot
 * slip between the latest-revision check and the approval transaction.
 */
export function reviewsRouter(getDeps: GetDeps) {
  const router = Router();

  router.post(
    "/artifacts/:artifactId/review",
    async (req, res, next) => {
      try {
        const d = getDeps(req);
        d.requirePermission("knowledge:read");
        d.requirePermission("knowledge:approve");
        const input = reviewInput.parse(req.body);
        const result = await d.db.transaction(async (tx: any) => {
          const [artifact] = await tx
            .select()
            .from(artifacts)
            .where(
              and(
                eq(artifacts.id, String(req.params.artifactId)),
                eq(artifacts.tenantId, d.tenantId),
              ),
            )
            .for("update");
          if (!artifact) throw missing();
          if (artifact.status === "approved")
            throw conflict("This artifact revision is already reviewed");

          const [latest] = await tx
            .select()
            .from(artifactRevisions)
            .where(
              and(
                eq(artifactRevisions.artifactId, artifact.id),
                eq(artifactRevisions.tenantId, d.tenantId),
              ),
            )
            .orderBy(desc(artifactRevisions.version))
            .limit(1);
          if (!latest) throw missing("Artifact revision not found");
          if (latest.id !== input.expectedRevisionId)
            throw conflict(
              "A newer artifact revision exists. Review the latest revision before approving it.",
            );

          const sourceVersionIds = z
            .array(z.string().uuid())
            .parse(latest.sourceVersionIds);
          const sourceRefs = sourceVersionIds.map((sourceVersionId) => ({
            kind: "source_version" as const,
            sourceVersionId,
            artifactId: artifact.id,
            artifactRevisionId: latest.id,
          }));
          const [reviewedKnowledge] = await tx
            .insert(drafts)
            .values({
              tenantId: d.tenantId,
              projectId: artifact.projectId,
              title: latest.title,
              body: latest.content,
              sourceRefs,
              status: "approved",
              createdBy: latest.createdBy,
              approvedBy: d.actorId,
              approvedAt: new Date(),
            })
            .returning();
          const [approvedArtifact] = await tx
            .update(artifacts)
            .set({ status: "approved" })
            .where(
              and(
                eq(artifacts.id, artifact.id),
                eq(artifacts.tenantId, d.tenantId),
              ),
            )
            .returning();

          const provenance = {
            artifactId: artifact.id,
            artifactRevisionId: latest.id,
            artifactVersion: latest.version,
            reviewedKnowledgeId: reviewedKnowledge.id,
            sourceVersionIds,
          };
          await d.audit(
            tx,
            "knowledge.artifact_revision.approved",
            "artifact_revision",
            latest.id,
            provenance,
          );
          await d.audit(
            tx,
            "knowledge.reviewed_knowledge.published",
            "draft",
            reviewedKnowledge.id,
            provenance,
          );
          return {
            artifact: approvedArtifact,
            revision: latest,
            reviewedKnowledge,
          };
        });

        return res.status(200).json(ok(result, "Artifact revision approved"));
      } catch (error) {
        return next(error);
      }
    },
  );

  return router;
}
