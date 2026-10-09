import { Router, type Request } from "express";
import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { ok } from "@richtfest/shared";
import { files, fileVersions, projectMembers, projects } from "./schema";
import { extractAffinityPreview } from "./affinity-preview";
import type { AppDeps } from "./deps";

type GetDeps = (req: Request) => AppDeps;
const projectInput = z.object({
  name: z.string().trim().min(1).max(200),
  customerId: z.string().uuid().optional(),
  status: z.string().max(40).optional(),
});
const projectUpdateInput = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    customerId: z.string().uuid().nullable().optional(),
    status: z.string().trim().min(1).max(40).optional(),
  })
  .strict();
const initiateInput = z.object({
  name: z.string().trim().min(1).max(300),
  mimeType: z.string().trim().min(1).max(200),
  sizeBytes: z.coerce.number().int().nonnegative().optional(),
  sourceType: z.string().trim().min(1).max(80).default("upload"),
  sourceRef: z.string().max(1000).optional(),
  sourceMetadata: z.record(z.unknown()).optional(),
});
const completeInput = z
  .object({ checksum: z.string().max(200).optional() })
  .default({});
const send = (res: any, status: number, body: any) =>
  res.status(status).json(body);
const routeId = (value: string | string[]) => String(value);
const projectFile = async (
  d: AppDeps,
  projectId: string,
  fileId: string,
  version?: number,
) => {
  const conditions: any[] = [
    eq(files.id, fileId),
    eq(files.projectId, projectId),
    eq(files.tenantId, d.tenantId),
    eq(fileVersions.fileId, files.id),
    eq(fileVersions.tenantId, d.tenantId),
  ];
  if (version !== undefined) conditions.push(eq(fileVersions.version, version));
  return (
    await d.db
      .select({ file: files, version: fileVersions })
      .from(files)
      .innerJoin(fileVersions, eq(fileVersions.fileId, files.id))
      .where(and(...conditions))
      .orderBy(desc(fileVersions.version))
      .limit(1)
  )[0];
};

