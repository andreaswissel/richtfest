import { expect, spyOn, test } from "bun:test";
import { createMockModel, MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { callMastraSupervisor, supervisorSchemas } from "./mastra-supervisor";
import { assertDocumentCitations, createSupervisor, stepSupervisor, supervisorReview } from "../../../../../richtfest-apps/knowledge/src/supervisor";
import { sanitizeProviderDiagnostics } from "@richtfest/knowledge/deps";
import type { AppDeps } from "@richtfest/knowledge/deps";
import { agentRuns, agentRunAttempts, agentRunEvents, agentRunUsage, supervisorRuns, tasks } from "@richtfest/knowledge/schema";
import { eq } from "drizzle-orm";
import { createDatabase } from "../db/client";
import { agentPresetSnapshotSchema, domainSpecialistRoles } from "@richtfest/shared";
import { vendorPreset } from "../agent-presets";
import { acousticConceptFixture } from "../../../../../tests/fixtures/acoustic-concepts";

const base = { provider: "openai" as const, runId: crypto.randomUUID(), goal: "Review evidence", context: {} };
test("sound-insulation synthesis requires the fixed template and renders rather than trusting free-form content", async () => {
  const versionId = crypto.randomUUID();
  const template = {
    id: "sound-insulation-review", version: 1, language: "de",
    scope: "Außenlärmschutz für Raum 101.", sourcesAndRevisions: `Modellstand [${versionId}].`,
    requirements: "Außenlärmpegel fehlt.",
    entities: [{ kind: "room", label: "Raum 101", versionId, entityKey: "#42", page: null,
      globalId: "1AbCdEfGhIjKlMnOpQrStu", observations: "Deklarierter Raum, Zuordnung ungeprüft." }],
    findings: "Keine Schallschutzwerte belegt.", measures: "Fensterdaten anfordern.", openIssues: "Fachliche Prüfung erforderlich.",
  };
  const review = { summary: "Entwurf erstellt.", rationale: "Quellenbezug", citations: [versionId], decision: "accept", revisions: [],
    document: { title: "Schallschutzprüfung", content: "IGNORE THIS FREE-FORM DOCUMENT", template } };
  const request = { ...base, phase: "review" as const, context: { documentTemplate: { id: "sound-insulation-review", version: 1 } } };
  const result: any = await callMastraSupervisor(request, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: review }),
  });
  expect(result.document.content).not.toContain("IGNORE THIS");
  expect(result.document.content).toContain("## 1. Auftrag und Umfang");
  expect(result.document.content).toContain("## 8. Prüfstatus");
  expect(result.document.content).toContain("keine Berechnung durchgeführt");
  expect(result.document.content).toContain("1AbCdEfGhIjKlMnOpQrStu");
  expect(result.document.template).toEqual(template);
  expect(() => assertDocumentCitations(result.document, [])).toThrow("undeclared");
  assertDocumentCitations(result.document, [versionId]);
  const largeTemplate = { ...template, entities: Array.from({ length: 65 }, () => ({ ...template.entities[0], observations: "x".repeat(1000) })) };
  const largeReview = { ...review, document: { ...review.document, template: largeTemplate } };
  for (const documentMaxCharacters of [1000, 120000]) {
    const modelPolicy = { ...responsePolicy, executionLimits: { ...responsePolicy.executionLimits, documentMaxCharacters } };
    const response = callMastraSupervisor({ ...request, modelPolicy }, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: largeReview }),
    });
    if (documentMaxCharacters === 1000) await expect(response).rejects.toMatchObject({ code: "invalid_provider_output" });
    else {
      const output = await response as typeof result;
      expect(output.document.content.length).toBeGreaterThan(60000);
      expect(output.document.content).toContain("## 8. Prüfstatus");
    }
  }
  for (const invalid of [undefined, { ...template, version: 2 }, { ...template, requirements: "" }]) {
    await expect(callMastraSupervisor(request, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: { ...review, document: { ...review.document, template: invalid } } }),
    })).rejects.toMatchObject({ code: "invalid_provider_output" });
  }
});

