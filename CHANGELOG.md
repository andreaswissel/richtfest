# Changelog

## Unreleased

- Acoustic agent preparation is checkpointed for project-data-model integration; deployment remains on hold. Visual crop follow-ups now retain typed, receipt-backed observations alongside earlier extraction without approving calculation inputs.

- Completed acoustic calculation runs can reassess a decision-free input review from saved extraction under the original remaining budget, without rerunning specialists or writing a report.

- Calculation and Report agents now message only agents in the current run family, keeping prior runs out of their discovery and inbox.

- Successive agent clarifications now retain earlier project decisions in order; explicit corrections affect conflicting facts without discarding unrelated constraints. Oversized accumulated guidance is rejected clearly rather than truncated.

- Acoustic agents use RLS-19 within the DIN 18005 planning workflow for road-noise assessment, reserve contour maps for aircraft research, and keep unavailable calculation inputs and other noise-source categories explicit.

- Projects can save source-backed environmental surveys with bounded official Rheinland-Pfalz road, rail, industry and aviation records. The survey preserves dated source receipts and Fraport layer metadata, and checks the site against published noise-contour extents. Flight paths and site-specific noise levels remain explicitly unresolved.

- Uploaded sources now retain reusable page models and PDF layer metadata. Agents can read compact source-backed blocks, while the document inspector shows page coverage, layer visibility and unresolved extraction limits. Existing project evidence can be prepared without AI calls; original files, reviews and reference exclusions remain intact.

- Acoustic extraction keeps large, sparse plan pages together and retains directly printed plan areas as receipt-bound, unreviewed observations; visual mappings and areas remain outside calculation inputs until explicitly approved by a person.

- Acoustic input review shows visual room candidates as partial, unreviewed observations linked to their exact source page and image-inspection receipt, with an on-demand source preview returned only when its rendered image hash still matches that receipt; candidates remain outside the calculation inventory.

- Project Sources now show each file’s purpose, making reference reports and test-only comparisons visibly distinct from agent evidence.

## 2026-10-17

- Building Model: planners can edit any room outline on the plan by dragging, adding and removing points, with the area updating live, or use **Magic select** to detect a room's outline with one click and then edit, confirm or name it as a new room. Every saved outline is logged as training data for plan detection. Existing plans are re-extracted automatically so magic select works on them. Includes database migration 0044.
- Building Model is now a workbench: one toolbar, an outliner of rooms by apartment with show/hide eyes, a tool rail (Select V, Magic select W, Edit points E, Pan H, Measure M), a sectioned properties panel with editable outline points in metres, and a status bar with Accept/Save on Enter. The plan can be panned at any zoom.
- Projects open without the workspace sidebar: a slim project bar keeps the project's views, and **← Projects** leads back to open another project.
- Building model plan parsing splits open-plan rooms (for example a living room and its hall) along straight wall-to-wall lines instead of jagged diagonal seams. Existing plans are re-extracted automatically.
- Building Model: an older plan set can be marked as superseded by a newer one. Its draft storeys, rooms and candidates leave the model and agent context without deleting the file, and it can be restored at any time. Includes database migration 0043.
- The Building Model plan view now draws each detected room as its actual outline instead of a rectangle around it, so L-shaped rooms, notches and door closures are visible where they were extracted.
- Building model plan parsing now reads plans whose walls, partitions and doors are drawn as outlines, as on the Bendenweg approval plans: outlined partitions bound rooms, door arcs drawn as many short lines are recognised so doorways close, and beds, kitchens and other furniture cut out of the floor fill count as room area instead of carving notches into rooms. Existing plans are re-extracted automatically.
- Building model plan parsing now handles doors and non-rectangular rooms. Openings between wall ends, including doors marked only by their swing arc, are closed so rooms no longer leak into each other or outdoors through windows. L-shaped rooms and corridors, curved walls and merged CAD wall fills are traced, and each room records which rooms its doors connect to (unreviewed). Room-label recognition covers more German names, and OCR labels show their source. Existing plans are re-extracted automatically whenever the parser improves, one page at a time while no new uploads are waiting; accepted and rejected candidates are kept. Plan parsing now runs in a background thread so large sheets no longer slow down the app.
- Building model processing fixes: deleting a plan PDF no longer fails; sections that mention a floor plan are no longer treated as floor plans; automatic processing applies only to newly uploaded project-evidence PDFs, with no backfill of older sources; repeatedly failing sources stop with a visible failed state; re-extracted geometry fences stale reviews; agent links open the linked object's own plan page; and agents see automatic draft storeys as unreviewed. Includes database migration 0042.

## 2026-10-16

