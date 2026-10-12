# Changelog

## Unreleased

## 2026-10-13

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
