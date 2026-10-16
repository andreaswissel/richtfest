import { afterEach, expect, test } from "bun:test";
import express from "express";
import { once } from "node:events";
import { Readable } from "node:stream";
import { createRouter } from "./router";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const fileId = "33333333-3333-4333-8333-333333333333";
let server: ReturnType<express.Express["listen"]> | undefined;

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

test("inline source rendering streams through the authorized app origin while downloads keep their redirect", async () => {
  let reads = 0;
  let downloads = 0;
  const row = {
    file: { id: fileId, projectId, tenantId, name: "Plan.pdf" },
    version: { id: "44444444-4444-4444-8444-444444444444", fileId, tenantId, version: 1, status: "ready", storageKey: `${tenantId}/${projectId}/${fileId}/44444444-4444-4444-8444-444444444444`, mimeType: "application/pdf" },
  };
  const query = {
    from() { return this; },
    innerJoin() { return this; },
    where() { return this; },
    orderBy() { return this; },
    limit: async () => [row],
  };
  const app = express();
  app.use(createRouter(() => ({
    db: { select: () => query },
    tenantId,
    actorId: "55555555-5555-4555-8555-555555555555",
    requirePermission: () => undefined,
    fileStorage: {
      read: async (_key: string, signal?: AbortSignal) => { reads += 1; expect(signal).toBeInstanceOf(AbortSignal); return Readable.from([Buffer.from("%PDF-test")]); },
      download: async () => { downloads += 1; return { redirectUrl: "https://bucket.invalid/signed-plan" }; },
    },
  }) as any));
  server = app.listen(41_000 + Math.floor(Math.random() * 10_000), "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}/projects/${projectId}/files/${fileId}/versions/1/download`;

  const inline = await fetch(`${base}?inline=1`);
  expect(inline.status).toBe(200);
  expect(inline.headers.get("content-type")).toContain("application/pdf");
  expect(inline.headers.get("cache-control")).toBe("private, no-store");
  expect(inline.headers.get("content-disposition")).toBe("inline");
  expect(await inline.text()).toBe("%PDF-test");
  expect(reads).toBe(1);
  expect(downloads).toBe(0);

  const download = await fetch(base, { redirect: "manual" });
  expect(download.status).toBe(302);
  expect(download.headers.get("location")).toBe("https://bucket.invalid/signed-plan");
  expect(downloads).toBe(1);
});

test("inline source rendering rejects active non-PDF content on the app origin", async () => {
  const row = {
    file: { id: fileId, projectId, tenantId, name: "Unsafe.svg" },
    version: { id: "44444444-4444-4444-8444-444444444444", fileId, tenantId, version: 1, status: "ready", storageKey: `${tenantId}/${projectId}/${fileId}/44444444-4444-4444-8444-444444444444`, mimeType: "image/svg+xml" },
  };
  const query = { from() { return this; }, innerJoin() { return this; }, where() { return this; }, orderBy() { return this; }, limit: async () => [row] };
  const app = express();
  app.use(createRouter(() => ({
    db: { select: () => query }, tenantId, actorId: "55555555-5555-4555-8555-555555555555", requirePermission: () => undefined,
    fileStorage: { read: async () => { throw new Error("must not read"); }, download: async () => null },
  }) as any));
  server = app.listen(41_000 + Math.floor(Math.random() * 10_000), "127.0.0.1");
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/projects/${projectId}/files/${fileId}/versions/1/download?inline=1`);
  expect(response.status).toBe(415);
  expect((await response.json()).error.code).toBe("unsupported_media_type");
});

test("inline source rendering closes a failed upstream stream without falling back to a redirect", async () => {
  let downloads = 0;
  const row = {
    file: { id: fileId, projectId, tenantId, name: "Plan.pdf" },
    version: { id: "44444444-4444-4444-8444-444444444444", fileId, tenantId, version: 1, status: "ready", storageKey: `${tenantId}/${projectId}/${fileId}/44444444-4444-4444-8444-444444444444`, mimeType: "application/pdf" },
  };
  const query = { from() { return this; }, innerJoin() { return this; }, where() { return this; }, orderBy() { return this; }, limit: async () => [row] };
  const app = express();
  app.use(createRouter(() => ({
    db: { select: () => query }, tenantId, actorId: "55555555-5555-4555-8555-555555555555", requirePermission: () => undefined,
    fileStorage: {
      read: async () => (async function* () { yield Buffer.from("%PDF-"); throw new Error("bucket stream failed"); })(),
      download: async () => { downloads += 1; return { redirectUrl: "https://bucket.invalid/signed-plan" }; },
    },
  }) as any));
  server = app.listen(41_000 + Math.floor(Math.random() * 10_000), "127.0.0.1");
  await once(server, "listening");
  let failed = false;
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/projects/${projectId}/files/${fileId}/versions/1/download?inline=1`);
    await response.arrayBuffer();
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
  expect(downloads).toBe(0);
});
