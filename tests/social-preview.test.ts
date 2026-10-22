import { beforeAll, expect, test } from "bun:test";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { env } from "../richtfest-os/apps/api/src/env";
import { createApp } from "../richtfest-os/apps/api/src/server";

beforeAll(async () => {
  await Bun.$`bun run --filter @richtfest/web build`.quiet();
}, 60_000);

test("unauthenticated crawlers receive generic previews and public video and poster assets on every app link", async () => {
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
    for (const [path, userAgent] of [
      ["/", "WhatsApp/2.22.20.72 A"],
      ["/login", "WhatsApp/2.22.19.78 I"],
      ["/index.html", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"],
      ["/projects/private-project?token=private-token", "facebookexternalhit/1.1"],
    ]) {
      const response = await fetch(base + path, { headers: { ...headers, "user-agent": userAgent } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const html = (await response.text()).replace(/\s+/g, " ");
      expect(html.indexOf("</head>")).toBeLessThan(300_000);
      expect(html).toContain(`name="richtfest-build" content="${version}"`);
      expect(html).toContain(
        'property="og:title" content="Richtfest — Construction planning. Connected."',
      );
      expect(html).toContain(
        'property="og:url" content="https://planning.example.test/"',
      );
      expect(html).toContain(
        'property="og:image" content="https://planning.example.test/optimization-preview-v1-poster.jpg"',
      );
      expect(html).toContain(
        'property="og:video" content="https://planning.example.test/optimization-preview-v1.mp4"',
      );
      expect(html).toContain(
        'property="og:video:secure_url" content="https://planning.example.test/optimization-preview-v1.mp4"',
      );
      expect(html).toContain('property="og:video:type" content="video/mp4"');
      expect(html).toContain('property="og:video:width" content="1200"');
      expect(html).toContain('property="og:video:height" content="630"');
      expect(html).toContain(
        'name="twitter:card" content="summary_large_image"',
      );
      expect(html).toContain(
        'name="twitter:image" content="https://planning.example.test/optimization-preview-v1-poster.jpg"',
      );
      expect(html).not.toContain("__PUBLIC_ORIGIN__");
      expect(html).not.toContain("untrusted.example.test");
      expect(html).not.toContain("private-project");
      expect(html).not.toContain("private-token");
    }
    const image = await fetch(base + "/optimization-preview-v1-poster.jpg", { headers });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toContain("image/jpeg");
    const bytes = new Uint8Array(await image.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(bytes.length).toBeGreaterThan(10_000);
    expect(bytes.length).toBeLessThan(600_000);
    const video = await fetch(base + "/optimization-preview-v1.mp4", { headers });
    expect(video.status).toBe(200);
    expect(video.headers.get("content-type")).toContain("video/mp4");
    expect(video.headers.get("accept-ranges")).toBe("bytes");
    const videoBytes = new Uint8Array(await video.arrayBuffer());
    expect(new TextDecoder().decode(videoBytes.slice(4, 8))).toBe("ftyp");
    expect(videoBytes.length).toBeGreaterThan(1_000_000);
    expect(videoBytes.length + bytes.length).toBeLessThan(10_000_000);
    const range = await fetch(base + "/optimization-preview-v1.mp4", {
      headers: { ...headers, range: "bytes=0-63" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(`bytes 0-63/${videoBytes.length}`);
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(videoBytes.slice(0, 64));
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

test("marketing domains and the landing preview redirect to the app while the landing page is offline", async () => {
  const previousNodeEnv = env.NODE_ENV;
  const { db, pool } = createDatabase("postgresql://unused:unused@localhost:1/unused");
  let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
  try {
    env.NODE_ENV = "production";
    server = createApp(db).listen(0);
    env.NODE_ENV = previousNodeEnv;
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const host of ["richtfest.ai", "richtfest.si", "www.richtfest.si", "richtfest.andreaswissel.com"]) {
      const page = await fetch(base + "/img/cta-richtfest.webp?ref=x", { headers: { host }, redirect: "manual" });
      expect(page.status).toBe(302);
      expect(page.headers.get("location")).toBe("https://app.richtfest.ai/img/cta-richtfest.webp?ref=x");
    }
    const preview = await fetch(base + "/landing/", { headers: { host: "app.richtfest.ai" }, redirect: "manual" });
    expect(preview.status).toBe(302);
    expect(preview.headers.get("location")).toBe("/");
    const appPage = await fetch(base + "/", { headers: { host: "app.richtfest.ai" } });
    expect(await appPage.text()).toContain('name="richtfest-build"');
  } finally {
    env.NODE_ENV = previousNodeEnv;
    server?.close();
    await pool.end();
  }
});
