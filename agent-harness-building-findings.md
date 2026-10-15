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
- **User validation:** Andreas's subsequent full report review supplies the product
  assessment and project-specific figures in section 11. Treat them as reported
  except where the subsequent offline reproduction explicitly verifies a figure.
- **Training-package inspection:** section 12 records local structural checks and
  attributed content from the supplied optimizer package, not legal verification,
  engineering approval or results from a trained agent.
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

**Applied follow-through:** project/model analytics and
run/recovery displays include the settled-step subtotal when that same attempt has
no priced ledger row. A later priced row, including a legitimate zero, replaces
the subtotal. Missing usage remains partial; reservations and unknown tokens are
not added. The model breakdown must also mark a settled-only subtotal partial,
even when no unpriced ledger row exists yet. Keep admission accounting separate
from display reconciliation and test both states through the public API.

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

### Schema growth must include diagnostic and retry contracts

The read-only monitor's 2026-10-15 12:30 UTC snapshot recorded a calculation-only
run stopping after five specialist schema-validation failures. It exhausted the
shared three-retry allowance at an estimated $0.283090, not its $5 spending
allowance. All five failures retained an error ID and `stop` finish reason but no
`issues` property. Their offending fields and historical outputs remain unknown.

Local inspection confirmed a separate observability bug: the diagnostic sanitizer
did not recognize `exteriorNoiseExtraction` paths. Its general index/depth bounds
also excluded later facts and nested facade provenance. New schemas must ship
with safe diagnostic field names and bounds matching their actual structure, not
only a happy-path output test. Keep codes, paths and numeric constraints; never
copy rejected values, source quotations or arbitrary validation messages.

Offline regression cases now exercise both an invalid typed fact beyond index
100 and an out-of-source quotation through the real supervisor/Mastra retry path
with a mocked model and local Postgres. Before the fix, both lose their issue path
and exhaust retries; afterward, feedback reaches the next request and the
synthetic correction passes the unchanged schema without rerunning its successful
sibling. This verifies feedback transport, not a real model's ability to repair
the output or the cause of the historical failures. Missing old diagnostics cannot
be recovered retroactively. Do not raise budgets or weaken evidence validation to
compensate for missing diagnostic evidence.

### Gate expensive continuation on calculation outcomes, not field presence

The follow-up offline audit reproduced two continuation gaps: fully populated
records with unknown applicability or inconsistent facade geometry could proceed
despite an unsupported calculator outcome; missing/conflicting inputs only paused
when a conversation existed. Version-2 continuation now checks saved batch
completion as well as structural gaps, and pauses with durable reasons regardless
of chat attachment. A negative calculated margin is not an input error and must
remain a visible finding rather than being blocked or rounded away.

Preserve the distinction between automatic model continuation and an explicitly
requested local calculation sheet: the latter deliberately permits unsupported
room outcomes with their reasons. Do not remove that useful diagnostic product.
Tests exercise both paths, including corrections saved in later input revisions
without a provider call. Existing 62-room batch tests preserve every declared
room, including missing/unsupported rooms; inventory completeness beyond the
declared rooms still requires human review.

The actual OpenAI Responses wire contract was exercised against a local fake
endpoint with empty, partial (including false/zero) and whole-room packets.
Required array fields and typed fact values round-trip without arithmetic tools.
This found no corresponding schema defect; it does not establish live model
compliance, semantic quotation accuracy or the cause of the historical failures.
Approved rules/applicability, the day/night decision and Yven's release remain
human gates. No lost historical outputs were reconstructed.

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

**Deterministic calculation-sheet export:** use the saved
batch dataset for an ARC-inspired room overview, component tables, requirement
derivation, per-element transmission contributions, explicit prognosis deduction
and numerical reserve. The export is not another calculator. Preserve surrounding
scenario reasons, before/after tables and source notes; only replace the exact
server-rendered calculation section. Unmatched historical prose and full concept
templates keep their existing export, rather than being silently reconstructed.