- Building model now opens the strongest identified floor-plan page instead of an arbitrary report cover, including for older automatically generated links. Projects with several PDFs provide an explicit source-PDF selector, and deliberate source or page choices remain fixed in shareable links.
- Building-model source PDFs now render through an authorized same-origin stream in production, avoiding private-bucket browser CORS failures while preserving signed redirects for explicit file downloads.
- Building-model plan overlays now preserve exact source geometry at every zoom. Labels, strokes and selection emphasis stay screen-sized, thin candidates keep a separate practical hit target, and selecting one candidate subdues unrelated overlays for source-plan review. Existing and Demolition views now disclose source-scoped hidden wall hypotheses and link directly to their Proposed-state review; the dedicated wall toggle and inspector keep PDF-relative geometry evidence distinct from unknown physical thickness and material. Technical source identifiers remain readable in narrow inspector layouts instead of collapsing into a one-character column. The review surface now opens directly into a plan-first workbench with compact source context, separate object and display-control tabs, independent panel scrolling and responsive canvas-first ordering.
- Automatic Building-model extraction now keeps construction, existing and demolition fills as separate evidence instead of merging them into one barrier map. Topology-v5 assigns rooms within apartment domains using printed-area capacity checks, recognizes Garderobe labels and closes only source-supported, doorway-sized gaps between collinear wall fragments for segmentation so room proposals do not escape through a portal. It also records conservative rectilinear shape-quality metrics and demotes severe tendrils or concavities instead of presenting them as spatial rooms, while retaining ordinary L-shaped rooms. Inferred closures and shape checks remain unreviewed evidence and never become wall, door or surveyed-boundary claims. Proposed wall and assembly candidates no longer appear in the Existing or Demolition views, construction assemblies start hidden, and automatic upgrades or explicit re-runs reuse the page's job while refreshing stale unreviewed geometry without changing accepted or rejected work. On reference page 2, 73 of 87 room labels receive spatial proposals across WE1–WE11 and 14 remain honest unresolved anchors. All results remain unreviewed; no physical scale, material, opening, continuity or completeness is claimed. Migration 0041 remains sufficient; no additional migration is required.

## 2026-10-15

- Project editors can now delete files from Resources or the document preview, with a confirmation covering every version. Deletion removes the stored files and extracted data, preserves conversations and reports, and records an audit event.

- Acoustic extraction keeps sparse plan drawings together with bounded, page-aware packets and stable source-backed room identities. Typed input choices and exact quotation recovery reduce avoidable retries without losing source text or accepting unsupported evidence; explicit numerical inputs remain available while other decisions await clarification.
- Blocked acoustic workflows assess independent progress once, ask focused questions and automatically save available room calculations as an unapproved partial sheet. Saving later answers advances the calculation without another extraction run or an extra Calculate action; unresolved rooms and engineering-release requirements remain visible.
- Agent replies now validate the recipient and original message before accepting a model response. Misaddressed replies get corrective feedback instead of stopping a calculation with a misleading project-access error; delivery permissions remain unchanged.
- Acoustic extraction now selects only source-version IDs supplied in its packet. Correction attempts distinguish invalid room references, duplicate rooms and non-verbatim quotations without exposing rejected source text or relaxing evidence checks.
- Combined calculation inputs now retain up to 1,000 room identifiers across source packets, while each extraction packet stays limited to 100. Missing inputs and unmatched room identities remain explicit rather than crashing aggregation or being silently merged.
- Agent cost displays now include known settled charges from interrupted calls without double counting later totals. Partial costs stay visibly incomplete; reservations are not charges.
- Calculation-sheet PDFs now include an ARC-inspired room overview and calculation details, plus a two-page numerical Prüfbericht highlighting blockers, shortfalls and low reserves. Sources, scenario notes and every declared room remain traceable; engineering rules and approval requirements are unchanged.

- Exterior-noise workflows now pause before further AI work when room calculations are blocked, including runs outside chat. Saved reasons distinguish incomplete inputs from calculated results below target; explicitly requested model-free sheets can still show unsupported-room outcomes.

- Acoustic extraction failures now retain safe field-level diagnostics for correction attempts, including larger room-fact packets and nested source references. Validation rules, models and spending/retry allowances remain unchanged; no run restarts automatically.

- Project chat now proposes the right outcome directly in the conversation instead of requiring a mode switch. Calculation sheets are distinct from full reports; unclear requests ask for a choice. Confirm the outcome and cost allowance before work starts, with saved proposals protected against duplicate starts.

