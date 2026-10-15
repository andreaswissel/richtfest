import { beforeAll, expect, test } from "bun:test";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { env } from "../richtfest-os/apps/api/src/env";
import { createApp } from "../richtfest-os/apps/api/src/server";

beforeAll(async () => {
  await Bun.$`bun run --filter @richtfest/web build`.quiet();
}, 60_000);

test("unauthenticated crawlers receive generic previews and a public image on every app link", async () => {
  const previous = {
    NODE_ENV: env.NODE_ENV,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
  };
  const { db, pool } = createDatabase(
    "postgresql://unused:unused@localhost:1/unused",
  );
  let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
  try {
    env.NODE_ENV = "production";
    env.BETTER_AUTH_URL = "https://planning.example.test/";
    server = createApp(db).listen(0);
    Object.assign(env, previous);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = {
      "user-agent": "facebookexternalhit/1.1",
      host: "untrusted.example.test",
    };
    const versionResponse = await fetch(base + "/version.json", { headers });
    expect(versionResponse.status).toBe(200);
    expect(versionResponse.headers.get("cache-control")).toBe("no-store");
    const { version } = await versionResponse.json();
    expect(version).toMatch(/^[a-f0-9]{64}$/);
    for (const path of [
      "/",
      "/login",
      "/index.html",
      "/projects/private-project?token=private-token",
    ]) {
      const response = await fetch(base + path, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const html = (await response.text()).replace(/\s+/g, " ");
      expect(html).toContain(`name="richtfest-build" content="${version}"`);
      expect(html).toContain(
        'property="og:title" content="Richtfest — Construction planning. Connected."',
      );
      expect(html).toContain(
        'property="og:url" content="https://planning.example.test/"',
      );
      expect(html).toContain(
        'property="og:image" content="https://planning.example.test/social-preview-v1.jpg"',
      );
      expect(html).toContain(
        'name="twitter:card" content="summary_large_image"',
      );
      expect(html).toContain(
        'name="twitter:image" content="https://planning.example.test/social-preview-v1.jpg"',
      );
      expect(html).not.toContain("__PUBLIC_ORIGIN__");
      expect(html).not.toContain("untrusted.example.test");
      expect(html).not.toContain("private-project");
      expect(html).not.toContain("private-token");
    }
    const image = await fetch(base + "/social-preview-v1.jpg", { headers });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toContain("image/jpeg");
    const bytes = new Uint8Array(await image.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(bytes.length).toBeGreaterThan(10_000);
    const manifest = await Bun.file(
      new URL(
        "../richtfest-os/apps/web/dist/.vite/manifest.json",
        import.meta.url,
      ),
    ).json();
    const currentChunk = await fetch(
      base + "/" + manifest["src/lib/auth-client.ts"].file,
    );
    expect(currentChunk.status).toBe(200);
    expect(currentChunk.headers.get("content-type")).toContain("javascript");
    expect(currentChunk.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const missingChunk = await fetch(
      base + "/assets/auth-client-old-deployment.js",
    );
    expect(missingChunk.status).toBe(404);
    expect(missingChunk.headers.get("cache-control")).toBe("no-store");
    expect(missingChunk.headers.get("content-type") ?? "").not.toContain(
      "text/html",
    );
  } finally {
    Object.assign(env, previous);
    server?.close();
    await pool.end();
  }
});

test("marketing domains and the landing preview serve the page's relative image URLs", async () => {
  const previousNodeEnv = env.NODE_ENV;
  const { db, pool } = createDatabase("postgresql://unused:unused@localhost:1/unused");
  let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
  try {
    env.NODE_ENV = "production";
    server = createApp(db).listen(0);
    env.NODE_ENV = previousNodeEnv;
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const landingHtml = await Bun.file(new URL("../richtfest-landing/index.html", import.meta.url)).text();
    for (const [host, prefix] of [
      ["richtfest.ai", "/"],
      ["richtfest.si", "/"],
      ["www.richtfest.si", "/"],
      ["richtfest.andreaswissel.com", "/"],
      ["app.richtfest.ai", "/landing/"],
    ]) {
      const headers = { host: host! };
      const page = await fetch(base + prefix, { headers });
      expect(page.status).toBe(200);
      expect(await page.text()).toBe(landingHtml);
      for (const name of [
        "aud-developers", "aud-architects", "aud-contractors", "aud-authorities",
        "wf-feasibility", "wf-variants", "wf-physics", "wf-cost", "cta-richtfest",
      ]) {
        const image = await fetch(`${base}${prefix}img/${name}.webp`, { headers });
        expect(image.status).toBe(200);
        expect(image.headers.get("content-type")).toContain("image/webp");
        const bytes = new Uint8Array(await image.arrayBuffer());
        expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
        expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe("WEBP");
      }
      for (const [file, type] of [["favicon.svg", "image/svg+xml"], ["og-image.png", "image/png"]]) {
        const image = await fetch(`${base}${prefix}${file}`, { headers });
        expect(image.status).toBe(200);
        expect(image.headers.get("content-type")).toContain(type!);
      }
    }
    const appPage = await fetch(base + "/", { headers: { host: "app.richtfest.ai" } });
    expect(await appPage.text()).toContain('name="richtfest-build"');
  } finally {
    env.NODE_ENV = previousNodeEnv;
    server?.close();
    await pool.end();
  }
});
