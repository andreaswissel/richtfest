import { expect, test } from "bun:test";

test("demo seed refuses production, remote databases, host overrides and bucket storage before seeding", () => {
  for (const overrides of [
    { NODE_ENV: "production" },
    { DATABASE_URL: "postgresql://demo:demo@database.invalid:5432/demo" },
    { DATABASE_URL: "postgresql://demo:demo@localhost:5432/demo?host=database.invalid" },
    { BUCKET: "do-not-write" },
  ]) {
    const result = Bun.spawnSync(["bun", "scripts/seed-agent-demo.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, NODE_ENV: "development", DATABASE_URL: "postgresql://demo:demo@127.0.0.1:1/demo",
        BUCKET: undefined, ENDPOINT: undefined, PGHOSTADDR: undefined, ...overrides },
      timeout: 10000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Demo seed requires");
    expect(result.stdout.toString()).not.toContain("Alpha");
    expect(result.stdout.toString()).not.toContain("Seeded DEMO");
  }
});