for (const id of ["interior-noise-concept", "exterior-noise-concept"] as const) {
  for (const language of ["de", "en"] as const) test(`${id} ${language} survives provider validation with fixed structure, tables and draft limits`, async () => {
    const versionId = crypto.randomUUID();
    const template = acousticConceptFixture(id, language, versionId);
    const review = { summary: "Draft ready", rationale: "Evidence gaps retained", citations: [versionId], decision: "accept", revisions: [],
      document: { title: "Concept", content: "MODEL CONTENT MUST NOT WIN", template } };
    const request = { ...base, phase: "review" as const, goal: `Create ${id}`, context: { documentTemplate: { id: "sound-insulation-review", version: 1 } } };
    const result: any = await callMastraSupervisor(request, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: review }),
    });
    expect(result.document.template).toEqual(template);
    expect(result.document.content).not.toContain("MODEL CONTENT MUST NOT WIN");
    expect(result.document.content).toContain(template.components);
    expect(result.document.content).toContain(language === "de" ? "| Bauherr | Nicht angegeben |" : "| Client | Not supplied |");
    expect(result.document.content).toContain(language === "de" ? "Es wurde keine Berechnung durchgeführt." : "No calculation was performed.");
    expect(result.document.content).toContain(language === "de" ? "## Anlage · Berechnungsnachweise" : "## Appendix · Calculation evidence");
    expect(result.document.content).toContain(language === "de" ? "Keine Freigabe, Unterschrift" : "Not approved, signed");
    if (id === "interior-noise-concept") {
      expect(result.document.content).toContain(language === "de" ? "## 3. Schallschutzpläne Innenlärm" : "## 3. Interior-noise plans");
      expect(result.document.content).toContain(language === "de" ? "## 7. Luft-Wasser-Wärmepumpe" : "## 7. Air-to-water heat pump");
      expect(result.document.content).not.toContain("Exterior-noise assessment");
    } else {
      expect(result.document.content).toContain(language === "de" ? "## 2. Bewertung des Außenlärms" : "## 2. Exterior-noise assessment");
      expect(result.document.content).toContain(language === "de" ? "## 5. Schallschutzpläne Außenlärm" : "## 5. Exterior-noise plans");
      expect(result.document.content).not.toContain("DEGA");
    }
    assertDocumentCitations(result.document, [versionId]);
    expect(() => assertDocumentCitations(result.document, [])).toThrow("undeclared");
    await expect(callMastraSupervisor({ ...request, modelPolicy: {
      ...responsePolicy, executionLimits: { ...responsePolicy.executionLimits, documentMaxCharacters: 1000 },
    } }, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: review }),
    })).rejects.toMatchObject({ code: "invalid_provider_output" });
    for (const invalid of [{ ...template, version: 2 }, { ...template, plans: "" }]) {
      await expect(callMastraSupervisor(request, "test-key", {
        model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: { ...review, document: { ...review.document, template: invalid } } }),
      })).rejects.toMatchObject({ code: "invalid_provider_output" });
    }
  });
}