export function createRouter(getDeps: GetDeps) {
  const router = Router();
  router.get("/projects", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("projects:read");
      const rows = await d.db
        .select()
        .from(projects)
        .where(eq(projects.tenantId, d.tenantId))
        .orderBy(desc(projects.createdAt));
      const names = await d.customerNames(
        rows.flatMap((row: any) => (row.customerId ? [row.customerId] : [])),
      );
      return send(
        res,
        200,
        ok(
          rows.map((row: any) => ({
            ...row,
            customerName: row.customerId
              ? (names[row.customerId] ?? null)
              : null,
          })),
        ),
      );
    } catch (e) {
      return next(e);
    }
  });
  router.post("/projects", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("projects:write");
      const input = projectInput.parse(req.body);
      if (input.customerId && !(await d.validateCustomer(input.customerId)))
        throw Object.assign(new Error("Customer not found"), {
          status: 404,
          code: "not_found",
        });
      const row = await d.db.transaction(async (tx: any) => {
        const [created] = await tx
          .insert(projects)
          .values({ ...input, tenantId: d.tenantId, createdBy: d.actorId })
          .returning();
        await tx.insert(projectMembers).values({
          projectId: created.id,
          tenantId: d.tenantId,
          userId: d.actorId,
          access: "owner",
        });
        await d.audit(tx, "projects.project.created", "project", created.id, {
          name: created.name,
        });
        return created;
      });
      return send(res, 201, ok(row, "Project created"));
    } catch (e) {
      return next(e);
    }
  });
  router.patch("/projects/:projectId", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("projects:write");
      const projectId = z.string().uuid().parse(req.params.projectId);
      const input = projectUpdateInput.parse(req.body);
      if (!Object.keys(input).length)
        return send(res, 400, {
          data: null,
          error: { code: "invalid_input" },
          message: "Provide project details to update",
        });
      if (
        input.customerId &&
        !(await d.validateCustomer(input.customerId))
      )
        throw Object.assign(new Error("Customer not found"), {
          status: 404,
          code: "not_found",
        });
      const row = await d.db.transaction(async (tx: any) => {
        const [updated] = await tx
          .update(projects)
          .set(input)
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.tenantId, d.tenantId),
            ),
          )
          .returning();
        if (updated)
          await d.audit(tx, "projects.project.updated", "project", projectId, {
            fields: Object.keys(input),
          });
        return updated;
      });
      if (!row)
        return send(res, 404, {
          data: null,
          error: { code: "not_found" },
          message: "Project not found",
        });
      return send(res, 200, ok(row, "Project updated"));
    } catch (e) {
      return next(e);
    }
  });
  router.get("/projects/:projectId", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("projects:read");
      const projectId = routeId(req.params.projectId);
      const [project] = await d.db
        .select()
        .from(projects)
        .where(
          and(eq(projects.id, projectId), eq(projects.tenantId, d.tenantId)),
        )
        .limit(1);
      if (!project)
        return send(res, 404, {
          data: null,
          error: { code: "not_found" },
          message: "Project not found",
        });
      const members = await d.db
        .select()
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, project.id),
            eq(projectMembers.tenantId, d.tenantId),
          ),
        );
      const names = await d.customerNames(
        project.customerId ? [project.customerId] : [],
      );
      return send(
        res,
        200,
        ok({
          ...project,
          customerName: project.customerId
            ? (names[project.customerId] ?? null)
            : null,
          members,
          files: await listFiles(d, projectId),
        }),
      );
    } catch (e) {
      return next(e);
    }
  });
  const listFiles = async (d: AppDeps, projectId: string) => {
    const rows = await d.db
      .select({ file: files, version: fileVersions })
      .from(files)
      .innerJoin(
        fileVersions,
        and(
          eq(fileVersions.fileId, files.id),
          eq(fileVersions.tenantId, d.tenantId),
          eq(fileVersions.status, "ready"),
        ),
      )
      .where(
        and(eq(files.projectId, projectId), eq(files.tenantId, d.tenantId)),
      )
      .orderBy(desc(files.createdAt), desc(fileVersions.version));
    const latest = new Map<string, any>();
    for (const row of rows as any[])
      if (!latest.has(row.file.id)) latest.set(row.file.id, row);
    return [...latest.values()].map((row: any) => ({
      ...row.file,
      version: row.version.version,
      sizeBytes: row.version.sizeBytes,
      mimeType: row.version.mimeType,
      checksum: row.version.checksum,
      downloadUrl: `/api/projects/${projectId}/files/${row.file.id}/versions/${row.version.version}/download`,
    }));
  };
  router.get("/projects/:projectId/files", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("projects:read");
      return send(
        res,
        200,
        ok(await listFiles(d, routeId(req.params.projectId))),
      );
    } catch (e) {
      return next(e);
    }
  });
  router.get(
    "/projects/:projectId/source-versions/:versionId",
    async (req, res, next) => {
      try {
        const d = getDeps(req);
        d.requirePermission("projects:read");
        const projectId = routeId(req.params.projectId);
        const versionId = routeId(req.params.versionId);
        const [row] = await d.db
          .select({ file: files, version: fileVersions })
          .from(fileVersions)
          .innerJoin(
            files,
            and(
              eq(files.id, fileVersions.fileId),
              eq(files.tenantId, fileVersions.tenantId),
            ),
          )
          .where(
            and(
              eq(fileVersions.id, versionId),
              eq(fileVersions.tenantId, d.tenantId),
              eq(files.projectId, projectId),
              eq(fileVersions.status, "ready"),
            ),
          )
          .limit(1);
        if (!row)
          return send(res, 404, {
            data: null,
            error: { code: "not_found" },
            message: "Source version not found in project",
          });
        return send(
          res,
          200,
          ok({
            fileId: row.file.id,
            fileName: row.file.name,
            sourceType: row.file.sourceType,
            sourceRef: row.file.sourceRef,
            versionId: row.version.id,
            version: row.version.version,
            mimeType: row.version.mimeType,
            checksum: row.version.checksum,
            sourceMetadata: row.version.sourceMetadata,
            createdAt: row.version.createdAt,
            authority: "unreviewed_source",
            downloadUrl: `/api/projects/${projectId}/files/${row.file.id}/versions/${row.version.version}/download`,
          }),
        );
      } catch (e) {
        return next(e);
      }
    },
  );
  router.post("/projects/:projectId/files", async (req, res, next) => {
    try {
      getDeps(req).requirePermission("projects:write");
      return send(res, 410, {
        data: null,
        error: { code: "direct_upload_required" },
        message:
          "Use initiate, direct upload, and complete for file attachments",
      });
    } catch (e) {
      return next(e);
    }
  });
  router.post("/projects/:projectId/files/initiate", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("projects:write");
      const projectId = routeId(req.params.projectId);
      const input = initiateInput.parse(req.body);
      const [project] = await d.db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(eq(projects.id, projectId), eq(projects.tenantId, d.tenantId)),
        )
        .limit(1);
      if (!project)
        return send(res, 404, {
          data: null,
          error: { code: "not_found" },
          message: "Project not found",
        });
      const fileId = crypto.randomUUID();
      const versionId = crypto.randomUUID();
      const storageKey = `${d.tenantId}/${projectId}/${fileId}/${versionId}`;
      await d.db.transaction(async (tx: any) => {
        await tx.insert(files).values({
          id: fileId,
          tenantId: d.tenantId,
          projectId,
          name: input.name,
          sourceType: input.sourceType,
          sourceRef: input.sourceRef,
          createdBy: d.actorId,
        });
        await tx.insert(fileVersions).values({
          id: versionId,
          tenantId: d.tenantId,
          fileId,
          version: 1,
          status: "pending",
          sourceMetadata: input.sourceMetadata ?? {},
          storageKey,
          sizeBytes: input.sizeBytes,
          mimeType: input.mimeType,
          createdBy: d.actorId,
        });
        await d.audit(tx, "projects.file.upload.initiated", "file", fileId, {
          projectId,
          versionId,
        });
      });
      const localUploadUrl = `/api/projects/${projectId}/files/${fileId}/versions/1/upload`;
      try {
        const upload = await d.fileStorage.initiate(
          storageKey,
          input.mimeType,
          localUploadUrl,
        );
        return send(
          res,
          201,
          ok(
            {
              fileId,
              versionId,
              version: 1,
              uploadUrl: upload.uploadUrl,
              uploadMethod: "PUT",
              uploadHeaders: upload.headers,
              completeUrl: `/api/projects/${projectId}/files/${fileId}/versions/1/complete`,
              expiresAt: upload.expiresAt,
            },
            "Upload initiated",
          ),
        );
      } catch (error) {
        await d.db.delete(fileVersions).where(eq(fileVersions.id, versionId));
        await d.db.delete(files).where(eq(files.id, fileId));
        throw error;
      }
    } catch (e) {
      return next(e);
    }
  });
  router.post(
    "/projects/:projectId/files/:fileId/versions/initiate",
    async (req, res, next) => {
      try {
        const d = getDeps(req);
        d.requirePermission("projects:write");
        const projectId = routeId(req.params.projectId);
        const fileId = routeId(req.params.fileId);
        const input = initiateInput
          .pick({ mimeType: true, sizeBytes: true, sourceMetadata: true })
          .parse(req.body);
        const [file] = await d.db
          .select({ id: files.id })
          .from(files)
          .where(
            and(
              eq(files.id, fileId),
              eq(files.projectId, projectId),
              eq(files.tenantId, d.tenantId),
            ),
          )
          .limit(1);
        if (!file)
          return send(res, 404, {
            data: null,
            error: { code: "not_found" },
            message: "File not found",
          });
        const [latest] = await d.db
          .select({ version: fileVersions.version })
          .from(fileVersions)
          .where(
            and(
              eq(fileVersions.fileId, fileId),
              eq(fileVersions.tenantId, d.tenantId),
            ),
          )
          .orderBy(desc(fileVersions.version))
          .limit(1);
        const version = (latest?.version ?? 0) + 1;
        const versionId = crypto.randomUUID();
        const storageKey = `${d.tenantId}/${projectId}/${fileId}/${versionId}`;
        await d.db.transaction(async (tx: any) => {
          await tx.insert(fileVersions).values({
            id: versionId,
            tenantId: d.tenantId,
            fileId,
            version,
            status: "pending",
            sourceMetadata: input.sourceMetadata ?? {},
            storageKey,
            sizeBytes: input.sizeBytes,
            mimeType: input.mimeType,
            createdBy: d.actorId,
          });
          await d.audit(
            tx,
            "projects.file.version.upload.initiated",
            "file",
            fileId,
            { projectId, versionId, version },
          );
        });
        const localUploadUrl = `/api/projects/${projectId}/files/${fileId}/versions/${version}/upload`;
        try {
          const upload = await d.fileStorage.initiate(
            storageKey,
            input.mimeType,
            localUploadUrl,
          );
          return send(
            res,
            201,
            ok(
              {
                fileId,
                versionId,
                version,
                uploadUrl: upload.uploadUrl,
                uploadMethod: "PUT",
                uploadHeaders: upload.headers,
                completeUrl: `/api/projects/${projectId}/files/${fileId}/versions/${version}/complete`,
                expiresAt: upload.expiresAt,
              },
              "Revision upload initiated",
            ),
          );
        } catch (error) {
          await d.db.delete(fileVersions).where(eq(fileVersions.id, versionId));
          throw error;
        }
      } catch (e) {
        return next(e);
      }
    },
  );
  router.put(
    "/projects/:projectId/files/:fileId/versions/:version/upload",
    async (req, res, next) => {
      try {
        const d = getDeps(req);
        d.requirePermission("projects:write");
        if (d.fileStorage.kind !== "local")
          return send(res, 409, {
            data: null,
            error: { code: "direct_bucket_upload_required" },
            message: "Upload directly to the returned bucket URL",
          });
        const projectId = routeId(req.params.projectId);
        const fileId = routeId(req.params.fileId);
        const version = Number(routeId(req.params.version));
        const row = await projectFile(d, projectId, fileId, version);
        if (!row || row.version.status !== "pending" || !row.version.storageKey)
          return send(res, 404, {
            data: null,
            error: { code: "not_found" },
            message: "Pending upload not found",
          });
        const contentType = String(
          req.headers["content-type"] ?? "application/octet-stream",
        );
        if (contentType !== row.version.mimeType)
          return send(res, 400, {
            data: null,
            error: { code: "mime_type_mismatch" },
            message: "Upload content type does not match initiation",
          });
        await d.fileStorage.saveStream(
          row.version.storageKey,
          req,
          contentType,
        );
        return send(res, 200, ok({ uploaded: true }, "Upload received"));
      } catch (e) {
        return next(e);
      }
    },
  );
  router.post(
    "/projects/:projectId/files/:fileId/versions/:version/complete",
    async (req, res, next) => {
      try {
        const d = getDeps(req);
        d.requirePermission("projects:write");
        const projectId = routeId(req.params.projectId);
        const fileId = routeId(req.params.fileId);
        const versionNumber = Number(routeId(req.params.version));
        const row = await projectFile(d, projectId, fileId, versionNumber);
        if (!row || row.version.status !== "pending" || !row.version.storageKey)
          return send(res, 404, {
            data: null,
            error: { code: "not_found" },
            message: "Pending upload not found",
          });
        const input = completeInput.parse(req.body);
        const stored = await d.fileStorage.head(row.version.storageKey);
        if (!stored)
          return send(res, 409, {
            data: null,
            error: { code: "upload_incomplete" },
            message: "The object is not available yet",
          });
        if (
          row.version.sizeBytes !== null &&
          row.version.sizeBytes !== undefined &&
          row.version.sizeBytes !== stored.sizeBytes
        )
          return send(res, 422, {
            data: null,
            error: { code: "size_mismatch" },
            message: "Uploaded object size does not match initiation",
          });
        if (stored.mimeType !== row.version.mimeType)
          return send(res, 422, {
            data: null,
            error: { code: "mime_type_mismatch" },
            message: "Uploaded object type does not match initiation",
          });
        if (
          input.checksum &&
          stored.checksum &&
          input.checksum !== stored.checksum
        )
          return send(res, 422, {
            data: null,
            error: { code: "checksum_mismatch" },
            message: "Uploaded object checksum does not match",
          });
        const ready = await d.db.transaction(async (tx: any) => {
          const [updated] = await tx
            .update(fileVersions)
            .set({
              status: "ready",
              sizeBytes: stored.sizeBytes,
              checksum: input.checksum ?? stored.checksum,
              mimeType: stored.mimeType,
            })
            .where(
              and(
                eq(fileVersions.id, row.version.id),
                eq(fileVersions.status, "pending"),
              ),
            )
            .returning();
          if (!updated)
            throw Object.assign(new Error("Upload was already completed"), {
              status: 409,
              code: "upload_already_completed",
            });
          await d.audit(tx, "projects.file.upload.completed", "file", fileId, {
            projectId,
            versionId: row.version.id,
            version: versionNumber,
            sizeBytes: stored.sizeBytes,
          });
          return updated;
        });
        return send(
          res,
          200,
          ok(
            {
              id: row.file.id,
              name: row.file.name,
              sizeBytes: ready.sizeBytes,
              mimeType: ready.mimeType,
              version: ready.version,
              checksum: ready.checksum,
              downloadUrl: `/api/projects/${projectId}/files/${fileId}/versions/${versionNumber}/download`,
              createdAt: row.file.createdAt,
            },
            "File attached",
          ),
        );
      } catch (e) {
        return next(e);
      }
    },
  );
  router.post(
    "/projects/:projectId/files/:fileId/versions/:version/cancel",
    async (req, res, next) => {
      try {
        const d = getDeps(req);
        d.requirePermission("projects:write");
        const row = await projectFile(
          d,
          routeId(req.params.projectId),
          routeId(req.params.fileId),
          Number(routeId(req.params.version)),
        );
        if (!row || row.version.status !== "pending")
          return send(res, 404, {
            data: null,
            error: { code: "not_found" },
            message: "Pending upload not found",
          });
        if (row.version.storageKey)
          await d.fileStorage.remove(row.version.storageKey);
        await d.db.transaction(async (tx: any) => {
          await tx
            .update(fileVersions)
            .set({ status: "cancelled" })
            .where(
              and(
                eq(fileVersions.id, row.version.id),
                eq(fileVersions.status, "pending"),
              ),
            );
          await d.audit(
            tx,
            "projects.file.upload.cancelled",
            "file",
            row.file.id,
            {
              projectId: routeId(req.params.projectId),
              versionId: row.version.id,
            },
          );
        });
        return send(res, 200, ok({ cancelled: true }, "Upload cancelled"));
      } catch (e) {
        return next(e);
      }
    },
  );
  router.get(
    "/projects/:projectId/files/:fileId/versions",
    async (req, res, next) => {
      try {
        const d = getDeps(req);
        d.requirePermission("projects:read");
        const projectId = routeId(req.params.projectId);
        const fileId = routeId(req.params.fileId);
        const [file] = await d.db
          .select({ id: files.id })
          .from(files)
          .where(
            and(
              eq(files.id, fileId),
              eq(files.projectId, projectId),
              eq(files.tenantId, d.tenantId),
            ),
          )
          .limit(1);
        if (!file)
          return send(res, 404, {
            data: null,
            error: { code: "not_found" },
            message: "File not found",
          });
        return send(
          res,
          200,
          ok(
            await d.db
              .select()
              .from(fileVersions)
              .where(
                and(
                  eq(fileVersions.fileId, fileId),
                  eq(fileVersions.tenantId, d.tenantId),
                ),
              ),
          ),
        );
      } catch (e) {
        return next(e);
      }
    },
  );
  const download = async (
    req: Request,
    res: any,
    next: any,
    versionNumber?: number,
  ) => {
    try {
      const d = getDeps(req);
      d.requirePermission("projects:read");
      const projectId = routeId(req.params.projectId);
      const fileId = routeId(req.params.fileId);
      const row = await projectFile(d, projectId, fileId, versionNumber);
      if (
        !row ||
        row.version.status !== "ready" ||
        !row.version.storageKey ||
        !row.version.mimeType
      )
        return send(res, 404, {
          data: null,
          error: { code: "not_found" },
          message: "Attached file version not found",
        });
      const result = await d.fileStorage.download(
        row.version.storageKey,
        row.version.mimeType,
        `/api/projects/${projectId}/files/${fileId}/versions/${row.version.version}/download`,
      );
      if (!result)
        return send(res, 404, {
          data: null,
          error: { code: "not_found" },
          message: "Attached file object not found",
        });
      if (result.redirectUrl) return res.redirect(302, result.redirectUrl);
      res.type(row.version.mimeType);
      return (result.stream as any).pipe(res);
    } catch (e) {
      return next(e);
    }
  };
  router.get(
    "/projects/:projectId/files/:fileId/versions/:version/download",
    (req, res, next) =>
      download(req, res, next, Number(routeId(req.params.version))),
  );
  router.get(
    "/projects/:projectId/files/:fileId/versions/:version/preview",
    async (req, res, next) => {
      try {
        const d = getDeps(req);
        d.requirePermission("projects:read");
        const projectId = routeId(req.params.projectId);
        const fileId = routeId(req.params.fileId);
        const versionNumber = Number(routeId(req.params.version));
        const row = await projectFile(d, projectId, fileId, versionNumber);
        if (
          !row ||
          row.version.status !== "ready" ||
          !row.version.storageKey ||
          !/\.afpub$/i.test(row.file.name)
        )
          return send(res, 404, {
            data: null,
            error: { code: "preview_unavailable" },
            message: "Affinity Publisher preview is unavailable",
          });
        const stream = await d.fileStorage.read(row.version.storageKey);
        if (!stream)
          return send(res, 404, {
            data: null,
            error: { code: "preview_unavailable" },
            message: "Affinity Publisher preview is unavailable",
          });
        const preview = await extractAffinityPreview(stream);
        if (!preview)
          return send(res, 404, {
            data: null,
            error: { code: "preview_unavailable" },
            message: "No embedded visual preview was found in this file",
          });
        return res
          .status(200)
          .type("image/png")
          .set("Cache-Control", "private, no-store")
          .set("X-Content-Type-Options", "nosniff")
          .send(Buffer.from(preview));
      } catch (e) {
        return next(e);
      }
    },
  );
  router.get("/projects/:projectId/files/:fileId/download", (req, res, next) =>
    download(req, res, next),
  );
  return router;
}
export const dashboardSummary = async (db: any, tenantId: string) => {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.tenantId, tenantId))
    .orderBy(desc(projects.createdAt));
  return { count: rows.length, projects: rows };
};