Precede the sheet with a maximum-two-page numerical Prüfbericht: blockers first,
negative margins next, then nonnegative margins up to 0.5 dB. Use unrounded values
for classification and enough display precision to distinguish boundary cases.
Overflow must state the number omitted from the short report and point to complete
room details; no room disappears from the Nachweis. Missing inputs are not zero
performance. Neither a negative margin nor a low reserve alone establishes which
window to buy, whether a correction is merely administrative, or legal compliance.
Those consequences need reviewed variants and applicability, not a prose model's
guess. Reference typography, layout and pagination are reusable; source-author
branding, approval marks and normative authority are not.

## 11. Validate the product, not just source preservation

**User validation:** the reviewed deliverable is the wrong product: approximately
115 pages of commentary on Yven's Nachweis, 316 exported pages / 36 MB including
attachments, rather than a newly calculated Nachweis. These are user-reported
measurements, not a fresh inspection of that PDF in this thread. The intended
customer deliverable is **a Nachweis in the ARC layout, calculated from inputs,
with Yven's explicit release**, plus a two-page Prüfbericht.

What the user's review found useful:

- All 62 rooms, 16 level cases and components were transferred completely and
  correctly; the requirement formula matched in all 62 rooms.
- Real input anomalies were identified: S_G = 59.89 m² in rooms 61/62,
  S_S versus S_ges in room 22, FE3 without area in room 52, and the label
  “OHNE BESCHREIBUNG” for VH West Nacht.

What failed the product acceptance:

- No systematic independent calculation; imported results and repeated disclaimers
  displaced the actual deliverable. The user's room-1 recalculation gives 38.55 dB
  versus ARC's displayed 38.6 dB; the offline reproduction below subsequently
  confirmed this from the printed inputs.
- Missing applied rule knowledge: +3 dB from Lr to La, the +10 dB night adjustment,
  −5 dB shielding, u_prog = 2 dB and K_AL were treated as open questions. The user
  reports a false finding about the sign before 10·log10. These observations require
  exact rule/formula context, not a global sign replacement or unconditional offsets.
- Findings did not quantify consequences. The user reports that correcting rooms
  61/62 leaves the proof satisfied and that room 22's requirement rises about 0.8 dB
  without failing. Preserve original and corrected inputs; verify those consequences
  through calculation before presenting them as established.
- The user reports 30/62 rooms with reserves ≤0.5 dB, including displayed 0.0 dB
  in rooms 19, 20 and 44. This belongs on one room-status page, not buried in prose.
  Recompute from unrounded values; a displayed zero is not proof of nonnegative margin.
- The user reports 20 living/dining/kitchen rooms assessed with night levels, with
  a possible 2.7–3.0 dB reduction under a daytime scenario. **Unconfirmed:** Andreas
  inferred this from Yven's label and DIN 4109-2, not a checked norm passage. Ask
  Yven whether the choice is intentional/conservative and confirm applicability
  before changing the baseline or stating a possible window-class reduction as fact.
- Fifteen 0.01 m² rounding discrepancies and four pages of development-plan prose
  obscured decisions. Keep diagnostic detail internally; show material consequences
  and a concise answer about fixed noise-level zones, expanding only when relevant.
- The room table appeared three times; a 72-page calculation appendix appeared
  twice with identical extracted text. Pipeline messages (“Source unavailable”,
  “Paket 1 von 7”, exhausted read budgets), broken links and descriptions of plans
  instead of the plans leaked into the customer document.

**Code-confirmed mismatch:** `acoustics/src/calculations.ts` has scoped deterministic
room-target and facade-composition methods, but expects already-assessed La and
supplied applicability/configuration judgments. It does not determine noise-source
corrections or day/night selection. The `sound_insulation` model may elect to call
these tools; `knowledge/src/supervisor.ts` caps an assignment at 20 receipts, and
there is no mandatory all-room calculation coverage gate. The shared concept
template explicitly says it is not a normative Nachweis. Optional tools and more
confident prose cannot fix this contract. This establishes the current design,
not which tools were invoked in the user's particular reviewed PDF.

