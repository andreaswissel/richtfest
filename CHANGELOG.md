# Changelog

## Unreleased

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
- Added Fumadocs documentation behind sign-in and Railway-ready packaging for Postgres, private Bucket direct uploads, and local backup/recovery checks. No deployment was performed.
- Extracted the 24-file local reference project into a reproducible page-level evidence set, retaining duplicate, bundle, and unsupported-format findings without uploading source material.
