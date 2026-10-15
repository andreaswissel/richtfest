# Agent harness building findings

Reusable lessons for building source-backed sub-agents and content workflows.
Recorded 2026-10-15. This is an engineering findings register, not a normative
acoustic assessment or a model-quality benchmark. Examples come from a cancelled
exterior-noise report and a separate audit of its reference material.

## Evidence and confidence

- **Observed:** saved prepared inputs, outputs, checkpoints, usage/step receipts,
  and local code establish the behavior described below.
- **Audit finding:** the [reference-project audit](https://ampcode.com/threads/T-01a13cc9-7523-71dc-8bb1-b7637ed0c926)
  supplies source-material observations. It is not a forensic replay of the run.
- **Hypothesis:** an explanation not established by the available records. Do not
  turn these into implementation assumptions or customer-facing diagnoses.
- **Proposed:** a future safeguard or experiment, not a delivered capability.

The private offline fixture contains four independent-review initial requests,
rejected/repaired editorial pairs, and acoustic/register writing packets. It was
exported in a tenant-scoped read-only snapshot at 2026-10-15 00:00:06.983 UTC.
URLs and sensitive fields were redacted and prompt JSON reserialized. It contains
no raw images or normalized provider continuation transcript. Original hashes are
provenance, not proof of a byte-identical replay. Do not commit private fixtures.

## 1. Give each agent exactly the contract it owns

**Observed:** all three completed independent evidence reviews demanded an
assembled report of at most 60,000 characters. Runtime instructions included that
per-response limit, while the document assembler explicitly disables it for
validated sections. The reviewer output schema does not even contain a document.

**Rule:** separate input-document constraints, output-response constraints and
assembled-artifact constraints. A reviewer must not inherit writer instructions
to generate templates or fit the input report into its own output budget. Enforce
response limits in schemas and use phase-specific instructions.

**Observed:** early review inputs omitted the plans chapter; reviewers called it
missing. A later saved input includes that chapter. Citation-based slicing did not
include a manifest of deliberately omitted sections.

**Rule:** supply a stable section directory and explicit included/omitted status.
Partial evidence agents assess their supplied scope. Only a whole-document pass
or deterministic structure validator can decide global section completeness.
Absence from a packet is not absence from a project.

Owners: `richtfest-os/apps/api/src/agent-runtime/mastra-supervisor.ts`,
`richtfest-apps/knowledge/src/independent-review.ts`,
`richtfest-shared/src/agent-document.ts`.

## 2. Reduce repeated representation, not evidence coverage

**Observed:** four saved initial review prompts were 765,595 / 767,685 / 764,953 /
770,275 UTF-8 bytes, plus 15,709 instruction bytes each. Report bodies alone were
386,919 / 386,919 / 355,451 / 578,336 bytes. The first two report bodies are identical.
These are redacted input measurements, not provider tokens or savings estimates.

Whole-section selection repeats uncited sections and falls back to the full
report for evidence with no matching citation. Full template prose was already
removed from review payloads; shared-prefix caching and removal of the unrelated
component catalogue from patch editing were already implemented before this work.

**Rules:**

- Use deterministic code for identity directories, required section presence,
  attachment manifests, pagination, exact duplicate removal and accounting.
- Keep one authoritative register for source/version/page coverage. Section
  writers own their relevant claims rather than reprinting every register.
- A bounded claim review needs its exact evidence, table headings, conditions,
  neighboring context and contradictory claims—not just matching numbers/UUIDs.
- Include evidence with **no claim** in coverage checks: checking only citations
  rewards omission. Keep an independent cross-section consistency pass.
- Never discard unique evidence, unresolved issues or review checks merely to
  satisfy a cost target. Identical bytes may be shared; meaning-equivalence needs
  explicit verification, especially across revisions and visual material.
- Cache reusable prefixes only where the provider contract supports it. Measure
  actual cache reads/writes and their prices; a cache flag is not a cache hit.

## 3. Make evidence state explicit and cumulative

Distinguish: selected source, resolved source, native text, OCR, rendered image,
image actually inspected, extracted claim, imported result, calculated result,
reviewed claim and human approval. None implies the next.

**Observed:** available rendering receipts were not proof of semantic inspection.
Historical per-call read-cap denials later had available replacements. A read-cap
denial is not an unreadable source; an empty excerpt is not a blank original.
Saved reviewers reported stale packet-specific coverage assertions remaining
alongside later findings. Their diagnoses require source verification, not blind
acceptance as gold labels.

**Rule:** identify coverage by immutable source version, original page/crop or
byte range, extraction/inspection method and outcome. Merge statuses only when
their scope really matches. Preserve the difference between cumulative coverage
and this call's evidence. Do not widen citation permission through a directory.

**Observed:** an editor replaced “attached” with “intended”, silently resolving
contradictory attachment claims. Its preservation checker rejected the change.
A repaired candidate retained both assertions and the unresolved actual status.

**Rule:** contradictions are first-class evidence, not prose defects to smooth
away. Keep both claims and their provenance until an authorized decision or a
source-backed correction resolves them. A render receipt cannot decide whether
a page was attached, approved or semantically reviewed.

## 4. Extraction quality comes before model selection

**Audit finding:** mixed PDFs may contain native title text but rasterized drawing
labels. The current native-text fallback treats three letters/digits as meaningful
and can therefore skip OCR of important image regions. This does not establish
that extraction caused the cancelled run's failure.

**Rules:** preserve native text; assess coverage of meaningful image regions and
use bounded OCR/visual reads where needed. Avoid OCRing every page by default.
Treat OCR as unverified transcription, never geometry or a visual-equivalence
proof. Preserve extraction method, original page numbering and missing regions.
The audit's first-24-pages / 24k-character fact index was partial, not full coverage.

An 88-page PDF can legitimately state 16 body pages and contain appendix pages
17–88. Upload version 1 is not a document revision; dates in filenames are not
document issue dates. Similar names or equal extracted text do not prove two
documents are identical, current or visually equivalent.

Owner: `richtfest-apps/projects/src/source-text.ts`; business evidence remains in
Richtfest Apps, with OS capabilities supplied through host contracts.

## 5. Preserve semantic associations, not just strings

The source audit gives reusable **test patterns**, not permission to hard-code
this project's numbers or to certify calculations:

| Case | What must survive / wrong answer to reject |
| --- | --- |
| Planning 20/20b versus 29 | Preserve the applicability conflict; filename or numeric match cannot decide jurisdiction. |
| Room 22: 17.07 versus 20.54 m² | Keep the values with their distinct calculation roles and source pages. |
| Room 42: 123.19 versus 122.41 m² | Preserve the discrepancy without silently picking a value. |
| Room 61/62: repeated 59.89 m² | A suspected copy error is not a proven error. |
| Rw,p 40/38 versus Dn,e,w 52 | Different metrics/components are a false-positive control, not automatically a contradiction. |
| Rounded 36.7 versus 36.7 | Rounded equality cannot establish an exact compliance margin. |
| Room 8 element multiplicity and +5 dB | Preserve count, metric, correction scope and source conditions. |
| 16 orientation/day-night scenarios | Keep each association; never add day/night or reapply included corrections. |
| “Kein…” in filename / zero source input | Neither establishes measured zero noise or independently verified absence. |
| Roof 58 − 4 − 2 = 52 and printed ≥600 mm | Preserve surprising signs and conditions; do not normalize or approve them by intuition. |
| Thermal/configuration dependencies | Product/reference values are not evidence of installed configuration. |

Agents may coordinate, import and propose. New arithmetic belongs to versioned
deterministic tools with exact inputs, units, method/version and limitations.
Engineering applicability and approval require the appropriate reviewer.

## 6. Checkpoint the work product and its contract

**Observed:** recovery retained 13 assembled parts, six appendix children and 14
accepted editorial groups. Nineteen new accepted checks completed all 33 groups.
Calling every recovery invocation a wasteful retry would be incorrect.

**Rules:** persist completed bounded outputs and validation evidence. Include
input evidence, model policy and prompt/packing contract version in checkpoint
identity. Reuse only compatible work; retain historical diagnostics even when a
new contract requires rechecking. Never silently reuse a verdict made under a
different scope contract. Retry rejected edits from the original plus saved
candidate/feedback, and independently recheck every changed repair.

The prior run stopped after a negative preservation verdict under a generic
execution classification. The exact thrown exception requires correlated runtime
logs; a saved failed verdict alone does not prove the exception path.

## 7. Distinguish spend, reservations and unknown usage

At cutoff 2026-10-14 23:45:22.839 UTC, the cancelled run's known persisted estimate
was **$39.286090**, not an invoice/final charge. The $36.880805 ledger plus a
nonduplicated $2.405285 settled step receipt outside its interrupted invocation's
null-cost ledger row produced that total. An interrupted next step remained unknown.

| Stage | Known estimated USD |
| --- | ---: |
| Section drafting | 20.572484 |
| Editorial writing and preservation checks | 6.255487 |
| Independent evidence review | 11.494556 |
| Preparation, outline, specialists and reranking | 0.963563 |

The original generation cost $24.428589; recovery's known estimate was $14.857501.
The recovery authorization added $35; it was not a lifetime $35 ceiling. There
were 143 invocation records, 142 priced ledger rows and one unpriced interrupted
row. Invocation counts, individual model turns, tool executions, activity events
and audit rows are different counters. Only one explicit automatic validation
retry was identified in this run.

**Rules:** count each usage ID once, avoid multiplied joins, reconcile partial
receipts without double counting, and expose uncertainty. Reservations are
admission bounds—not charges. Cached input is a subset of input; reasoning is
not billed again as extra output. Apply each model's pricing version and include
cache-write surcharges. Missing cache-write data is not zero.

Preflight completion/review capacity, reserve one actual step at a time, preserve
remaining review headroom and report cumulative spend separately from additional
recovery allowances. Cancellation in the app does not prove remote execution
stopped or that no later provider charge can arrive.

## 8. Make failures diagnosable without retaining secrets

Persist numeric per-step admission evidence: estimator version, step ordinal,
text bytes/token bound, media count/dimensions/token bound, output allowance,
pricing version and the decision amounts. Correlate by run, generation, attempt,
operation and provider request ID where available. Never log credentials, raw
images, signed source URLs or full sensitive prompts to explain a bound.

Historical denied bounds of $46.753610 and $10.784150 were not spend. The saved
initial request cannot establish what the actual continuation contained. Image/
base64 inflation was a hypothesis for those historical records, not a replayed
cause. Image-aware numeric admission diagnostics have since been implemented;
they cannot reconstruct fields absent from older records.

## 9. Change models by responsibility and measure accepted-output cost

The expensive work was Astra drafting/editing/review, not Luna specialists.
Changing the supervisor model globally affects several responsibilities. A
cheaper writer is a candidate; reducing independent scrutiny is not a safe default.

**Evaluation:** five private cases are prepared: original contradictory edit,
rejected/accepted preservation controls, acoustic section and source register.
Compare writer candidates on identical evidence, instructions, schemas and output
budgets. Blind the assessor to model identity. Keep historical outputs separate
from model inputs and do not treat a prior model check as engineering truth.

Acceptance requires no lost unique evidence or changed associations, no invented
facts/approvals, no silently resolved contradictions and no new material false
positives. Measure actual usage, cache read/write cost, latency, repairs and final
accepted-output cost. A small sample can reject a poor model, not establish general
quality equivalence. Paid comparisons require an explicit bounded authorization.

Separate **reconstruction** (finished reference report supplied) from **generation**
(finished report and derived answers held out). The reference audit did not run a
model benchmark or verify a newly generated PDF end to end.

## 10. Treat export as a versioned deliverable, not another agent task

Users should not wait for a fresh rendering operation on every download. Prepare
PDFs after artifact completion and cache by immutable revision, approval labels,
exporter version and exact source attachments. Never reuse stale permissions,
source revisions or approval status. This background PDF workflow was already
implemented before the current findings work; no paid agent rerun is needed.

## Application and follow-up register

### Applied in the current harness

- Independent reviewers now receive summary/rationale response limits, not an
  assembled-document character ceiling. Evidence slices identify intentionally
  omitted sections; the whole-report pass owns global reconciliation.
- Section selection and source bytes remain intact, including uncited evidence
  and the whole-report fallback. Inspection found effectively no exact duplicate
  source-text opportunity in these saved packets; no speculative deduplication or
  source truncation was added. This contract fix is not a measured token saving.
- Review checkpoints use a new contract version. Old verdicts remain diagnostic
  history but cannot serve as current approval. Compatible authoring stays reusable.
- A separate opt-in writer model covers acoustic sections and editorial edits.
  Outline, preservation checks and independent review remain on the supervisor.
  Writer policy participates in checkpoint identity; packing respects both models.
  Admin settings, provider validation and failed-call output-limit actions retain
  that distinction. Absent overrides preserve historical behavior.
- Regression coverage exercises source-byte preservation across UTF-8 splits,
  omitted versus uncited sections, duplicate headings, legacy verdict invalidation,
  model routing, checkpoint reuse, audited settings and writer failure attribution.
  Mock/provider-transport tests validate execution contracts, not model quality.

### Recommended production policy

For **OpenAI Medium only**, configure report writer `gpt-6-sol`, 32,000 output
tokens, one tool-free step, provider-default reasoning. Retain supervisor/checkers/
independent reviewer `gpt-6-astra` at 32,000 tokens / four steps and current Luna
specialists. Keep independent review enabled and preserve all other settings,
including timeout, parallelism, retries and spending allowances. Do not alter High.

The current pricing catalogue lists Sol at $2/M input and $10/M output versus
Astra at $10/M and $50/M. That is an 80% lower **uncached token rate for writing**,
not an 80% report saving or quality-equivalence result. Cache behavior, output
length and repairs can change accepted-output cost. Enabling this policy affects
new requests only; retrying an old run keeps its original model snapshot.

Production settings should be changed only through the existing audited admin API,
after deploying support, with before/after readback of the full preset and unchanged
fields. A settings save is not authorization to start paid inference.

### Production log correlation limits

Authenticated Railway access worked through the existing environment credential;
no new Railway sign-in was needed. Root-filtered logs from the original deployment
at 23:16–23:17 UTC and the later deployment at 23:40–23:41 UTC returned no entries.
That does not prove no exception occurred: retention, filtering or missing root IDs
may account for the empty result. The exact historical rejection exception remains
unverified. User cancellation is separately confirmed by the persisted audit.

### Additional measures, ordered by value

1. **Domain-reviewed, bounded model comparison:** run the prepared five-case pack
   only after explicit paid authorization. Score source associations, contradictions,
   omissions and false positives before cost. Add a separate source-only holdout.
2. **One cumulative evidence register:** make section ownership and coverage durable
   so writers consume scoped claims rather than repeat source registers. Retain
   uncited evidence and cross-section checks. Validate against the current baseline
   before replacing full-text evidence; smaller prompts alone are not success.
3. **Mixed-PDF coverage:** add native-text-plus-raster fixtures and region-aware
   extraction decisions. Avoid a blanket OCR rollout or paid reprocessing of old
   sources. Validate original page mapping and the reference-audit cases above.
4. **Review completion headroom and cancellation accounting:** surface remaining
   stages and cumulative recovery spend; reconcile late partial receipts without
   double counting. Never label reservations as charges or unknown outcomes zero.
5. **End-to-end release gate:** independently check the final artifact, source-page
   attachment completeness and prepared PDF—not merely a model's accepted verdict.