**V2 acceptance and workflow, superseding prose/model optimization as the next priority:**

1. **Reviewed rules before reading for conclusions.** Version a structured exterior-
   noise rule package with standard/edition/clause references, applicability and
   exceptions, units, formula/sign/correction definitions, rounding and decision
   rules, independently expected examples, and Yven's approval. Do not treat a
   training document or model memory as executable normative authority. Unsupported
   scope produces a specific blocker, not a guessed pass or repeated disclaimers.
2. **Typed inputs and mandatory deterministic batch calculation.** Resolve the
   room/facade/element inventory and source provenance, then execute every room in
   code. A room cannot disappear because a model skipped a tool or exhausted a
   conversational step budget. A finished 62-room proof requires 62 complete results;
   incomplete geometry, ambiguous rules or unsupported paths block proof completion.
3. **Separate reproduction from corrected scenarios.** Freeze ARC's original inputs
   and reference outputs. Compare every room's requirement, calculated performance
   and reserve with the corresponding metric, units and documented rounding. The
   requested acceptance is absolute difference ≤0.1 dB per room. Exact equality
   means reproduced at that precision, not independent normative validation. Keep
   ARC outputs out of extraction/calculation inputs; never tune inputs or formulas
   to force a match. Corrections and day/night alternatives are separately labeled
   scenarios with their own input deltas and consequences. The golden tolerance is
   never added to a compliance margin or used to round a negative reserve into a pass.
4. **Two deterministic customer outputs.** Render the calculated Nachweis using the
   approved ARC layout, plus a maximum two-page Prüfbericht ranked by “kippt den
   Nachweis / ändert die Bauteilwahl / Formsache”. Each finding carries its affected
   rooms, old/new input, numerical effect, consequence and required decision. Component
   choices require the relevant approved selection rules, not dB differences alone.
   Include one compact reserve/status overview. Keep unknown/blocked rooms distinct
   from calculated failures and low-margin passes.
5. **Publication quality gate.** One authoritative room table and calculation appendix;
   embed the relevant actual drawings once, not prose substitutes. Keep full evidence
   and execution diagnostics internally. Put draft/release status and the general
   disclaimer on the cover, without repeating it throughout the narrative. Specific
   material limitations still appear with their affected result. Resolve citations
   into human-readable sources/pages; unresolved required sources block final export
   rather than becoming “Source unavailable”. Verify document structure, attachments,
   links, legibility and the two-page review limit before offering the final download.
   Identical extracted text alone still cannot authorize dropping drawings or markings;
   deduplicate only verified equivalent attachments with provenance retained.
6. **Human release remains explicit.** Generate a complete, concrete draft Nachweis;
   Yven checks and releases that immutable revision. Do not fabricate signatures,
   approval or certification. ARC layout assets and the approved example belong in
   the training/reference package, distinct from project evidence.

**Cost consequence:** eliminate repeated LLM re-narration of room tables, formula
evaluation and numerical differences. Models extract candidates, explain computed
consequences and draft concise text; deterministic code calculates and renders.
Benchmark the cost of an accepted Nachweis, not the cheapest commentary. The Sol
writer change does not solve this product mismatch and is not a reason for another
full paid run before the calculation/rule acceptance gates exist.

### First offline reference reproduction (15 October 2026)

The original 29 April exterior concept (88 pages) and annotated exterior plans
(five A3 pages) were recovered from the user's existing attachments; no resend,
production source processing or provider run was needed. The concept's SHA-256 is
`19c71fbb946e016d6d22de17508c4284509b24f60fa4f8f2ffb5e138eb918754`.
Physical pages 45–88 contain the 62 detailed rooms; pages 38–40 contain their
summary. Original attachment locators remain in the reference-audit thread,
`T-01a13cc9-7523-71dc-8bb1-b7637ed0c926`; these are not application version UUIDs.

