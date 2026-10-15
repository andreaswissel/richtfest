# Shared building model V1 implementation plan

Status: implemented scope recorded; local worktree only, with no deployment or production data mutation.

## Outcome

Add a durable project building model and a dense Building model workspace so experts and agents use the same reviewed identities, facts and evidence. The supported V1 includes source-linked topology-v3 extraction: a planner chooses the exact uploaded revision, linked storey and page, reviews room regions, unresolved anchors and construction-fragment assemblies, and corrects or reconciles them before they become shared model objects.

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

- Reference page 3 yielded **91 room candidates: 73 approximate partitions, 3 enclosed regions and 15 unresolved anchors**, with **76 WE-unit associations**. All retain their source labels and inference limits. These results do not guarantee complete room coverage on this or other pages.
- The page's **235 exact normalized construction polygons** form **72 construction-fragment assemblies**. The parser retained them from 355 construction fills, excluding 120 sub-point specks. Compound source fills and supplementary barriers constrain the topology, but do not establish semantic walls.
- **90 printed-area observations** remain unreviewed candidate annotations. Acceptance strips them from canonical geometry; reviewed measurements need separate evidence and review.
- Geodesic partition seams are hypotheses, not physical barriers. Doors, openings, adjacency, materials, construction state, room use and physical measurements remain unresolved. A planner may add supported facts manually with separate evidence and review records.
- Source-document text blocks, their raw-text SHA-256 and PDF optional-content-group metadata remain provenance/display evidence. Text blocks do not become a second semantic inventory, and OCGs affect rendering only; block-to-layer association is unknown.
- Migration `0041_building_extraction` adds durable extraction jobs and candidates. Stable source identities and candidate keys make retries and duplicate clicks safe; leases and at most three attempts bound recovery. Re-running a completed older job upgrades it to topology-v3, preserves reviewed candidates and supersedes obsolete unreviewed hypotheses.
- Extraction itself is local/deterministic and does not require a live model provider or vector index. Agent proposals still require the normal configured provider and permissions; the current building context is a bounded structured snapshot, not embedding or vector retrieval.

Seeded or fixture geometry is not part of the supported V1 workflow. A reference PDF may be used for verification, but its extracted labels remain candidates until reviewed, and manual entry is the fallback when extraction cannot establish useful anchors.

## Verification gates

- Schema/migration (`0041`), API, authorization, audit, conflict and reconciliation tests.
- Shared type checks, app-boundary tests, focused frontend tests and web bundle budget.
- Real local browser verification of the exact PDF, page/layer controls, persisted selection/evidence, state views, measurement provenance, unknown-room overlay, extraction candidates, manual fallback, visual edit to agent retrieval and inspectable proposal flow.
- Independent browser QA, fixes, then independent final acceptance audit. Any unavailable live-model-provider step is reported separately from the verified structured tool/data path.