test("domain specialists select their snapshotted models and cannot execute or be planned when disabled", async () => {
  const legacy = agentPresetSnapshotSchema.parse({ ...vendorPreset("openai", "medium"), effort: "medium", provider: "openai", version: 1, source: "workspace" });
  for (const role of domainSpecialistRoles) {
    const output = { summary: "Evidence reviewed", rationale: "Source proposal", citations: [] };
    const model = { modelId: `${role}-model`, maxOutputTokens: 777, maxSteps: 1 };
    const policy = agentPresetSnapshotSchema.parse({ ...legacy, specialists: { ...legacy.specialists, [role]: model } });
    let metadata: any;
    let request: any;
    await callMastraSupervisor({ ...base, phase: "specialist", context: { role }, modelPolicy: policy, onRequest: async value => { metadata = value; } }, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output, spyStream: value => { request = value; } }),
    });
    expect(metadata.modelId).toBe(model.modelId);
    expect(request.maxOutputTokens).toBe(777);
    expect(JSON.stringify(request)).toContain("never calculates or claims IFC semantic completeness");
    expect(JSON.stringify(request)).toContain("never gives binding legal approval");
    expect(JSON.stringify(request)).toContain("never invents prices");
    await expect(callMastraSupervisor({ ...base, phase: "specialist", context: { role }, modelPolicy: legacy, modelConfig: model }, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output }),
    })).rejects.toThrow("disabled");
    const plan = { tasks: [{ role, goal: "Review domain evidence", sourceVersionIds: [] }] };
    expect(await callMastraSupervisor({ ...base, phase: "plan", modelPolicy: policy }, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: plan }),
    })).toEqual(plan);
    await expect(callMastraSupervisor({ ...base, phase: "plan", modelPolicy: legacy }, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: plan }),
    })).rejects.toMatchObject({ code: "invalid_provider_output" });
  }
});

test("phase deadlines abort real Mastra streams without accepting partial output or leaking contents", async () => {
  for (const phase of ["plan", "specialist", "review", "independent_review"] as const) {
    for (const cancelled of [false, true]) {
      const deadline = new AbortController();
      const cancellation = new AbortController();
      const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => deadline.signal);
      const secret = "sk-timeout-secret";
      const privateGoal = "Private project prompt";
      let settings: any;
      let upstreamAborted = false;
      let accepted = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deltas: string[] = [];
      try {
        const model = new MastraLanguageModelV2Mock({ doStream: async ({ abortSignal }) => ({
          stream: new ReadableStream({ start(controller) {
            controller.enqueue({ type: "text-start", id: "output" });
            controller.enqueue({ type: "text-delta", id: "output", delta: phase === "plan"
              ? '{"tasks":[{"role":"source_reviewer","goal":"unfinished'
              : JSON.stringify({ summary: `Evidence ${secret} remains incomplete`, rationale: privateGoal, citations: [] }).slice(0, -1) });
            abortSignal!.addEventListener("abort", () => {
              upstreamAborted = true;
              controller.error(new Error(`Bearer ${secret} ${privateGoal}`));
            }, { once: true });
            timer = setTimeout(() => (cancelled ? cancellation : deadline).abort(
              new DOMException(`${secret} ${privateGoal}`, cancelled ? "AbortError" : "TimeoutError"),
            ), 25);
          } }),
        }) });
        const error = await callMastraSupervisor({ ...base, phase, goal: privateGoal,
          onRequest: async value => { settings = value; },
          onSummaryDelta: async delta => { deltas.push(delta); },
        }, secret, { model, signal: cancellation.signal }).then(() => { accepted = true; }, error => error);
        const timeoutMs = phase === "plan" ? 60000 : 180000;
        expect(timeout).toHaveBeenCalledWith(timeoutMs);
        expect(settings.timeoutMs).toBe(timeoutMs);
        expect(upstreamAborted).toBe(true);
        expect(accepted).toBe(false);
        expect(error).toMatchObject(cancelled ? { code: "cancelled" } : {
          code: "timeout", failureCategory: "timeout", providerFailure: true, retryable: false, timedOut: true,
        });
        if (cancelled) expect(error.failureCategory).not.toBe("timeout");
        expect(error.cause).toBeUndefined();
        expect(`${error.message}${JSON.stringify(error)}${JSON.stringify(settings)}${deltas.join("")}`).not.toContain(secret);
        expect(`${error.message}${JSON.stringify(error)}${JSON.stringify(settings)}`).not.toContain(privateGoal);
      } finally {
        if (timer) clearTimeout(timer);
        timeout.mockRestore();
      }
    }
  }
});