Local `pdftotext -layout` extraction produced 62 room inputs and 307 component
rows. Every active table row's rating, correction and area was cross-checked
against its printed substitution; all required/provided reference answers were
cross-checked against the separate room summary. Inputs and expected answers are
separate private data files, not tracked project fixtures. No input was changed
to improve the match. This is reproduction from displayed precision, not proof of
the underlying measurements, applicability or original software's hidden precision.

The new `scripts/evaluate-exterior-noise-reference.ts` evaluates these files using
the Acoustics app's versioned reference-reproduction contract:

- All **62 requirements** reproduce within **0.049347 dB** of the printed result.
- **61 complete rooms** reproduce within 0.1 dB on requirement, composite
  performance, performance after allowance and reserve. Maximum performance
  difference is **0.078936 dB**; maximum reserve difference **0.095589 dB**.
- Room 1 independently gives **38.550667 dB** before the 2 dB allowance,
  versus ARC's displayed 38.6 dB.
- Room **52 is blocked**, not passed or dropped: FE3 has Rw 32 dB but no area.
  A rendered inspection of physical page 81 / appendix page 65 confirms both the
  blank area/result and omission of row 5 from ARC's calculation. It does not
  establish intentional inactivity. The complete 62-room benchmark therefore
  correctly exits nonzero until this input is resolved.
- Rooms 19/20 produce margins **−0.005032 / −0.051825 dB** from displayed inputs;
  room 44 gives **+0.067941 dB**. Do not convert rounded zero into a pass, or treat
  this reproduction as an independent noncompliance determination. Original
  precision and the approved decision rule are still needed.

The benchmark keeps requirement area and composite area distinct and records
their difference, including room 22's 17.07 versus 20.54 m². It also accepts the
reference's explicit K_LPB values rather than inventing facade exposure geometry
to satisfy the existing project tool. This is deliberately **not a new agent
tool or relaxed production gate**. Reference reproduction is useful before a
rule package is approved; it cannot replace that approval. Next: resolve the
specific blank input, validate rule applicability/rounding and day/night policy,
then connect reviewed all-room inputs to deterministic Nachweis/Prüfbericht
generation and the explicit release workflow.

### Application-owned calculation and separate outputs (local implementation)

The agent no longer decides whether to calculate rooms in new exterior-noise
workflows. Existing specialist source passes return typed room inventory, complete
room inputs and blockers with exact quotations. The application reconciles the
saved packets, runs the bounded calculator once for the declared inventory, and
saves the result in an audited, lease-fenced root tool step. Each declared room
has a result or an explicit missing/unsupported/invalid outcome. Conflicting
packets do not silently overwrite each other. Arithmetic is cheap synchronous
code, not a model call per room; introducing a worker pool would not reduce model
cost. Extraction retains existing specialist concurrency.

Two outcomes now share that stage:

- **Report:** choose Schallschutzkonzept / Außenlärmkonzept or the review format.
  The exterior concept writer interprets compact outcomes; code appends the room
  overview and full calculation details, rather than asking a writer to copy them.
- **Calculation / Nachweis:** assemble the exterior-noise sheet directly. No
  outline, section-authoring or editorial calls. Configured independent review and
  human release remain; calculation-only does not mean review-free.

Identical same-run inputs reuse their saved calculation after interruption.
Historical assignments retain their old contract. Existing numerical gates are
unchanged; the offline ARC reproduction is not substituted for the bounded
production engine. Neither a complete inventory calculation nor a near-zero
rounded margin establishes professional approval. Missing data is not zero.

**Current limits and next work:** extraction must still find every room. Version-2
assignments now retain partial field observations and reconcile them across packets
by exact room/facade/element identity; historical version-1 assignments keep their
whole-room contract. The union of evidenced inventory entries is not independent
proof of completeness. An editable complete project inventory and fuzzy identity
mapping remain outside this implementation. A final ARC-layout Nachweis and consequence-ranked
two-page Prüfbericht still require the approved exterior-noise rules (especially
day/night), resolved FE3/geometry/component inputs, layout acceptance and Yven's
release. No new paid run is needed to test deterministic arithmetic or rendering.

### Typed input clarification belongs in the active conversation