- Added opt-in Jev image triage for new project-source uploads and agent questions. Revision-linked labels and suggested regions are reused without sending image pixels to the calling model; direct visual inspection, evidence checks and human review remain available and separate. Disabled by default, with no automatic backfill or database migration.

- Acoustic workflows now combine room data across documents and clarify missing or conflicting values directly in chat. Rounded choices, plain-language questions and expandable sources keep the form simple. Answers are saved with their history; confirmed inputs produce a draft calculation sheet without another AI call. New runs wait for missing inputs before report writing; existing checkpoints keep their behavior.

- Landing-page images, icons and share previews now load correctly on the main website as well as the preview URL.

- Agent activity now uses compact, expandable Trace rows in conversations and run threads. Current tasks, queued work and unreviewed findings stay readable, with timestamped history and failure details on demand. Agent execution, source links and approvals are unchanged.

- Project conversations can request a calculation-only Schallschutznachweis or select a full concept format. New exterior-noise workflows extract source-backed room inputs, automatically calculate every declared room, and save a result or blocker without optional agent arithmetic calls. Calculation sheets skip report writing and editorial passes; configured independent review and human release remain separate.
- Added an offline room-by-room exterior-noise reference comparison and deterministic room tables with calculation details. Missing inputs and conflicting evidence stay visible; matching a reference does not grant compliance approval. Existing runs keep their saved behavior; no paid run starts automatically.
- Approved room-input revisions can now serve as the basis for calculation scenarios. Planners adjust numeric inputs and save a new draft without AI calls or repeated source extraction; original inputs, change reasons, source versions and review boundaries remain traceable.

- Reports can use a separate writing model without changing their reviewers. Independent checks now distinguish omitted packet sections from missing chapters and no longer demand that assembled reports fit a single-response length limit. Existing runs keep their model settings; no paid run starts automatically.

- Astra report calls now cache shared context separately from changing writing packets, without reducing evidence or review checks. Patch editing no longer receives the unrelated component catalogue. Cache-write costs are included in new call estimates and reservations; actual savings depend on provider reuse. No paid run restarts automatically.

- Astra visual-review reservations now account for images without treating their encoded data and duplicate SDK metadata as report text. Evidence, image quality, models and review checks stay unchanged; numeric admission diagnostics explain future stops. This corrects reserved estimates, not past charges, and starts no paid run automatically.

## 2026-10-14

- Acoustic report editing now groups changes instead of rewriting unchanged prose, retaining saved work and independent checks for changed evidence. Edit recovery retains rejected wording alongside review feedback and rechecks changed repairs; editors distinguish missing visual receipts from contradictory evidence. Model calls reserve one actual step at a time, preserving earlier spend and cancellation safeguards without raising budgets, changing models or automatically restarting stopped runs.

- Acoustic reports now consolidate repeated fragments with a separate preservation check, retaining source associations and exact visual-inspection limits. Large unfinished narrative batches also use smaller, lossless writing packets; retries retain completed pieces without raising the spending cap. Source registers use a bounded inventory-writing contract for document dates, revisions and coverage limits, without repeating technical assessments or discarding source text. Assumption-only calculated results without source provenance stay out of report tables without changing the ledger; PDF export shares only byte-identical source files' matching pages with provenance cross-references. Start a fresh Report to apply prose changes to a completed report; existing drafts stay unchanged.

- Report “Save as PDF” downloads the selected revision directly, including its original attachments. PDFs now prepare in the background when reports are saved and are reused for fast downloads, with fresh approval/revision labels and source checks. Older reports prepare when opened; a first download may still wait. No new agent run is needed.

- Large acoustic reports now save and verify final edits in smaller pieces, subdividing unfinished edits instead of repeating requests that exceed the output limit. Retries reuse completed edits and all drafted sections; calculation appendices stay unchanged and no longer consume editing context. Editors receive the exact section format and specific repair feedback for incomplete output or missing references. Spending limits and timeouts are unchanged.

- Calculation appendices now render saved arithmetic directly, keeping exact inputs, results and review limits. Imported evidence uses smaller, saved writing packets and a lower output allowance; retries retain completed report pieces without raising spending limits or changing models.

- Restored the full automated test suite with current invitation, agent recovery and source-evidence expectations. Repeated API checks no longer offboard shared demo users or share authentication rate-limit counters; application behavior is unchanged.

- Parallel agent calls now wait for temporary spending reservations instead of failing, with exact waiting and stop reasons in activity and recovery previews. Unfinished report Open issues reuse saved specialist findings; outstanding visual checks remain explicit in the report without becoming unsupported section citations. Saved work and spending limits are preserved.