const responsePolicy = {
  ...vendorPreset("openai", "medium"), provider: "openai" as const, effort: "medium" as const, source: "workspace" as const, version: 2,
  executionLimits: { summaryMaxCharacters: 12000, rationaleMaxCharacters: 3000, documentMaxCharacters: 70000, timeoutSeconds: 10 },
};
test("real Mastra accepts enlarged responses and rejects each configured cap", async () => {
  const review = { summary: "s".repeat(12000), rationale: "r".repeat(3000), citations: [], decision: "accept", revisions: [],
    document: { title: "Concept", content: "d".repeat(70000) } };
  const invoke = (output: typeof review) => callMastraSupervisor({ ...base, phase: "review", modelPolicy: responsePolicy }, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output }),
  });
  expect(await invoke(review)).toEqual(review);
  for (const output of [
    { ...review, summary: review.summary + "s" }, { ...review, rationale: review.rationale + "r" },
    { ...review, document: { ...review.document, content: review.document.content + "d" } },
  ]) {
    const error = await invoke(output).then(() => null, error => error);
    expect(error).toMatchObject({ code: "invalid_provider_output", failureCategory: "validation", retryable: true });
  }
});

test("configured ten-second timeout aborts real Mastra and retains timeout classification", async () => {
  let aborted = false;
  const start = performance.now();
  const model = new MastraLanguageModelV2Mock({ doStream: async ({ abortSignal }) => ({
    stream: new ReadableStream({ start(controller) {
      const abort = () => { aborted = true; controller.error(new DOMException("Timed out", "AbortError")); };
      if (abortSignal?.aborted) abort();
      else abortSignal?.addEventListener("abort", abort, { once: true });
    } }),
  }) });
  const error = await callMastraSupervisor({ ...base, phase: "specialist", context: { role: "source_reviewer" }, modelPolicy: responsePolicy }, "test-key", { model }).then(() => null, error => error);
  expect(aborted).toBe(true);
  expect(performance.now() - start).toBeGreaterThanOrEqual(9500);
  expect(performance.now() - start).toBeLessThan(15000);
  expect(error).toMatchObject({ code: "timeout", failureCategory: "timeout", timedOut: true, retryable: false });
}, 20000);

