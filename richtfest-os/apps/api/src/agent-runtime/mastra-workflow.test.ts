import { expect, test } from "bun:test";
import { InMemoryStore } from "@mastra/core/storage";
import { createSupervisorWorkflowRuntime } from "./mastra-workflow";

test("Mastra controls phase progression and stores safe checkpoints", async () => {
  const runId = crypto.randomUUID();
  const calls: string[] = [];
  const runtime = createSupervisorWorkflowRuntime({
    storage: new InMemoryStore(),
    advance: async (id) => { calls.push(id); return { done: calls.length === 3 }; },
  });
  const result = await runtime.execute(runId);
  expect(result.status).toBe("success");
  expect(calls).toEqual([runId, runId, runId]);
  const snapshot = await runtime.workflow.getWorkflowRunById(runId);
  expect(snapshot?.status).toBe("success");
  expect(JSON.stringify(snapshot)).not.toContain("apiKey");
});

test("framework restart resumes a failed phase without exposing upstream errors", async () => {
  const runId = crypto.randomUUID();
  let attempt = 0;
  const runtime = createSupervisorWorkflowRuntime({ storage: new InMemoryStore(), advance: async () => {
    attempt++;
    if (attempt === 1) throw new Error("sk-private-upstream-error");
    return { done: true };
  } });
  expect((await runtime.execute(runId)).status).toBe("failed");
  expect(JSON.stringify(await runtime.workflow.getWorkflowRunById(runId))).not.toContain("sk-private");
  expect((await runtime.execute(runId)).status).toBe("success");
  expect(attempt).toBe(2);
  await runtime.execute(runId);
  expect(attempt).toBe(2);
});

test("steering generation creates a separate workflow while retaining the domain run", async () => {
  const runId = crypto.randomUUID();
  const calls: string[] = [];
  const runtime = createSupervisorWorkflowRuntime({ storage: new InMemoryStore(), advance: async id => {
    calls.push(id); return { done: true };
  } });
  await runtime.execute(runId);
  await runtime.execute(runId, 1);
  expect(calls).toEqual([runId, runId]);
  expect((await runtime.workflow.getWorkflowRunById(`${runId}:1`))?.status).toBe("success");
});
