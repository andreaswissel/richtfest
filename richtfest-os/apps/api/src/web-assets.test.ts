import { expect, test } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import express from "express";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { retainWebAssets, WebAssetArchive } from "./web-assets";
import { env } from "./env";

test("archived build files survive replacement without exposing private objects or caching failures", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "richtfest-assets-"));
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  let unavailable = false;
  const storage = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (unavailable)
        return new Response("<Error><Code>AccessDenied</Code></Error>", {
          status: 403,
        });
      const key = new URL(req.url).pathname;
      if (req.method === "PUT") {
        objects.set(key, new Uint8Array(await req.arrayBuffer()));
        return new Response(null);
      }
      const bytes = objects.get(key);
      if (!bytes)
        return new Response("<Error><Code>NoSuchKey</Code></Error>", {
          status: 404,
        });
      return new Response(req.method === "HEAD" ? null : bytes, {
        headers: {
          "Content-Length": String(bytes.length),
          "Content-Type": "application/octet-stream",
        },
      });
    },
  });
  const client = new S3Client({
    endpoint: storage.url.href,
    region: "test",
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId: "local-test", secretAccessKey: "local-test" },
  });
  const archive = new WebAssetArchive(client, "test-bucket");
  const app = express();
  app.use("/assets", archive.serve);
  app.use((_req, res) =>
    res.status(404).set("Cache-Control", "no-store").end(),
  );
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/assets/`;
  try {
    const oldJs = "export const build = 'old';";
    await writeFile(path.join(directory, "auth-client-old00001.js"), oldJs);
    await writeFile(
      path.join(directory, "theme-old00001.css"),
      "body { color: red; }",
    );
    await writeFile(
      path.join(directory, "font-old00001.woff2"),
      new Uint8Array([0, 255, 128, 1]),
    );
    await writeFile(
      path.join(directory, "auth-client-old00001.js.map"),
      "private source map",
    );
    await writeFile(
      path.join(directory, "index.html"),
      "old HTML must not be archived",
    );
    await archive.retain(directory);
    // A different instance/container retains B in the same bucket; A is gone locally.
    await rm(path.join(directory, "auth-client-old00001.js"));
    await writeFile(
      path.join(directory, "auth-client-new00002.js"),
      "export const build = 'new';",
    );
    const replacement = new WebAssetArchive(client, "test-bucket");
    await replacement.retain(directory);
    await replacement.retain(directory);

    const old = await fetch(base + "auth-client-old00001.js");
    expect(old.status).toBe(200);
    expect(await old.text()).toBe(oldJs);
    expect(old.headers.get("content-type")).toContain("javascript");
    expect(old.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(old.headers.get("x-content-type-options")).toBe("nosniff");
    const current = await fetch(base + "auth-client-new00002.js");
    expect(await current.text()).toBe("export const build = 'new';");
    const head = await fetch(base + "auth-client-old00001.js", {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(oldJs.length));
    expect(await head.text()).toBe("");
    const css = await fetch(base + "theme-old00001.css");
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toBe("body { color: red; }");
    expect([
      ...new Uint8Array(
        await (await fetch(base + "font-old00001.woff2")).arrayBuffer(),
      ),
    ]).toEqual([0, 255, 128, 1]);

    objects.set(
      "/test-bucket/customer/private-old00001.js",
      new TextEncoder().encode("private customer data"),
    );
    for (const name of [
      "absent-old00001.js",
      "auth-client-old00001.js.map",
      "index.html",
      "private-old00001.js",
      "%2e%2e%2fcustomer%2fprivate-old00001.js",
      "customer/private-old00001.js",
    ]) {
      const response = await fetch(base + name);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
    }
    expect(
      (await fetch(base + "auth-client-old00001.js", { method: "POST" }))
        .status,
    ).toBe(404);

    unavailable = true;
    const outage = await fetch(base + "auth-client-old00001.js");
    expect(outage.status).toBe(503);
    expect(outage.headers.get("cache-control")).toBe("no-store");
    expect(await outage.text()).toBe("");
    // A storage error must not be mistaken for a missing object and overwritten.
    await expect(replacement.retain(directory)).rejects.toThrow();
    unavailable = false;
    expect(await (await fetch(base + "auth-client-old00001.js")).text()).toBe(
      oldJs,
    );

    // Exercise the production bootstrap, with every storage setting explicitly
    // pointed at this loopback fixture rather than inherited credentials.
    const previous = {
      BUCKET: env.BUCKET,
      ENDPOINT: env.ENDPOINT,
      REGION: env.REGION,
      ACCESS_KEY_ID: env.ACCESS_KEY_ID,
      SECRET_ACCESS_KEY: env.SECRET_ACCESS_KEY,
    };
    try {
      Object.assign(env, {
        BUCKET: "test-bucket",
        ENDPOINT: storage.url.href,
        REGION: "test",
        ACCESS_KEY_ID: "local-test",
        SECRET_ACCESS_KEY: "local-test",
      });
      await retainWebAssets(directory);
      unavailable = true;
      await expect(retainWebAssets(directory)).rejects.toThrow(
        "refusing to serve an unarchived build",
      );
      env.BUCKET = undefined;
      await expect(retainWebAssets(directory)).rejects.toThrow(
        "requires the configured Railway Bucket",
      );
    } finally {
      Object.assign(env, previous);
    }
  } finally {
    server.closeAllConnections();
    server.close();
    client.destroy();
    await storage.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