test.skipIf(!process.env.DATABASE_URL)("supervisor repairs a rejected summary through Mastra without retrying a successful sibling", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID();
  const modelConfig = { modelId: "test-model", maxSteps: 1, maxOutputTokens: 32000 };
  const policy = { provider: "openai" as const, effort: "medium" as const, source: "vendor" as const, version: 1,
    supervisor: modelConfig, specialists: { source_reviewer: modelConfig, requirements_reviewer: modelConfig }, maxParallel: 2, maxTasks: 2, maxRevisions: 1 };
  const d = {
    db, tenantId, actorId, requirePermission: () => {}, auditRun: async () => {}, validateProject: async () => true,
    listProjectSources: async () => ({ sources: [], truncated: false }),
    executeSupervisor: async (input: Parameters<NonNullable<AppDeps["executeSupervisor"]>>[0]) => {
      if (input.phase === "plan") return { status: "completed", output: { tasks: [
        { role: "requirements_reviewer", goal: "Check requirements", sourceVersionIds: [] },
        { role: "source_reviewer", goal: "Check sources", sourceVersionIds: [] },
      ] } };
      const output = await callMastraSupervisor({ ...input, modelConfig }, "test-key", {
        model: new MastraLanguageModelV2Mock({ doStream: async options => {
          const instructions = options.prompt.filter(message => message.role === "system").map(message => message.content).join("\n");
          const corrected = instructions.includes('"code":"too_big","path":["summary"],"maximum":10000')
            && instructions.includes("rewrite it concisely");
          const summary = input.goal === "Check sources" ? "Sources inspected; coverage gaps remain explicit."
            : corrected ? "Requirements identified; missing dimensions still require confirmation."
            : "Overlong requirements. ".repeat(600);
          const text = JSON.stringify({ summary, rationale: "Unreviewed proposal, not a validated calculation.", citations: [] });
          return { stream: new ReadableStream({ start(controller) {
            controller.enqueue({ type: "text-start", id: "output" });
            controller.enqueue({ type: "text-delta", id: "output", delta: text });
            controller.enqueue({ type: "text-end", id: "output" });
            controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } });
            controller.close();
          } }) };
        } }),
      });
      return { status: "completed", output };
    },
  } as unknown as AppDeps;
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), goal: "Prepare concept", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(d, db, run, "medium", policy);
    await stepSupervisor(d, run!.id);
    await stepSupervisor(d, run!.id);
    const children = await db.select().from(agentRuns).where(eq(agentRuns.parentRunId, run!.id));
    expect(children).toHaveLength(2);
    expect(children.every(child => child.status === "needs_review")).toBe(true);
    const requirements = children.find(child => child.specialistRole === "requirements_reviewer")!;
    expect(requirements.outputSummary).toBe("Requirements identified; missing dimensions still require confirmation.");
    const attempts = await db.select().from(agentRunAttempts).where(eq(agentRunAttempts.runId, requirements.id)).orderBy(agentRunAttempts.attemptNumber);
    expect(attempts.map(attempt => attempt.status)).toEqual(["failed", "completed"]);
    const [first, second] = attempts.map(attempt => attempt.settings as any);
    expect(first.promptHash).not.toBe(second.promptHash);
    expect(first.instructionsHash).not.toBe(second.instructionsHash);
    expect(first.outputSchemaHash).toBe(second.outputSchemaHash);
    expect(second.maxOutputTokens).toBe(32000);
    const source = children.find(child => child.specialistRole === "source_reviewer")!;
    expect(await db.select().from(agentRunAttempts).where(eq(agentRunAttempts.runId, source.id))).toHaveLength(1);
    const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
    expect(state!.phase).toBe("review");
  } finally {
    for (const table of [agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});
test("review document survives real Mastra while only the handoff streams", async () => {
  const versionId = crypto.randomUUID();
  const review = { summary: "The concept is ready for human review.", rationale: "Evidence checked", citations: [versionId], decision: "accept", revisions: [],
    document: { title: "Project concept", content: `# Scope\n\nSource-backed measures [${versionId}]\n\n${"Detailed proposed measure. ".repeat(500)}`.trim() } };
  const deltas: string[] = [];
  expect(await callMastraSupervisor({ ...base, phase: "review", onSummaryDelta: async delta => { deltas.push(delta); } }, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: review }),
  })).toEqual(review);
  expect(deltas.join("")).toBe(review.summary);
  const { document, ...legacy } = review;
  expect(supervisorSchemas.review.safeParse(legacy).success).toBe(false);
  expect(supervisorReview.safeParse(legacy).success).toBe(true);
  expect(supervisorReview.safeParse({ ...legacy, document: null }).success).toBe(true);
  expect(() => assertDocumentCitations(document, [versionId])).not.toThrow();
  expect(() => assertDocumentCitations(document, [])).toThrow("undeclared");
});
test("Mastra telemetry reports filtered effort and no configured-model response fallback", async () => {
  let settings: any;
  let metadata: any;
  const model = new MastraLanguageModelV2Mock({ doStream: async () => ({
    stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "text-start", id: "output" });
      controller.enqueue({ type: "text-delta", id: "output", delta: JSON.stringify({ summary: "Done", rationale: "Evidence", citations: [] }) });
      controller.enqueue({ type: "text-end", id: "output" });
      controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 20, totalTokens: 32 } });
      controller.close();
    } }),
  }) });
  await callMastraSupervisor({ ...base, phase: "specialist", modelConfig: { modelId: "o3", reasoningEffort: "xhigh", maxSteps: 1, maxOutputTokens: 900 },
    onRequest: async value => { settings = value; }, onResponse: async value => { metadata = value; },
  }, "test-key", { model });
  expect(settings).toMatchObject({ requestedReasoningEffort: "xhigh", reasoningEffort: null, maxOutputTokens: 900, maxRetries: 0, stream: true });
  expect(settings.outputSchemaHash).toMatch(/^[a-f0-9]{64}$/);
  expect(metadata.modelId).toBeNull();
});
test("real Mastra agent validates scoped specialist output and redacts transient secrets", async () => {
  const key = "sk-test-secret";
  const output = await callMastraSupervisor({ ...base, phase: "specialist" }, key, {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: ({ summary: `Evidence ${key}`, rationale: "Only assigned sources", citations: [] }) }),
  });
  expect(output).toEqual({ summary: "Evidence [redacted]", rationale: "Only assigned sources", citations: [] });
});
test("real Mastra agent rejects plans outside bounded schema", async () => {
  await expect(callMastraSupervisor({ ...base, phase: "plan" }, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: ({ tasks: [{ role: "admin", goal: "Write data", sourceVersionIds: [] }] }) }),
  })).rejects.toThrow("Supervisor model execution failed");
});
test("Mastra truncation and OpenAI schema failures remain retryable without exposing output", async () => {
  for (const failure of ["truncated", "schema", "summary_limit"] as const) {
    for (const streaming of [false, true]) {
      const secret = "sk-test-secret";
      const text = failure === "truncated" ? `{"summary":"${secret}`
        : failure === "summary_limit" ? JSON.stringify({ summary: "x".repeat(10001), rationale: secret, citations: [] })
        : JSON.stringify({ summary: secret, rationale: "Invalid citation", citations: ["not-a-uuid"] });
      const finishReason = failure === "truncated" ? "length" : "stop";
      const usage = { inputTokens: 12, outputTokens: 50, totalTokens: 62 };
      const model = new MastraLanguageModelV2Mock({
        provider: "openai",
        modelId: "gpt-4.1",
        doGenerate: async () => ({ content: [{ type: "text", text }], finishReason, usage, warnings: [], response: { id: "provider-response", modelId: "gpt-4.1-mini-snapshot" } }),
        doStream: async () => ({ stream: new ReadableStream({ start(controller) {
          controller.enqueue({ type: "response-metadata", id: "provider-response", modelId: "gpt-4.1-mini-snapshot" });
          controller.enqueue({ type: "text-start", id: "output" });
          controller.enqueue({ type: "text-delta", id: "output", delta: text });
          controller.enqueue({ type: "text-end", id: "output" });
          controller.enqueue({ type: "finish", finishReason, usage });
          controller.close();
        } }) }),
      });
      const reportedUsage: unknown[] = [];
      let responseMetadata: any;
      const error = await callMastraSupervisor({
        ...base, phase: "specialist",
        onSummaryDelta: streaming ? async () => {} : undefined,
        onUsage: async value => { reportedUsage.push(value); },
        onResponse: async value => { responseMetadata = value; },
      }, secret, { model }).then(() => { throw new Error("Invalid output was accepted"); }, error => error);
      expect(reportedUsage).toHaveLength(1);
      expect(reportedUsage[0]).toMatchObject({ modelId: "gpt-4.1-mini-snapshot", inputTokens: 12, outputTokens: 50, totalTokens: 62 });
      expect(responseMetadata).toEqual({ modelId: "gpt-4.1-mini-snapshot", responseId: "provider-response", finishReason });
      expect(error).toMatchObject({
        code: "invalid_provider_output", providerFailure: true, retryable: true, failureCategory: "validation",
      });
      expect(error.providerStatus).toBeUndefined();
      expect(error.diagnostics).toMatchObject({
        errorId: failure === "truncated" ? "STRUCTURED_OUTPUT_TRUNCATED" : "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
        // Prefer upstream metadata over Mastra's post-validation "error" reason.
        finishReason,
      });
      if (failure === "schema") expect(error.diagnostics.issues).toEqual([{ code: "invalid_string", path: ["citations", 0], validation: "uuid" }]);
      if (failure === "summary_limit") expect(error.diagnostics.issues).toEqual([{ code: "too_big", path: ["summary"], maximum: 10000 }]);
      expect(error.cause).toBeUndefined();
      expect(`${error.message}${JSON.stringify(error)}`).not.toContain(secret);
      expect(`${error.message}${JSON.stringify(error)}`).not.toContain("not-a-uuid");
    }
  }
});
test("diagnostics exclude unknown paths, messages, values and unbounded numeric limits", () => {
  expect(sanitizeProviderDiagnostics({ errorId: "secret", finishReason: "secret", message: "sk-secret", issues: [
    { code: "too_big", path: ["summary"], maximum: 10000, message: "sk-secret", value: "sk-secret" },
    { code: "invalid_type", path: ["sk-secret"] },
    { code: "invalid_type", path: ["citations", 101] },
    { code: "sk-secret", path: [] },
    { code: "too_small", path: ["tasks"], minimum: Infinity },
  ] })).toEqual({ issues: [{ code: "too_big", path: ["summary"], maximum: 10000 }, { code: "too_small", path: ["tasks"] }] });
});
test("real Mastra agent returns a valid focused plan", async () => {
  const plan = { tasks: [{ role: "source_reviewer", goal: "Check assigned source", sourceVersionIds: [crypto.randomUUID()] }] };
  expect(await callMastraSupervisor({ ...base, phase: "plan" }, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: plan }),
  })).toEqual(plan);
});