- Agent recovery now previews saved work and requires confirmation of additional spending from both the conversation and run details. Shared spend/retry guards and explicit interrupted-attempt records prevent silent replacement calls; source inspection reserves a final answer step, and report citation feedback avoids unnecessary retries without weakening evidence checks.

- Project chat now has a compact composer with attachments and optional effort/mode settings. Recommendations appear in the conversation and still require Apply then Send for Team or Report. Mobile chat puts threads, project sections, resources and workspace navigation into one hamburger menu, leaving room for the conversation. Agent execution is unchanged.

- Agent calls now stop waiting when their deadline expires or cancellation is requested, even if the provider stream stays open. Deferred visual reads are recorded and continued within the existing revision allowance without redoing completed findings; any remaining inspection gaps stay explicit instead of being called unreadable sources.

## 2026-10-13

- Reports now start from a goal and project evidence without requiring a template or attachments. File-purpose controls keep reference reports and comparison-only material out of agent evidence while preserving originals and human previews. Fresh Reports exclude earlier conversation answers and document-comment excerpts; existing reports remain unchanged.

- Affinity originals can now be linked to a confirmed full PDF export at exact revisions. Agents can select and cite that PDF without confusing it with a cover preview; new revisions never inherit links or approval. Stale historical attempt records were reconciled without deleting run history or inventing missing usage.

- Project agents can inspect exact source pages and crops, index documents in smaller batches, and draft independent report sections in parallel. Failed source processing can be recovered without re-uploading or changing versions, citations or reviews. Processing diagnostics and retry checkpoints preserve clear limits; visual observations remain unreviewed.

- Project agents now default to Suggest: Jev checks the mode on Send, with Chat as the safe fallback for search and questions. Team and Report recommendations require Apply and Send; explicit modes skip the check, and typing never triggers paid inference. Report creation requires a template and selected sources. Opted-in Jev knowledge ranking also works in direct Chat runs.

- Main and specialist chats now follow new output at the bottom, preserve your place while reading or selecting transcript text, and resume following with Latest. Unrelated text selections and keypresses no longer pause the chat.

- Failed agent calls now show the provider’s redacted reason, error code, parameter and request ID, including billing and schema failures. Saved run diagnostics and correlated server logs cover supervisor, direct and Jev calls without retaining raw errors or credentials. Fixed OpenAI rejecting the company-search tool schema; Unicode search-term validation remains enforced by the application.

- Project resource tabs now have comfortable horizontal padding in both Dense and Normal display modes. Workspace tabs keep a consistent font weight so switching tabs no longer shifts neighboring labels.

- Added opt-in TypeSafe Jev summary routing and supervised company-knowledge reranking, with safe fallbacks, explicit credential setup and tracked usage. Reviews and approvals remain unchanged; neither option promises lower total cost.

- Acoustic concepts now consolidate the assembled report and separately check that evidence is preserved before optional source review and publication. Progress shows both stages; retries retain saved edits and checks without changing calculation appendices or original attachments.

- Agents can discover company-knowledge categories, search within a folder or unfiled entries, and retain category, source and chapter labels alongside approved references. Search stays private and approval-aware without embeddings or extra AI search calls.

- Agent messages now explicitly support “no reply target” in strict provider responses, avoiding forced reply IDs for new messages while preserving reply validation and duplicate-delivery protection.

- Company knowledge now opens with a question bar and follow-up chat. Its compact library groups source and chapter beneath each title, keeps selection actions in a floating bar, and supports confirmed, audited bulk approval. A controlled organization pass can categorize the imported Baukosten training entries without changing their original content or approvals.

- Agent reviews now group evidence by model capacity instead of small file batches and avoid duplicate report input, reducing repeated work and cost. Retries preserve completed reviews and unresolved findings.

- Specialist agents can search company knowledge concurrently without blocking each other's searches. Search limits, approval checks and cancellation safeguards remain in place.

- Purely visual changes can deploy after verification without separate approval; functional and mixed changes still require an explicit deployment request.

- Project agents can search approved company knowledge on demand. Retrieved excerpts and entry references stay with their findings through report drafting and review, separate from project evidence; retries recheck approval and changed content.

- Project resource navigation is back at the top of the right sidebar, with tabs for Artifacts, Shared work, Agents and Sources. The left rail is dedicated to active and archived threads.

- Component catalog rows are clickable across all columns, with keyboard access and standard open-in-new-tab behavior.

- Archiving and restoring threads no longer keeps the action busy while the workspace refreshes after a successful save.

