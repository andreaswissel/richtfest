import { expect, test } from "bun:test";
import { Pool } from "pg";
import { createMastraStorage, createSupervisorWorkflowRuntime, MASTRA_SCHEMA } from "./mastra-workflow";

// Opt in only to an explicitly provisioned disposable database. Never initialize/drop schemas here.
const connectionString = process.env.MASTRA_TEST_DATABASE_URL;
const databaseTest = connectionString ? test : test.skip;
databaseTest("Postgres recovers a failed phase in a fresh runtime, fences generations and skips success", async () => {
  const runId = crypto.randomUUID();
  const firstStore = createMastraStorage(connectionString!);
  const first = createSupervisorWorkflowRuntime({ storage: firstStore, advance: async () => { throw new Error("sk-upstream-private"); } });
  expect((await first.execute(runId)).status).toBe("failed");
  await firstStore.close();

  const secondStore = createMastraStorage(connectionString!);
  const calls: string[] = [];
  const second = createSupervisorWorkflowRuntime({ storage: secondStore, advance: async id => { calls.push(id); return { done: true }; } });
  try {
    const snapshot = await second.workflow.getWorkflowRunById(runId);
    expect(snapshot?.status).toBe("failed");
    expect(JSON.stringify(snapshot)).not.toContain("sk-upstream");
    expect((await second.execute(runId)).status).toBe("success");
    await second.execute(runId);
    expect(calls).toEqual([runId]);
    expect((await second.execute(runId, 1)).status).toBe("success");
    expect(calls).toEqual([runId, runId]);
    expect((await second.workflow.getWorkflowRunById(`${runId}:1`))?.status).toBe("success");
  } finally { await secondStore.close(); }
}, 20000);

databaseTest("Postgres runtime migration works without pgvector", async () => {
  const pool = new Pool({ connectionString });
  try {
    const result = await pool.query("select extname from pg_extension where extname = 'vector'");
    expect(result.rows).toEqual([]);
    const table = await pool.query("select table_name from information_schema.tables where table_schema=$1 and table_name='mastra_workflow_snapshot'", [MASTRA_SCHEMA]);
    expect(table.rows).toHaveLength(1);
  } finally { await pool.end(); }
});

databaseTest("Postgres resumes a running checkpoint after its worker process exits", async () => {
  const runId = crypto.randomUUID();
  const modulePath = new URL("./mastra-workflow.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "-e", `
    import { createMastraStorage, createSupervisorWorkflowRuntime } from ${JSON.stringify(modulePath)};
    const runtime = createSupervisorWorkflowRuntime({
      storage: createMastraStorage(process.env.MASTRA_TEST_DATABASE_URL),
      advance: async () => { process.exit(0); }
    });
    await runtime.execute(${JSON.stringify(runId)});
  `], { stdout: "pipe", stderr: "pipe", env: process.env });
  expect(await child.exited).toBe(0);
  const store = createMastraStorage(connectionString!);
  let calls = 0;
  const recovered = createSupervisorWorkflowRuntime({ storage: store, advance: async () => { calls++; return { done: true }; } });
  try {
    expect((await recovered.workflow.getWorkflowRunById(runId))?.status).toBe("running");
    expect((await recovered.execute(runId)).status).toBe("success");
    expect(calls).toBe(1);
  } finally { await store.close(); }
}, 20000);