test("independent review requires evidence findings and does not inherit the supervisor conclusion", async () => {
  let request: any;
  const finding = {
    summary: "The draft is supported with one scope note.",
    rationale: "Checked the supplied source excerpts independently.",
    citations: [crypto.randomUUID()],
    decision: "accept",
    findings: [{ severity: "note", issue: "One source excludes balcony doors.", recommendation: "Keep that exclusion visible.", citations: [crypto.randomUUID()] }],
    revisions: [],
  };
  const output = await callMastraSupervisor({ ...base, phase: "independent_review", context: { role: "independent_reviewer", proposedResult: "Draft" } }, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: finding, spyStream: value => { request = value; } }),
  });
  expect(output).toEqual(finding);
  const prompt = JSON.stringify(request);
  expect(prompt).toContain("fresh, independent reviewer");
  expect(prompt).toContain("Re-read the supplied immutable source excerpts");
});

test("source review plans treat unreviewed files as readable and honor all-source requests", async () => {
  let request: any;
  await callMastraSupervisor({
    ...base,
    phase: "plan",
    goal: "Review all project files and prepare the requested plan",
    context: { sourceInventory: { sources: [{ versionId: crypto.randomUUID() }], truncated: false } },
  }, "test-key", {
    model: createMockModel({
      version: "v2",
      objectGenerationMode: "json",
      mockText: { tasks: [{ role: "source_reviewer", goal: "Review the available project source", sourceVersionIds: [crypto.randomUUID()] }] },
      spyStream: value => { request = value; },
    }),
  });
  const prompt = JSON.stringify(request);
  expect(prompt).toContain("unreviewed status is not a reason to defer inspection");
  expect(prompt).toContain("distribute every available version across assignments");
  expect(prompt).toContain("do not claim full coverage");
});