- Added a tenant-private Components catalog with four supplier-reference starter records, a compact side inspector, an import dialog, revision history and human catalog review. Full records pair private original supplier PDFs with source-linked facts and review, including exact-page citations and a Facts/Document switch on narrow screens. Explicit matching-PDF uploads preserve revision and review decisions. Agents use only current reviewed matches and retain source conditions and warnings; engineering approval and commercial-offer comparison remain separate.

- Company knowledge can be organized into categories and searched with natural-language questions. Answers include linked source excerpts and review badges; private search history is saved, and categories never change approval or agent assignments. AI search requires a configured provider.

- Shared work now uses compact task rows with expandable instructions, readable review statuses and a single header. Completed and cancelled tasks stay accessible without dominating the list.

- Chat scrollbars now blend into light and dark themes instead of showing a bright track in dark mode.

- Specialist agents now retry invalid source citations with targeted correction feedback while preserving completed work. Failed calls retain safe, inspectable diagnostic records, including rejected source identifiers, without saving raw provider errors or rejected text.

- Team administrators can create and edit workspace roles, choose their permissions and assign them to members or invitations. Changes apply to everyone with that role, with audit history and protection against removing the last administrator.

- Account settings no longer hide password setup when an older session needs renewed sign-in. Session management now shows a clear sign-in prompt, and authentication errors return usable messages instead of server errors.

- Sound-insulation agents can use five deterministic tools for sound levels, single-band sound reduction and room-based exterior-noise targets and façade screening. Results keep inputs, sources or assumptions, formulas and review status; incomplete or unsupported exterior-noise cases return a blocking reason rather than a number. These are reviewable calculations, not certified engineering verification.

- Company knowledge now has a searchable review screen with draft and approved filters, source caveats, direct links and explicit approval. Imported training knowledge stays unapproved until a permitted reviewer confirms it; agent assignments remain separate.

- Project agents can exchange questions and findings across threads in the same project. Messages appear in both chats with linked sender and recipient names, including late arrivals; delivery never interrupts or automatically restarts an agent.

- Specialist source reviews now use larger, model-aware batches and fill available parallel slots immediately instead of waiting for the slowest specialist. Retries preserve saved findings and historical batch layouts; output limits and review safeguards remain unchanged.

- Downloaded reports now carry Richtfest branding on generated pages, with clear revision and review status. Imported plans and calculation pages keep their original artwork and unverified-source labels. Existing reports can be downloaded again without rerunning the agent.

- Acoustic reports now use larger, model-aware source batches and parallel drafting instead of many tiny sequential requests. New outlines avoid duplicate page coverage, incomplete large batches fall back to smaller saved pieces, and retries preserve completed work. Output-token limits and review safeguards remain unchanged.

- Acoustic concept reports now treat section length as a writing target instead of failing on character counts. Complete text, tables and citations are preserved; Retry run resumes saved work after older character-limit failures. Token limits and review safeguards remain unchanged.

- Agent runs now retain structured intermediate results and tool receipts. Retry reuses saved work without duplicating drafts or questions; Run again starts fresh. Saved inputs, outputs and review links provide a foundation for future training datasets.

## 2026-10-12

- Acoustic reports assembled from saved sections can now exceed the per-response character limit without losing content. Retrying an older combined-report limit failure resumes saved work instead of starting over; model limits and review requirements stay unchanged.

- Added an opt-in public-data catalogue with scheduled Berlin building/tree imports, retained source evidence and version-pinned project context. Projects can inspect provenance and import health, then explicitly confirm adoption of newer releases. Failed refreshes preserve context, planning objects and notes.

- Short acknowledgements such as “thanks” or “danke” now stay in project chat without starting a new agent run or redirecting an active one. Follow-up requests and attached sources still trigger agent work.

- App updates now retain older frontend files so open tabs can load account security and other deferred screens without a forced reload. New releases verify file retention before accepting traffic; authentication load failures keep their underlying browser error available for diagnosis.

- Retrying a timed-out project agent now resumes saved specialist work, report sections and review progress instead of starting over. Existing failed runs can resume too; model settings and approval requirements stay unchanged.

- Acoustic concepts now enforce the requested template, read complete saved PDF evidence and write resumable sections. PDF exports include numbered contents and original plan/calculation pages as unverified sources. Token truncation and document-size limits stop incomplete reports and show distinct recovery guidance.

- Project threads now have their own artifact previews, tasks and run links. Open documents and PDFs directly from chat, and review generated documents with persistent passage highlights and revision-specific comments that carry into continuing agent work.

- Missing app files after an update now show a reload prompt instead of crashing the conversation. Unsent text stays accessible, Markdown remains readable as plain text, and reloading requires confirmation. Failed page loads also offer recovery within the app.

