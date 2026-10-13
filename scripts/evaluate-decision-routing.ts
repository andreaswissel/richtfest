import { parseArgs } from "node:util";
import { z } from "../richtfest-shared/node_modules/zod";
import { callDecisionModel } from "../richtfest-os/apps/api/src/decision-runtime";
import { decisionRoutingVersion, routingQuestions, routingResultSchema, selectSummaryRoute } from "../richtfest-apps/knowledge/src/decision-routing";

// No network by default. Live evaluation is explicit, uses operator-supplied
// credentials, and never exports the state or credentials in its result file.
const { values } = parseArgs({ args: process.argv.slice(2), options: {
  cases: { type: "string", default: "tests/fixtures/decision-routing.json" },
  responses: { type: "string" }, live: { type: "boolean", default: false },
  "credential-file": { type: "string" }, threshold: { type: "string", default: "0.99" },
} });
const threshold = z.coerce.number().min(0.9).max(1).parse(values.threshold);
const cases = z.array(z.object({
  id: z.string().min(1), split: z.enum(["calibration", "holdout"]), expectedSummary: z.boolean(),
  state: z.object({ goal: z.string().min(1).max(2000), selectedSourceCount: z.number().int().min(1).max(10),
    history: z.array(z.object({ body: z.string().max(1000), actorKind: z.enum(["human", "agent"]) })).max(20),
  }).refine(v => Buffer.byteLength(JSON.stringify(v), "utf8") <= 16000),
})).min(1).parse(await Bun.file(values.cases!).json());
if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error("Case IDs must be unique");
if (values.live && values.responses) throw new Error("Choose live evaluation or saved responses, not both");
if (!values.live && !values.responses) {
  console.log(JSON.stringify({ validCases: cases.length, version: decisionRoutingVersion,
    model: "jev-1.13.0",
    note: "Validation only. Supply --responses for offline scoring, or --live with TYPESAFE_API_KEY or --credential-file after approving data handling and cost." }));
  process.exit(0);
}
const saved = values.responses ? z.object({ version: z.literal(decisionRoutingVersion), results: z.array(z.object({
  id: z.string(), output: z.unknown().optional(), elapsedMs: z.number().nonnegative(),
  usage: z.object({ estimatedCostUsd: z.number().nonnegative().nullable().optional() }).optional(),
})) }).parse(await Bun.file(values.responses).json()).results : [];
if (values.responses && (saved.length !== cases.length || new Set(saved.map(r => r.id)).size !== saved.length
  || cases.some(c => !saved.some(r => r.id === c.id)))) throw new Error("Saved responses must match every case ID exactly");
// An explicit plain-key file takes precedence; never accept a secret CLI value.
// Do not include invalid credentials or filesystem/provider errors in output.
let credential: string | null = null;
if (values.live) {
  try {
    const key = values["credential-file"]
      ? (await Bun.file(values["credential-file"]).text()).trim()
      : process.env.TYPESAFE_API_KEY;
    if (!key || /[^!-~]/.test(key)) throw new Error();
    credential = key;
  } catch {
    console.error("Live evaluation requires TYPESAFE_API_KEY or a readable plain-key --credential-file.");
    process.exit(1);
  }
}
const results = [];
for (const item of cases) {
  let record = saved.find(r => r.id === item.id);
  if (credential) {
    const started = performance.now();
    let usage;
    try {
      const response = await callDecisionModel({ runId: "offline-evaluation", state: item.state, questions: routingQuestions,
        onUsage: async value => { usage = value; } }, credential);
      record = { id: item.id, output: response.output, usage: response.usage, elapsedMs: performance.now() - started };
    } catch {
      record = { id: item.id, usage, elapsedMs: performance.now() - started };
    }
  }
  let eligible = false, failed = false;
  let output;
  try {
    output = routingResultSchema.parse(record!.output);
    eligible = selectSummaryRoute(output, threshold).eligible;
  } catch { failed = true; }
  // Export only validated labels/probabilities and known numeric cost, never
  // arbitrary saved-response fields, raw upstream output or provider errors.
  results.push({ id: item.id, output, elapsedMs: record!.elapsedMs,
    usage: { estimatedCostUsd: record!.usage?.estimatedCostUsd ?? null },
    split: item.split, expectedSummary: item.expectedSummary, eligible, failed });
}
const summary = ["calibration", "holdout"].map(split => {
  const rows = results.filter(r => r.split === split);
  const latencies = rows.map(r => r.elapsedMs).sort((a, b) => a - b);
  const priced = rows.filter(r => r.usage?.estimatedCostUsd != null);
  return { split, count: rows.length, automaticRoutes: rows.filter(r => r.eligible).length,
    unsafeAutomaticRoutes: rows.filter(r => r.eligible && !r.expectedSummary).length,
    missedSummaryRoutes: rows.filter(r => !r.eligible && r.expectedSummary).length,
    failedCalls: rows.filter(r => r.failed).length,
    p95LatencyMs: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
    recordedCostUsd: priced.length ? priced.reduce((sum, r) => sum + r.usage!.estimatedCostUsd!, 0) : null,
    unpricedCalls: rows.length - priced.length };
});
console.log(JSON.stringify({ version: decisionRoutingVersion, threshold, summary, results,
  note: "Semantic router evaluation only, not end-to-end task quality. Fixture labels are provisional; obtain domain review and use a separate untouched holdout before enabling routing. Safety/eligibility gates remain in the application." }, null, 2));
