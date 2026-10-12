import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RequestHandler } from "express";
import { env } from "./env";

// Only public, hashed build output belongs here. Never accept a bucket key or
// path from the caller, or expose source maps, HTML, manifests or customer files.
const assetName =
  /^[\w.-]+-[\w-]{8,}\.(?:js|css|wasm|woff2?|ttf|otf|png|jpe?g|gif|webp|avif|svg|ico)$/;
const prefix = "web-assets/v1/";
const cacheControl = "public, max-age=31536000, immutable";
const missing = (error: unknown) =>
  (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode === 404;

/** Retain immutable frontend files across container replacements in Railway. */
export class WebAssetArchive {
  constructor(
    private client: S3Client,
    private bucket: string,
  ) {}

  async retain(directory: string) {
    const files = (await readdir(directory, { withFileTypes: true })).filter(
      (file) => file.isFile() && assetName.test(file.name),
    );
    // Bound startup traffic without loading the whole build into memory.
    for (let offset = 0; offset < files.length; offset += 8) {
      await Promise.all(
        files.slice(offset, offset + 8).map(async ({ name }) => {
          const object = { Bucket: this.bucket, Key: prefix + name };
          try {
            await this.client.send(new HeadObjectCommand(object));
            return;
          } catch (error) {
            if (!missing(error)) throw error;
          }
          await this.client.send(
            new PutObjectCommand({
              ...object,
              Body: await readFile(path.join(directory, name)),
              CacheControl: cacheControl,
            }),
          );
        }),
      );
    }
  }

  // Mounted only after local /assets files, keeping current-build requests fast.
  serve: RequestHandler = async (req, res, next) => {
    const name = req.path.slice(1);
    if (!["GET", "HEAD"].includes(req.method) || !assetName.test(name)) {
      next();
      return;
    }
    try {
      const input = { Bucket: this.bucket, Key: prefix + name };
      const object =
        req.method === "HEAD"
          ? await this.client.send(new HeadObjectCommand(input))
          : await this.client.send(new GetObjectCommand(input));
      res
        .type(name)
        .set("Cache-Control", cacheControl)
        .set("X-Content-Type-Options", "nosniff");
      if (object.ContentLength !== undefined)
        res.set("Content-Length", String(object.ContentLength));
      if (req.method === "HEAD") {
        res.end();
      } else if ("Body" in object && object.Body) {
        await pipeline(object.Body as Readable, res);
      } else {
        throw new Error("Archived asset body missing");
      }
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (missing(error)) {
        next();
        return;
      }
      // Do not log SDK errors: they can include signed storage request details.
      console.error("Web asset archive unavailable", { asset: name });
      res.removeHeader("Content-Length");
      res.status(503).set("Cache-Control", "no-store").end();
    }
  };
}

export async function retainWebAssets(directory: string) {
  if (
    !env.BUCKET ||
    !env.ACCESS_KEY_ID ||
    !env.SECRET_ACCESS_KEY ||
    !env.REGION ||
    !env.ENDPOINT
  ) {
    throw new Error(
      "Production web asset retention requires the configured Railway Bucket",
    );
  }
  const archive = new WebAssetArchive(
    new S3Client({
      region: env.REGION,
      endpoint: env.ENDPOINT,
      forcePathStyle: false,
      credentials: {
        accessKeyId: env.ACCESS_KEY_ID,
        secretAccessKey: env.SECRET_ACCESS_KEY,
      },
    }),
    env.BUCKET,
  );
  try {
    await archive.retain(directory);
  } catch {
    throw new Error(
      "Web asset retention failed; refusing to serve an unarchived build",
    );
  }
  return archive;
}