- Rate-limited project agents now wait for provider cooldowns across worker restarts, distinguish reported quota failures from throttling, and resume saved drafts, specialist work and independent-review progress when retried. Unclassified older 429 errors remain explicitly uncertain.

- Agent progress now names the sources and revisions being reviewed, shows batch progress and saved findings marked as unreviewed, and updates in place as specialists work. The full timestamped history and retry details stay available on expansion.

- Project agents can read text in PNG, JPEG, WebP and BMP images and use configured visual interpretation for text-free diagrams. Affinity Publisher files contribute embedded-preview evidence only, clearly distinguished from a full document; visual inferences remain unreviewed and full Publisher reading still requires a PDF export.

- Open tabs now show “New updates available” above the profile in the navigation rail when a different app build is available. Click to reload when ready; deployments no longer need a manual refresh to discover updates.

- Corrected release-note dates for shipped updates and made dated changelog sections a required deployment step.

- Agent runs in different threads now start independently when capacity is available, rather than waiting for an entire batch to finish. The existing three-run limit per worker remains in place.

- Projects now have an Analytics tab for exploring agent-run costs, including all subagents, with project-wide token and cost totals, usage by model, and average tokens per fully measured run. Partial or missing data is clearly marked, and older runs remain browsable.

- Agent usage recording now retries received token counts during error recovery if their first save fails, instead of treating an unsuccessful save as recorded. Historical or unreported usage remains explicitly unavailable.

- Added Innenlärm and Außenlärm concept draft formats based on the completed reference reports, with distinct sections, project details, tables and source-linked plan/calculation inventories. Existing acoustic reviews keep their default format. These are draft structures, not new calculations or replicas of the original page design; template uploads in agent settings remain planned.

- Agent model settings now expose summary, rationale and document character limits plus a per-call timeout for each effort preset. New runs use saved limits; existing runs keep their original settings. Timeout failures point to the setting instead of a generic connection error.

- The 3D location editor now supports Rheinland-Pfalz addresses, including Alzey, using official building footprints and heights. Scenes from a different address are preserved but hidden by default. Unavailable trees, terrain and LiDAR are clearly identified.

- Account settings offers a single recovery message with Reload app for unavailable sign-in code or Try again for failed security details. Failed passkey loads no longer appear as an empty list, and unavailable security actions stay disabled.

- Aligned agent model settings and optional specialist controls across screen sizes and density modes. Role settings now explain that blank instructions retain built-in behavior.

- Agent model settings use one compact role table with inline controls, stable rows for optional specialists, grouped execution limits and a direct connection-settings link. Enabling a specialist no longer inserts a form or shifts the page.

- Docs now builds its changelog directly from the shared release notes, avoiding a separate copy. Commit guidelines require release notes and affected documentation alongside each completed change.

- Added opt-in sound-insulation, construction-law and cost-options specialists with separate models and role guidance. Sound-insulation reviews use a consistent German/English document template with revision-linked room/component references in preview and PDF. Existing presets stay unchanged; engineering calculations and compliance approval remain unavailable.

- Project sources are processed once per revision and reused from saved text and structured, source-linked facts. IFC properties and declared quantities import without AI; documents use one bounded structuring pass when configured. Conflicting claims and human reviews remain separate, and agents reuse saved evidence instead of repeatedly investigating originals.

- Project details now offer searchable address selection with Geoapify, retaining the selected coordinates and source attribution. Manual entry remains available for missing addresses or unconfigured search; manual edits clear old search metadata without moving existing 3D scenes.

- Project specialists read large source sets in smaller, checkpointed batches without dropping extracted text. Evidence and synthesis calls have more time to finish; timeouts now stop unchanged retries and show specific guidance instead of suggesting a token increase or connection repair.

## 2026-10-10

- Added a full-width project 3D location editor using addresses saved in project details: official Berlin building/tree context, on-demand 2021 LiDAR where covered, versioned IFC overlays, editable vehicle envelopes, massing and planning notes. Address changes never move existing scenes. Architectural lighting, shadows and clearer materials improve depth. Switch trees between schematic markers and illustrative foliage; measurements use schematic trees. Survey, alignment and illustrative-geometry limits stay explicit; this is not fire-access certification. Conversation and other app pages now use the full available width.

- Project threads use a first-message title if AI naming is unavailable, and older numbered threads recover their titles when reopened. Manual names are preserved.

- Keep the mobile app at 100% scale with page-zoom gestures disabled and touch scrolling preserved; use readable 16px form text on mobile to avoid focus-triggered zoom, and fix sign-in content overflowing narrow screens.

- Added an opt-in local demo project with PDF sources, concept revisions and agent failure scenarios for portal testing; repeat seeding preserves edits and settings without live model calls.

