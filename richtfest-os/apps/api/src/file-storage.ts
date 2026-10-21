import { mkdir, rename, unlink } from "node:fs/promises";
import { createReadStream as openReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import crypto from "node:crypto";
import path from "node:path";
import { HttpError } from "./middleware/auth";
import { env } from "./env";
import {
  S3Client,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const safeStoragePath = (key: string) => {
  if (!/^[a-f0-9-]+\/[a-f0-9-]+\/[a-f0-9-]+\/[a-f0-9-]+$/.test(key))
    throw new Error("Invalid storage key");
  return path.resolve(env.FILE_STORAGE_PATH, key);
};
const checksumTransform = () => {
  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      sizeBytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return {
    transform,
    result: () => ({ sizeBytes, checksum: hash.digest("hex") }),
  };
};
const localStorage = {
  kind: "local" as const,
  initiate: async (
    _key: string,
    mimeType: string,
    localUploadUrl: string,
  ) => ({
    uploadUrl: localUploadUrl,
    headers: { "content-type": mimeType },
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  }),
  saveStream: async (
    key: string,
    stream: NodeJS.ReadableStream,
    mimeType: string,
  ) => {
    const target = safeStoragePath(key);
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.uploading-${crypto.randomUUID()}`;
    const { transform, result } = checksumTransform();
    try {
      await pipeline(
        stream as any,
        transform,
        createWriteStream(temp, { flags: "wx" }),
      );
      const stored = result();
      await Bun.write(
        `${target}.meta.json`,
        JSON.stringify({ ...stored, mimeType }),
      );
      await rename(temp, target);
      return { ...stored, mimeType };
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  },
  head: async (key: string) => {
    try {
      const target = safeStoragePath(key);
      return JSON.parse(await Bun.file(`${target}.meta.json`).text());
    } catch {
      return null;
    }
  },
  remove: async (key: string) => {
    const target = safeStoragePath(key);
    await Promise.all([
      unlink(target).catch(() => undefined),
      unlink(`${target}.meta.json`).catch(() => undefined),
    ]);
  },
  download: async (
    key: string,
    _mimeType: string,
    _localDownloadUrl: string,
  ) => {
    const metadata = await localStorage.head(key);
    return metadata
      ? {
          stream: openReadStream(safeStoragePath(key)),
          sizeBytes: metadata.sizeBytes,
        }
      : null;
  },
  read: async (key: string, signal?: AbortSignal) => {
    if (!(await localStorage.head(key))) return null;
    try {
      return openReadStream(safeStoragePath(key), { signal });
    } catch {
      return null;
    }
  },
};
const bucketReady = Boolean(
  env.BUCKET &&
  env.ACCESS_KEY_ID &&
  env.SECRET_ACCESS_KEY &&
  env.REGION &&
  env.ENDPOINT,
);
const bucketStorage = bucketReady
  ? (() => {
      const client = new S3Client({
        region: env.REGION!,
        endpoint: env.ENDPOINT!,
        forcePathStyle: false,
        credentials: {
          accessKeyId: env.ACCESS_KEY_ID!,
          secretAccessKey: env.SECRET_ACCESS_KEY!,
        },
      });
      return {
        kind: "bucket" as const,
        initiate: async (
          key: string,
          mimeType: string,
          _localUploadUrl: string,
        ) => ({
          uploadUrl: await getSignedUrl(
            client,
            new PutObjectCommand({
              Bucket: env.BUCKET!,
              Key: key,
              ContentType: mimeType,
            }),
            { expiresIn: 900 },
          ),
          headers: { "content-type": mimeType },
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        }),
        // Files the server produces itself (surveys, filed email, generated PDFs) stream into the
        // bucket in 8 MiB parts, so size is never capped by memory; small files are one PUT.
        saveStream: async (
          key: string,
          stream: NodeJS.ReadableStream,
          mimeType: string,
        ) => {
          const hash = crypto.createHash("sha256");
          const partSize = 8 * 1024 * 1024;
          const parts: { ETag?: string; PartNumber: number }[] = [];
          let chunks: Buffer[] = [],
            buffered = 0,
            sizeBytes = 0,
            uploadId: string | undefined;
          const flush = async () => {
            const body = Buffer.concat(chunks);
            chunks = [];
            buffered = 0;
            uploadId ??= (
              await client.send(
                new CreateMultipartUploadCommand({ Bucket: env.BUCKET!, Key: key, ContentType: mimeType }),
              )
            ).UploadId;
            const PartNumber = parts.length + 1;
            const part = await client.send(
              new UploadPartCommand({ Bucket: env.BUCKET!, Key: key, UploadId: uploadId, PartNumber, Body: body }),
            );
            parts.push({ ETag: part.ETag, PartNumber });
          };
          try {
            for await (const chunk of stream as AsyncIterable<Buffer | string>) {
              const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
              hash.update(bytes);
              sizeBytes += bytes.length;
              chunks.push(bytes);
              buffered += bytes.length;
              if (buffered >= partSize) await flush();
            }
            const checksum = hash.digest("hex");
            if (!uploadId)
              await client.send(
                new PutObjectCommand({
                  Bucket: env.BUCKET!,
                  Key: key,
                  ContentType: mimeType,
                  Body: Buffer.concat(chunks),
                  Metadata: { sha256: checksum },
                }),
              );
            else {
              if (buffered) await flush();
              await client.send(
                new CompleteMultipartUploadCommand({
                  Bucket: env.BUCKET!,
                  Key: key,
                  UploadId: uploadId,
                  MultipartUpload: { Parts: parts },
                }),
              );
            }
            return { sizeBytes, checksum, mimeType };
          } catch (error) {
            if (uploadId)
              await client
                .send(new AbortMultipartUploadCommand({ Bucket: env.BUCKET!, Key: key, UploadId: uploadId }))
                .catch(() => undefined);
            throw error;
          }
        },
        head: async (key: string) => {
          try {
            const object = await client.send(
              new HeadObjectCommand({ Bucket: env.BUCKET!, Key: key }),
            );
            return {
              sizeBytes: object.ContentLength ?? 0,
              checksum: object.Metadata?.sha256 ?? object.ChecksumSHA256 ?? "",
              mimeType: object.ContentType ?? "application/octet-stream",
            };
          } catch {
            return null;
          }
        },
        remove: async (key: string) => {
          await client.send(
            new DeleteObjectCommand({ Bucket: env.BUCKET!, Key: key }),
          );
        },
        download: async (
          key: string,
          mimeType: string,
          _localDownloadUrl: string,
        ) => ({
          redirectUrl: await getSignedUrl(
            client,
            new GetObjectCommand({
              Bucket: env.BUCKET!,
              Key: key,
              ResponseContentType: mimeType,
            }),
            { expiresIn: 900 },
          ),
        }),
        read: async (key: string, signal?: AbortSignal) => {
          try {
            const object = await client.send(
              new GetObjectCommand({ Bucket: env.BUCKET!, Key: key }),
              { abortSignal: signal },
            );
            return (object.Body as AsyncIterable<Uint8Array> | undefined) ?? null;
          } catch {
            return null;
          }
        },
      };
    })()
  : null;
const unavailableStorage = {
  kind: "unconfigured" as const,
  initiate: async () => {
    throw new HttpError(
      503,
      "storage_unconfigured",
      "Railway Bucket storage is unconfigured",
    );
  },
  saveStream: async () => {
    throw new HttpError(
      503,
      "storage_unconfigured",
      "Railway Bucket storage is unconfigured",
    );
  },
  head: async () => null,
  remove: async () => {
    throw new HttpError(
      503,
      "storage_unconfigured",
      "Railway Bucket storage is unconfigured",
    );
  },
  download: async () => null,
  read: async () => null,
};
export const fileStorage =
  env.NODE_ENV === "production"
    ? (bucketStorage ?? unavailableStorage)
    : (bucketStorage ?? localStorage);