test("configured reasoning and output budget reach the selected provider", async () => {
  let request: any;
  await callMastraSupervisor({ ...base, phase: "specialist", modelConfig: { modelId: "gpt-5.1", reasoningEffort: "low", maxOutputTokens: 900, maxSteps: 1 } }, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: { summary: "Done", rationale: "Evidence", citations: [] }, spyStream: value => { request = value; } }),
  });
  expect(request.maxOutputTokens).toBe(900);
  expect(request.providerOptions.openai).toEqual({ store: false, reasoningEffort: "low" });
});
test("live model calls require a configured preset", async () => {
  await expect(callMastraSupervisor({ ...base, phase: "plan" }, "test-key")).rejects.toThrow("preset is unconfigured");
});

test("Mastra streams only decoded sanitized summary deltas", async () => {
  const deltas: string[] = [];
  const summary = "The assigned evidence confirms a documented requirement. sk-test-secret Additional review remains necessary before approval.";
  const output = await callMastraSupervisor({ ...base, phase: "specialist", onSummaryDelta: async delta => { deltas.push(delta); } }, "sk-test-secret", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: { summary, rationale: "Private rationale is not a streamed summary", citations: [] } }),
  });
  expect(deltas.join("")).toBe(summary.replace("sk-test-secret", "[redacted]"));
  expect(deltas.join("")).not.toContain("rationale");
  expect(output).toHaveProperty("summary", deltas.join(""));
});