- Project agents produce a separate formatted draft document with named source versions and readable Unicode PDFs. Chat explains character-limit versus token-limit failures; confirmed token truncation offers Yes / No / Describe, with an administrator-approved increase for new runs only. Automatic retries now tell the agent which output rules failed and ask it to shorten overlong summaries rather than repeating the same request unchanged.

- Project agents read PDFs beyond page ten, with German/English OCR for scanned pages, original page references and explicit extraction limits. Failed provider attempts retain safe diagnostic details and reported token usage for troubleshooting.

- Project agent runs record per-call settings, retries and reported usage, including failures without usage. Human reviews can optionally score the original generated outcome and rework needed, with notes retained for approval and rejection; scores do not approve artifacts or validate engineering results.

- Subagents now show their own token usage and estimated cost in run lists and details, while the supervisor keeps the combined total. Previously recorded costs remain unchanged.

- Removed the redundant outer circle around callout icons.

- Added reusable orb setup with the pinned toolchain, cached dependencies, local test database, PDF/OCR tools and supervised development services.

- Serve the public landing page on `richtfest.ai` while preserving existing domain aliases; use `app.richtfest.ai` for the app.

- Project agent runs retry temporary provider failures and invalid responses, including truncated and schema-invalid Mastra responses, with up to three attempts instead of treating them as connection failures. Failed runs show a clear outcome with run details and a retry action. Completed reviews now include a downloadable PDF attachment in the conversation for the exact saved artifact revision.

- Project conversations render assistant Markdown with readable headings, lists, tables and code while keeping user messages literal.

- Omit unset conversation message IDs from read-state saves, and save reading positions only for persisted messages, preventing composer draft-save errors on empty threads and temporary agent-run rows.

- Specialist source reviews now receive citation IDs only for readable source text, while unreadable assigned files remain visible as coverage gaps.

- Added Help & feedback in navigation: just type to ask about Richtfest, request a feature or report a bug, with OpenUI answers, reviewed submissions, and a workspace-scoped JSON queue that Amp can retrieve after sign-in.

- Recheck server messages whenever a project conversation is reopened, so newly saved agent answers do not stay hidden behind a fresh client cache.

- Invite users with their name; pending invitations show each person’s name and email.

- Serve the public Richtfest landing page from the Railway service, with a preview URL while the custom domain is being activated.

- Project agent failures and cancellations now show recorded reasons in run details and sub-agent lists, including why child runs stopped when their supervisor failed. Older runs with only a generic error are labeled as having no specific recorded reason.

- Start a project chat thread by writing and sending the first message in the workspace.

- Supervisor workers now advance queued project runs through persisted Mastra workflow checkpoints provisioned by the standard application migration; worker startup, polling failures and per-run execution failures are visible in API logs with run context.
- Project status is selected from translated Planning, Active and Completed options.
- Project agent conversations distinguish queued runs from active work while keeping the crane visible in a waiting pose; running work shows live activity, source and specialist links, and a shimmering current-task line.
- Project run details distinguish worker queue wait, supervisor phase and provider-call duration while work is active.
- While a project agent run is active, the empty composer send control becomes Stop; typing a message restores Send.
- Project message action links now share the same hover treatment as adjacent buttons.
- Project chat steers only queued or running agent work; messages after a run finishes start a fresh run.
- Copy your own project chat messages with a compact button.
- Project details now edit inline on the page, with Save and Cancel actions.
- Split Settings into navigable sections for AI connections, agent model settings, agents and account settings.
- Agent model settings accept output caps up to GPT-6's 128,000-token output limit.
- Project agent work groups active and done runs, shows live runtime and per-agent token usage, and estimates cost where model pricing is known.
- Project thread hover highlights now span the row behind rename and archive actions.
- Local development can sign in with seeded test identities when the non-production `ALLOW_DEV_AUTH` flag is enabled.
- Agent model presets can opt into a separate independent source review before a draft is saved; it remains off by default.

- Project agents now assign source reviews for file-based work and distinguish readable unreviewed sources from findings awaiting human review.

- Added a Docs changelog page with the current release history in the Docs sidebar.

- Moved “Back to projects” into the app header while viewing a project.

- Project details can now be edited, including the name, customer and status; the status badge sits beside the project title.

- Project threads show a small accent dot for unread messages and clear it after you reach the latest message.

- Added an animated crane below the latest chat response to show when project agents are working.

- Users can rename project threads manually from the thread list.

- Project threads receive a concise model-generated title after their first message, using the active provider's economical model.
- Added Agent controls for workspace role instructions, routing hints and approved company knowledge; each supervisor run keeps the guidance it started with.