Routing is not execution authority. A classifier must know every available output
contract: omitting Calculation from its options forced “Schallschutznachweis” into
Report even though the calculation workflow already existed. Classify the requested
action, not just the domain word: create a Nachweis, explain it and find an existing
one are different requests. Keep these contrasts in the routing evaluation corpus.
Persist the proposed outcome in the conversation, let people correct it, and require
explicit allowance/confirmation before delegated, calculation or report work.
Missing or ambiguous classification asks for clarification; it does not authorize
a fallback report. Clear conversational requests can continue directly. A saved
proposal and its confirmation must share an idempotency key so reloads, network
retries and double clicks cannot buy duplicate runs. The renderer never owns this
authority: model-generated UI cannot create the execution card or alter its scope.

OpenUI is a presentation layer, not the authority for accepting engineering inputs.
The original `MissingInput` component only posted conversational text. The new
application-created `AcousticInputReview` references a saved review artifact in its
original conversation. Its API owns fields, candidates, validation and actions;
the model cannot invent executable controls, acceptance rules or stored responses.

- Merge identical typed values from complementary packets and retain all supporting
  quotations. Different quotations for the same value are not conflicts. Do not
  round disagreements into agreement, infer source authority from upload order or
  join ambiguous room aliases. A field-level evidence register accompanies results.
- Keep inventory independent of complete inputs. An inventoried room with no area
  or element data stays blocked rather than disappearing from coverage. Confirmation
  records the person's explicit check against the room schedule; it is not an
  independent guarantee that the model found every room.
- Bind responses to an exact revision and lock writes. Stale and concurrent replies
  must not overwrite another participant's answer or create duplicate calculations.
  Preserve competing observations and the responder, timestamp and decision reason.
  A selected source value stays attributed; a new human value is an assumption,
  not a fabricated source quotation. New scenarios must also replace stale field
  citations when they change a value.
- Stop new runs for input clarification before buying prose/review of structurally
  incomplete inputs. Saving responses does not wake a model. An explicit calculation
  action creates a new unapproved sheet using the unchanged engine gates. Full-report
  continuation and independent model review remain separate requested actions.
- Scope review reads and writes to tenant, project, conversation and accessible
  pinned sources. Store state in Postgres artifact revisions, not in browser memory.
  Generic prose edits cannot preserve or forge typed review state. Load historical
  forms on opening, not one request per old message during navigation.

This is reusable beyond acoustics: extract observations, reconcile deterministically,
ask targeted typed questions in context, then execute code against the saved revision.
Offline tests establish reconciliation/arithmetic behavior; they do not prove live
model extraction quality on unfamiliar plans or validate an unapproved rule package.

### Reuse approved data, not an earlier model answer

The next local implementation keeps typed room input/result snapshots in existing
artifact revisions. After human approval of an exact latest revision, a planner
can create a numeric scenario with no source extraction or model calls. It runs
the existing deterministic batch calculator and saves a separate draft/PDF with
parent revision, before/after values, change reason and audit history. The original
stays unchanged. Scenario edits become explicit unreviewed assumptions; they must
not retain source quotations that describe the old value or inherit approval.

Reuse is tenant/project scoped, source versions stay pinned and are checked again,
and the approval/revision lock rejects stale bases. Generic artifact editing
cannot forge or carry executable input snapshots. Missing rooms remain missing,
source conflicts remain visible, and the editor cannot waive applicability,
geometry, installed-rating or flanking gates. Reference results remain outside
the input contract. A numeric scenario is not a new model review or certification.

Transferable rule for other sub-agents: persist a typed input revision before
interpretation; make repeated deterministic evaluation independent of extraction;
bind human review to that exact revision; preserve lineage and mark every changed
assumption. An output cache alone cannot support trustworthy scenario planning.

## 12. Training packages are versioned evidence, not executable authority

