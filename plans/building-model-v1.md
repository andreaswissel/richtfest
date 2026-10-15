# Shared building model V1 implementation plan

Status: implemented scope recorded; local worktree only, with no deployment or production data mutation.

## Outcome

Add a durable project building model and a dense Building model workspace so experts and agents use the same reviewed identities, facts and evidence. The supported V1 includes automatic packet-aware topology-v3 extraction after ordinary PDF upload: the system registers every page, queues confident floor-plan sheets, and presents spatial room regions, unresolved anchors, conservative draft walls and unsupported construction fragments for human correction or reconciliation before they become reviewed shared model objects.

Ordinary project-evidence PDF uploads now create the draft model shell automatically. After saved source processing completes, Richtfest registers every packet page, uses exact drawing-title text before bounded image triage, queues topology only for confidently identified floor-plan sheets, and retains non-floor or unresolved pages as visible coverage gaps. The PDF is immediately readable while durable stages run; no manual model, storey or page setup is required before useful unreviewed geometry appears. Manual setup remains a fallback for unsupported or unresolved sources.

## Architecture

1. Extend the Projects Richtfest App with stable project-scoped building, storey, spatial-object and element identities. Keep geometry optional and represent construction state independently from source revision and future alternatives.
2. Store versioned properties, measurements, evidence links, relationships and review/proposal records in Postgres. Preserve conflicting claims; optimistic revision checks prevent silent overwrites. Existing project permissions and audit hooks govern every write.
3. Reconcile existing source-model entities and IFC entities to shared identities through explicit reviewed links. Never merge solely on fuzzy labels. Keep exact file revision plus PDF page/region or IFC entity evidence.
4. Extend shared Zod/domain types and the Projects host contract/API with stable IDs, deep links, current reviewed properties, missing-input summaries and inspectable agent change proposals.
5. Add a Building model project view that lazy-loads the plan renderer, keeps Location unchanged, supports page/layer/state controls, selectable regions, property correction and evidence/measurement entry. Unknown room use remains unknown until explicitly changed; scenario assumptions remain separate.
6. Add deterministic extraction for one exact ready PDF revision, linked storey and page. Native PDF text is preferred and German/English OCR is the fallback when no labels are found. Topology-v3 combines supported construction fills, supplementary existing/demolition fills and compound even-odd fill regions, preserving holes. Labels seed enclosed contours or approximate geodesic partitions; unresolved labels remain anchors. Connectivity groups exact construction polygons into assemblies. Jobs are durable and idempotent with leased work and bounded recovery.
7. Let a person review, rename, accept, reject or reconcile each candidate into the canonical shared model. Accepted assemblies become `source_construction_assembly` elements; legacy individual footprints remain `source_footprint`. Preserve evidence and inference limits, and strip unreviewed printed areas on acceptance. Accepted objects flow through the Projects host's bounded building snapshot into agent context. Failure leaves the original source available for manual region entry.
8. Document the implemented architecture/workflow and keep one concise `Unreleased` changelog item after verification; no deployment is included.

## Supported extraction scope

- Reference page 3 yielded **91 room candidates: 48 spatial proposals and 43 unresolved anchors**, with **76 WE-unit associations**. All retain their source labels and inference limits. These results do not guarantee complete room coverage on this or other pages.
- The page's **235 exact normalized construction polygons** become **164 draft-wall candidates** and **64 unsupported-fragment groups**. A draft wall requires an exact elongated rectangular fill on the source construction layer; repeated page-relative minor-dimension bands strengthen the evidence without becoming a physical thickness measurement. Across floor pages 1–5, all 827 retained source polygons are accounted for by 556 draft walls and 237 fragment groups.
- Page 3 retains **48 spatial room proposals** and **43 unresolved label anchors** from 91 labels. A page-local polygon-area/printed-area consistency check demotes 28 severe merge/split outliers there; across pages 1–5 it demotes 73 ratio outliers plus one oversized whole-area proposal. The check is relative quality control, never scale or measurement evidence.
- **90 printed-area observations** remain unreviewed candidate annotations. Acceptance strips them from canonical geometry; reviewed measurements need separate evidence and review.
- Geodesic partition seams are hypotheses, not physical barriers or draft walls. Draft walls preserve exact source polygons but do not establish continuity, doors, openings, adjacency, material, construction state, physical thickness, scale or completeness. A planner may add supported facts manually with separate evidence and review records.
- Source-document text blocks, their raw-text SHA-256 and PDF optional-content-group metadata remain provenance/display evidence. Text blocks do not become a second semantic inventory, and OCGs affect rendering only; block-to-layer association is unknown.
- Migration `0041_building_extraction` adds durable extraction jobs and candidates. Stable source identities and candidate keys make retries and duplicate clicks safe; leases and at most three attempts bound recovery. An explicit re-run refreshes a completed or failed job, preserves reviewed candidates and supersedes obsolete unreviewed hypotheses.
- Topology extraction itself is local/deterministic and does not require a live model provider or vector index. When a TypeSafe credential is available, the worker optionally classifies up to 64 deduplicated exact source labels through the existing decision adapter in one fail-open call. Those results remain unreviewed proposals and are stripped on acceptance; missing configuration or a failed call does not block extraction. Agent proposals still require the normal configured provider and permissions; the current building context is a bounded structured snapshot, not embedding or vector retrieval.
- Upload-time TypeSafe image triage is optional supporting evidence for page type. Exact saved titles such as Grundriss, Schnitt, Ansicht and site/setback-plan labels take precedence; mixed, low-confidence, missing or conflicting classifications stay unresolved. Draft candidates are available to authorized agents in a separate `draftCandidates` collection and never masquerade as reviewed canonical entities.

Seeded or fixture geometry is not part of the supported V1 workflow. A reference PDF may be used for verification, but its extracted labels remain candidates until reviewed, and manual entry is the fallback when extraction cannot establish useful anchors.

## Verification gates

- Schema/migration (`0041`), API, authorization, audit, conflict and reconciliation tests.
- Shared type checks, app-boundary tests, focused frontend tests and web bundle budget.
- Real local browser verification of the exact PDF, page/layer controls, persisted selection/evidence, state views, measurement provenance, unknown-room overlay, extraction candidates, manual fallback, visual edit to agent retrieval and inspectable proposal flow.
- Independent browser QA, fixes, then independent final acceptance audit. Any unavailable live-model-provider step is reported separately from the verified structured tool/data path.