- Project workspace can show an embedded visual preview for Affinity Publisher files while keeping the original download available.

- Project agents can discover the latest ready source files from a bounded project inventory and review exact versions without requiring them to be attached first.

- Kept the project message send button in place while the draft save status changes.

- Send project workspace messages with Enter; use Shift+Enter for a new line.

- Changed saved agent model settings confirmation to a compact neutral status badge.

- Clarified saved AI credentials in Settings with a masked key placeholder and a quieter saved status.

- Added editable customer company/contact details, addresses and separate billing details, including invoice email, tax IDs, payment terms and one-click address copying. Existing customers can keep these fields empty.

- Project chat now clearly warns when agent replies are unavailable, confirms that sent messages were saved, and links to AI connection settings.

- Added provider-backed model selectors to agent model settings, with GPT 6 and Claude Opus 5.5 / Sonnet 5.5 models surfaced first.

- Refresh now shows workspace navigation immediately instead of a full-screen loading splash; protected content waits for session verification, and connection failures offer retry without losing the shell.

- Added branded social link previews with a construction illustration, clear title and description; private project details stay out of shared previews.

- Added safe first-administrator provisioning for a new production workspace and corrected the sign-in email-delivery status for configured Resend accounts.

- Refreshed sign-in emails with Richtfest branding, a clear sign-in button and plain-text fallback. Sign-in now offers a reload action when an old tab cannot load its code after deployment.

- Reduced the deployment image size and separated the typecheck, web and docs build stages for parallel builds and better caching. A pinned mirror of the same Bun image avoids Docker Hub rate limits. Production routing now uses the same port as the API.

- Defined the Railway project in code (`.railway/railway.ts`): one `richtfest-monorepo` service built from the Dockerfile, Postgres and the private file bucket in EU West. This replaces the deprecated `railway.json` and avoids Railway's per-package monorepo import. The production image now installs dependencies the same way as local development, which fixes the failing web typecheck in the Docker build.

- Project sources support selecting and uploading multiple files in one action, with per-file progress and failure results; browser uploads use a private bucket policy scoped to the app origin.

- Added a saved light and dark appearance preference in Account settings.

- Refined the overview metrics, project table sorting controls, and passive empty states for a calmer dashboard.

- Replaced the project conversation selector with a thread rail, including durable archive and restore actions that preserve messages and agent work.

- Added Vercel AI Gateway credentials and workspace provider selection in Settings; project agent controls now use the selected provider and expose only effort controls.

- Moved language and density preferences into Account settings, removed duplicate shell controls, and made the sidebar profile open account settings.

- Made email-link sign-in the primary login workflow, with password and explicit passkey actions as secondary fallbacks and lifecycle-safe browser passkey autofill.

- Simplified project chat with a quieter composer, circular send control, on-demand search, contextual message actions and no repeated agent labels. Jump to latest now disappears at the bottom. Supervisor results include saved artifact previews that open the exact revision for review. Subagents appear as named status rows that open focused threads for their assignments and results. Shared work uses compact conversation and agent lists, with clear links and details on demand.

- Added an opt-in Mastra supervisor for project chats: durable specialist assignments, restart recovery, follow-up steering, cancellation and human review. Workspace admins configure model presets; users choose effort through existing Richtfest controls. Added the runtime architecture diagram and setup guide to Docs.
- Added the chat-first project workspace with durable conversations and reader position, exact document revisions and annotations, streamed provider runs, visible source-review delegation, and an explicit review action that publishes the exact artifact revision as a source-linked reviewed finding. Generated OpenUI is restricted to the registered Richtfest component library, while engineering calculations remain unavailable until a validated deterministic tool exists.
- Applied the approved shadcn/ui `b6F9Mslb0` preset across the workspace, with neutral surfaces, indigo actions, Inter typography, Lucide icons, and reusable dense/normal controls; language and density preferences persist per user.
- Added the persisted project-onboarding workflow: customers, projects, direct file attachment and download, shared conversations and tasks, source-linked knowledge review, and tenant-scoped activity history.
- Added invite-only accounts with magic-link entry, password and passkey enrollment, secure sessions, role management, offboarding, and a development-only email outbox when Resend is not configured.
- Added encrypted personal and workspace AI connection settings with an explicit provider choice and an honest unavailable-execution state.
- Added Fumadocs documentation behind sign-in and Railway-ready packaging for Postgres, private Bucket direct uploads, and local backup/recovery checks.
- Extracted the 24-file local reference project into a reproducible page-level evidence set, retaining duplicate, bundle, and unsupported-format findings without uploading source material.
