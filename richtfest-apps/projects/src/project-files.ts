import { lockProject } from "./project-lock";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { AppDeps } from "./deps";
import { bootstrapAutomaticBuildingModel } from "./automatic-building-model";
import { files, fileVersions, sourceExtractions, sourceModels } from "./schema";

/**
 * Registers a ready file version for text extraction and source models. Project
 * evidence PDFs are also enrolled in automatic plan processing, which never
 * claims a source without this receipt.
 */
export async function enrollReadyVersion(tx: any, d: Pick<AppDeps, "tenantId" | "actorId" | "audit">,
  input: { projectId: string; versionId: string; fileName: string; mimeType: string; purpose: string }) {
  await tx.insert(sourceExtractions).values({ versionId: input.versionId, tenantId: d.tenantId });
  const enrolled = input.purpose === "project_evidence" && (input.mimeType === "application/pdf" || /\.pdf$/i.test(input.fileName));
  await tx.insert(sourceModels).values({ versionId: input.versionId, tenantId: d.tenantId,
    ...(enrolled ? { metadata: { automaticBuildingModel: { status: "pending", enrolledAt: new Date().toISOString(), provenance: "inferred", reviewStatus: "unreviewed" } } } : {}) });
  if (enrolled) await bootstrapAutomaticBuildingModel(tx, d, { projectId: input.projectId, sourceVersionId: input.versionId, fileName: input.fileName });
}

export type StoredProjectFile = { fileId: string; versionId: string; name: string; mimeType: string; storageKey: string };

/** Writes bytes to file storage; call registerStoredFile inside the transaction that records why the file exists. Pass `fileId` to store a new revision of an existing file. */
export async function storeProjectFileBytes(d: Pick<AppDeps, "tenantId" | "fileStorage">, projectId: string, input: { name: string; mimeType: string; bytes: Uint8Array; fileId?: string }) {
  const fileId = input.fileId ?? randomUUID(), versionId = randomUUID();
  const storageKey = `${d.tenantId}/${projectId}/${fileId}/${versionId}`;
  const saved = await d.fileStorage.saveStream(storageKey, Readable.from([Buffer.from(input.bytes)]), input.mimeType);
  return { file: { fileId, versionId, name: input.name, mimeType: input.mimeType, storageKey }, saved };
}

/** Records stored bytes as a new file, or with `version` > 1 as the next revision of the file they were stored under. */
export async function registerStoredFile(tx: any, d: Pick<AppDeps, "tenantId" | "actorId" | "audit">, projectId: string,
  stored: Awaited<ReturnType<typeof storeProjectFileBytes>>, source: { sourceType: string; sourceRef?: string | null; sourceMetadata?: Record<string, unknown>; version?: number }) {
  await lockProject(tx, d.tenantId, projectId);
  const { file, saved } = stored, version = source.version ?? 1;
  if (version === 1) await tx.insert(files).values({ id: file.fileId, tenantId: d.tenantId, projectId, name: file.name, sourceType: source.sourceType, purpose: "project_evidence", sourceRef: source.sourceRef ?? null, createdBy: d.actorId });
  await tx.insert(fileVersions).values({ id: file.versionId, tenantId: d.tenantId, fileId: file.fileId, version, status: "ready", sourceMetadata: source.sourceMetadata ?? {},
    checksum: saved.checksum, storageKey: file.storageKey, sizeBytes: saved.sizeBytes, mimeType: file.mimeType, createdBy: d.actorId });
  await enrollReadyVersion(tx, d, { projectId, versionId: file.versionId, fileName: file.name, mimeType: file.mimeType, purpose: "project_evidence" });
  return file;
}