**Received:** `Baukostenoptimierer_Trainingspaket.zip`, package README dated
12 October 2026, supplied by Andreas in this thread. Downloaded archive SHA-256:
`53970eb125148c48fd647b6a9bd725c071a45c8e5a6977944987c5e008344b9f`.
The archive was inspected locally without executing its bundled build scripts,
calling a provider, importing production knowledge or changing agent settings.
This is the **cost optimizer / System 8** package, not an approved exterior-noise
calculation rule set. Its reusable method informs Nachweis v2; its cost and
contract policies must not silently become acoustic calculation rules.

### Observed structure and integrity

- 143 content files after excluding macOS metadata; 73 unique curated rules in
  `01_Hebel-Bibliothek/hebel_bibliothek_kern.json`, 296 unique consolidated
  candidates, and 429 raw extracted records. All 167 populated candidate `kern_id`
  links resolve to a core ID; the other 129 are unlinked candidates, not missing
  approved rules. All candidate `quell_ids` resolve to raw-record IDs.
- Eleven worked case sections are present across the two case documents. They
  include rejected alternatives and unresolved decisions, not just success stories.
- There are 91 transcript files: 26 Essential and 65 Advanced. Advanced files
  27 and 28 are byte-identical, leaving 90 distinct transcript contents. Preserve
  both source locators if deduplicating retrieval; do not count copies as independent
  evidence. The source directory also documents transcription errors and loops;
  transcripts are not reliable technical terms merely because extraction succeeded.
- All 73 core rules carry `status: aktiv`; reliability labels divide into 31
  estimates, 31 documented claims and 11 `verifiziert (Rechtsquelle)` claims.
  Every core rule has source references, but all 73 `belege` arrays are empty.
  This does not mean no evidence exists in the package; it means those labels and
  pointers are not structured review receipts or automatically executable proof.
- Twenty-two core rules have no numerical magnitude. Keep null as unknown; do not
  invent a saving, turn it into zero or reject a useful non-monetary rule solely
  because it lacks a price. The documented example schema is not a complete
  machine schema: actual core entries also use fields such as `status`, `belege`
  and `faelle`, and phase values include `LP2` separately from `LP1-2`.
- The rescue-route workbook has **154 formula cells without cached results**.
  The insulation comparison has 75 formula cells with cached values, the heating
  comparison 186. These are ZIP/XML inspection results, not recalculated workbook
  validation. Missing caches must never be interpreted as blank inputs or zero;
  cached results do not establish freshness or correctness either.

### Transferable harness decisions

1. **Separate principles, rule records, calculations and cases.** Retrieve scoped
   rule records by trigger, discipline, project phase, region and source revision;
   consult the source when needed. Do not put the entire corpus into every writer
   prompt. Source paths/lesson names need explicit locator mapping, not invented
   application version IDs. Preserve distinctions between original evidence,
   transcript, extracted candidate, curated rule and human-reviewed executable rule.
2. **Apply hard constraints before ranking economic benefits.** The package's
   economic objective hierarchy must not permit a saving to outweigh an applicable
   legal, engineering or agreed contractual requirement. Eligibility and unresolved
   applicability are separate from ranking. Keep the requested/contractual target,
   calculated performance, mandatory allowances and discretionary reserve separate;
   a policy to remove excess reserve does not authorize removing a calculation's
   uncertainty allowance or changing a signed target.
3. **Promote individual claims, not whole records.** A rule can mix a legal citation,
   an internal policy, a rough cost range and a project decision. For example,
   `HB-NORM-04` is labeled verified while its note explicitly calls for calibration
   of its internal policy numbers. Store source-declared confidence separately from
   review status, reviewer, scope, effective date and approval. Neither `aktiv` nor
   `verifiziert` can grant runtime authority. Recheck time-sensitive legal claims
   against the applicable primary source before consequential use.
4. **Preserve units, applicability and interactions.** Area/cost denominators,
   tax basis, price date, region, baseline, time horizon and source confidence belong
   with every magnitude. Free-text ranges in this package are retrieval evidence,
   not a unit-price database. Overlapping measures require a combined scenario
   calculation, not addition of headline savings. The cited 53 dB example is
   explicitly about a dwelling-separating wall; it is not a universal exterior-
   facade target. Do not transfer Berlin assumptions to the Alzey reference.
