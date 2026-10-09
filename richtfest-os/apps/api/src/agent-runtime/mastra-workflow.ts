import { Mastra } from "@mastra/core/mastra";
import { noopLogger } from "@mastra/core/logger";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { PostgresStore, exportSchemas } from "@mastra/pg";
import { z } from "zod";

export const MASTRA_SCHEMA = "richtfest_agent_runtime";
/** Explicit migration/setup only. Runtime always uses disableInit. */
export const mastraMigrationSql = () => exportSchemas(MASTRA_SCHEMA);
export function createMastraStorage(connectionString: string) {
  return new PostgresStore({ id: "richtfest-agent-runtime", connectionString, schemaName: MASTRA_SCHEMA, disableInit: true });
}
const checkpoint = z.object({ runId: z.string().uuid(), done: z.boolean(), iteration: z.number().int().nonnegative() });
/** The framework stores checkpoints; app callbacks enforce tenancy, leases and review gates. */
export function createSupervisorWorkflowRuntime(input: {
  storage: MastraCompositeStore;
  advance: (runId: string) => Promise<{ done: boolean }>;
}) {
  const advance = createStep({
    id: "advance-supervisor-phase",
    inputSchema: checkpoint,
    outputSchema: checkpoint,
    execute: async ({ inputData }) => {
      if (inputData.iteration >= 100) throw new Error("Supervisor workflow iteration budget exhausted");
      // Only IDs and control state reach framework storage. No source excerpts, keys or model output.
      try {
        const result = await input.advance(inputData.runId);
        return { runId: inputData.runId, done: result.done, iteration: inputData.iteration + 1 };
      } catch {
        throw new Error("Supervisor phase failed; inspect the authorized application run record");
      }
    },
  });
  const workflow = createWorkflow({
    id: "richtfest-project-supervisor-v1",
    inputSchema: checkpoint,
    outputSchema: checkpoint,
    options: { shouldPersistSnapshot: () => true, autoRestartActiveRuns: false },
  }).dountil(advance, async ({ inputData }) => inputData.done).commit();
  const mastra = new Mastra({ workflows: { supervisor: workflow }, storage: input.storage, logger: noopLogger });
  return {
    mastra,
    workflow,
    async execute(runId: string, generation = 0) {
      const workflowRunId = generation === 0 ? runId : `${runId}:${generation}`;
      const existing = await workflow.getWorkflowRunById(workflowRunId);
      if (existing?.status === "success") return existing;
      const run = await workflow.createRun({ runId: workflowRunId });
      if (existing?.status === "failed") return run.timeTravel({ step: "advance-supervisor-phase" });
      return existing ? run.restart() : run.start({ inputData: { runId, done: false, iteration: 0 } });
    },
  };
}