test("an already cancelled inference never invokes a model or emits summary", async () => {
  let invoked = false;
  const signal = AbortSignal.abort();
  await expect(callMastraSupervisor({ ...base, phase: "review", onSummaryDelta: async () => { throw new Error("Must not emit"); } }, "test-key", {
    signal,
    model: createMockModel({ version: "v2", mockText: {}, spyStream: () => { invoked = true; } }),
  })).rejects.toThrow("Supervisor model execution failed");
  expect(invoked).toBe(false);
});

function chunkedModel(text: string, onFinish: () => void = () => {}) {
  return new MastraLanguageModelV2Mock({ doStream: async ({ abortSignal }) => {
    let offset = -1;
    return { stream: new ReadableStream({ async pull(controller) {
      await Bun.sleep(1);
      if (abortSignal?.aborted) { controller.error(new Error("Cancelled upstream")); return; }
      if (offset === -1) { controller.enqueue({ type: "text-start", id: "summary" }); offset = 0; return; }
      if (offset < text.length) {
        controller.enqueue({ type: "text-delta", id: "summary", delta: text.slice(offset, offset + 7) });
        offset += 7; return;
      }
      onFinish();
      controller.enqueue({ type: "text-end", id: "summary" });
      controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } });
      controller.close();
    } }) };
  } });
}

test("real partial-object stream emits before provider finishes and hides split credentials", async () => {
  let finished = false;
  let liveDeltas = 0;
  const deltas: string[] = [];
  const summary = "The reviewed source has useful evidence that is ready for review. sk-test-secret This conclusion still needs human approval.";
  await callMastraSupervisor({ ...base, phase: "specialist", onSummaryDelta: async delta => {
    if (!finished) liveDeltas++;
    deltas.push(delta);
  } }, "sk-test-secret", { model: chunkedModel(JSON.stringify({ summary, rationale: "Rationale only", citations: [] }), () => { finished = true; }) });
  expect(liveDeltas).toBeGreaterThan(1);
  expect(deltas.join("")).toBe(summary.replace("sk-test-secret", "[redacted]"));
  expect(deltas.some(delta => delta.includes("sk-"))).toBe(false);
});

test("cancelling during structured streaming stops summary publication", async () => {
  const controller = new AbortController();
  let count = 0;
  const error = await callMastraSupervisor({ ...base, phase: "specialist", context: { role: "source_reviewer" }, modelPolicy: responsePolicy, onSummaryDelta: async () => {
    count++; controller.abort();
  } }, "test-key", { signal: controller.signal, model: chunkedModel(JSON.stringify({ summary: "A sufficiently long evidence summary has begun streaming and will be interrupted before further details can be published.", rationale: "Evidence", citations: [] })) }).then(() => null, error => error);
  expect(error).toMatchObject({ code: "cancelled" });
  expect(error.failureCategory).not.toBe("timeout");
  expect(count).toBe(1);
});