5. **Evaluate decision usefulness, not confident prose.** Retain the package's
   pattern: triggering fact → applicable rule → calculated effect → trade-off →
   decision/owner, with rejected alternatives and unresolved prerequisites visible.
   For Nachweis v2, use the user's consequence-ranked two-page Prüfbericht, not
   the optimizer's Top-3 format as a substitute for complete room calculations.
   A cheaper alternative is not necessarily the customer's preferred alternative;
   a historical choice is neither universal policy nor proof of legal approval.
6. **Prevent answer leakage across the entire retrieval corpus.** Thirty-two core
   rules explicitly reference the worked cases; some contain their outcomes and
   numbers. The eleven cases are valuable regression/reproduction cases, not an
   unseen quality benchmark when this corpus is available. Split model input from
   expected results and exclude derived rules, notes and transcripts carrying the
   held-out answer. Add counterfactual cases and a genuinely separate project before
   claiming generalization or equal quality from a cheaper model.
7. **Make formula execution explicit.** Reproduce spreadsheet results with a
   supported deterministic evaluator or independently implemented, tested formulas;
   detect unsupported functions and external dependencies. Keep input cells,
   formulas, computed results and prose expectations separate. Do not execute
   arbitrary package scripts or translate all spreadsheet formulas through an LLM.
8. **Keep rights and confidentiality attached to derived knowledge.** The README
   limits the course material to internal use and asks for agreement before using
   passages productively or distributing them. Two negotiation originals are
   separately marked for Patrick's review before onward sharing; their bodies were
   not needed or opened for this intake. Do not commit the archive, publish its
   transcripts, bulk-upload it to providers or treat extraction into a core rule as
   removal of a restriction. Future imports must preserve access and use limits.

### What this supplies for Nachweis v2, and what it does not

Use the package's structure for the exterior-noise rule register: condition,
edition/clause and jurisdiction, required inputs/units, formula or deterministic
method version, exceptions, expected worked result, consequence and review owner.
Keep reference reproduction, corrected scenarios and compliance/release decisions
separate, as in section 11. Those are design decisions recorded here, not newly
implemented runtime capabilities.

The optimizer package does not resolve the outstanding room-52 FE3 area/activity
question or approve the living-room day/night interpretation. It is not a reason
to remove the acoustic calculation gates, change normative defaults, import all
73 rules as approved or start another paid report. Next domain input remains the
reviewed exterior-noise rules/worked examples and Yven's specific decisions; this
package need not be sent again.

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

### Earlier optimization follow-ups

The full report validation in section 11 supersedes this earlier ordering.
Establish the rule package, mandatory calculation coverage and Nachweis acceptance
first; a writer-model comparison is no longer the next full-workflow experiment.

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

### Extraction contracts and actionable repair (15 October)

The later calculation run on `7946ace` retained safe diagnostics: malformed
source-version UUIDs and a room-level fact ID unequal to its room ID. Subsequent
root-level custom errors did not identify their condition. Offline reproduction
showed that unselected sources, non-verbatim quotations, duplicate rooms and
undeclared rooms all previously collapsed into identical repair feedback. This
does not reconstruct the rejected production outputs or establish older failures'
causes. That run exhausted three shared retries at an estimated $0.290159, not its
$5 spending limit.

Constrain identities at generation time: the extraction schema enumerates the
packet's exact source versions throughout inventory, facts and complete-room
provenance. No readable sources means no extracted records, only blockers. Keep
the independent post-generation source/quotation checks. Emit precise field paths
and an allowlisted reason for each failure; preserve these through persistence
and repeated sanitization without including rejected values or source prose.
Distinguish room identity repair from duplicate records and evidence repair.
Never invent IDs/quotations, omit evidenced rooms or weaken engineering checks to
make validation pass. Synthetic and mocked-retry tests verify the contract and
feedback transport, not extraction quality or real-model recovery.
