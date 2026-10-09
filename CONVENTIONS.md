---
title: Conventions
description: The rules every change follows, from API responses to audit events and translations.
---

## Richtfest Apps

- A business capability with its own workflow, tables or `<app>:*` permissions is a Richtfest App in `richtfest-apps/<app>`,
  never a folder inside the API. Richtfest OS holds only the platform (sign-in, access, audit, connections, realtime,
  agent runtime, app shell).
- Apps reach Richtfest OS only through their host contract (`src/deps.ts`); extend the contract instead of importing OS
  code. See the Fumadocs architecture guide and `boundaries.test.ts`.

## API

- Every response uses the `{ data, error, message }` envelope from `@richtfest/shared` (`ok(data)` / `fail(code, message)`).
  Unknown routes and thrown errors already return it.
- Validate input with **Zod**. A thrown `ZodError` becomes a 400 `validation_error`.
- Every `/api` route needs a session and `richtfest-os:use`, except health, the public auth endpoints, the Slack webhook,
  and `/api/auth/me` plus `/api/access/check` (session only). Guard capabilities with `kit.requirePermission("<app>:<capability>")`.
- Shared domain types and schemas live in `@richtfest/shared`.

## Data

- **Durable state belongs in Postgres.** Do not use localStorage, module memory or browser-only state for threads,
  workflow state, sync checkpoints or other operational records.
- **Every write records an audit event** in the same transaction (`recordAudit`).
- Schema changes go through Drizzle migrations (`bun run db:generate` in `richtfest-os/apps/api`). Migrations run
  automatically before each deploy.
- For integrations and imports: know the authoritative system, make imports idempotent, store source references,
  and track sync state.

## Source evidence and agent governance

- Preserve original files and immutable revisions in private Railway Buckets; keep metadata, ownership and processing state in Postgres. Stream uploads or use authorized direct bucket uploads, without an arbitrary application-level size cap for the prototype. Never treat a filename-only record as an uploaded file.
- Retain source and version references for extracted facts, knowledge and calculation inputs. Flag missing/conflicting values rather than silently inventing them.
- Validate every referenced customer, project, conversation, source file and assignee against the actor's accessible scope, including on writes.
- Audit business/security changes with actor identity and type, entity IDs, timestamps and run/correlation IDs. Record safe summaries; never credentials or hidden chain-of-thought.
- Agent runs retain the request, source versions, tool actions/results, concise decision rationale, policy/approval decisions and outcome. Authorize tool actions independently of model suggestions.
- Use the same audit records for contextual activity, filtered by entity, event type and access. Paginate the detailed audit view; do not expose the full event stream on every screen.
- Persist processing state and failures. Show genuine queued, running, review-needed and terminal states; retries must correspond to implemented work, not simulated execution.

## Access

- Permission keys are `<app>:<capability>` and live in `richtfest-shared/src/auth.ts`. Roles are data.
- New dashboards, tabs and subviews inherit their parent screen's access. Add a dedicated permission only for a real
  access boundary.

- Invitations and first access use expiring, single-use magic links delivered through Resend. Passwords and passkeys are optional subsequent enrollment methods; Google is not required for this prototype.
- Offboarding invalidates sessions and outstanding invitations. Agent access is bounded by the initiating actor and workspace permissions.
- AI credentials are encrypted server-side, scoped to a workspace or a user, and never returned raw. Only admins manage workspace keys; each user manages their own. For an explicitly selected provider, personal credentials take precedence over workspace credentials.
- Credential presence and executable integration readiness are different states. Missing encryption or delivery configuration must fail closed and must not claim a successful run or email.

## Web

- Maintain shared shadcn/ui primitives and Richtfest semantic components in the web app's design system. Add or extend the shared component before adding a screen-specific control.
- Use official shadcn/ui preset `b6F9Mslb0`. Preserve its generated theme and component styling; apply Dense/Normal sizing through shared tokens. The full preset configuration is documented in the design-system guide.
- Verify visible UI through `@Browser` browser automation. Do not use native Safari/computer-use automation for browser testing.

- **Server state** lives in TanStack Query. **Zustand** is for local UI state only.
- **New screens** register in `richtfest-os/apps/web/src/routes-manifest.ts` with their sidebar section (`group`: the Richtfest
  App they belong to, or `richtfest-os`). The router, the sidebar and the perf bench all read it.
- **Translations:** every UI string goes into both `src/locales/en.json` and `src/locales/de.json`.
- **Dense, keyboard-friendly UI:** compact tables, clickable rows, predictable tab order, no card-in-card layouts.
- **Density tokens, not raw sizes:** users pick Dense (Richtfest's compact sizing) or Normal (stock shadcn Nova sizing),
  applied as `data-density` on `<html>`. Size text, controls and icons with the tokens from `src/index.css` so both
  modes work: `text-ui` (body), `text-ui-sm` (content, controls), `text-ui-xs` / `text-ui-2xs` (labels, badges),
  `text-ui-lg` (headings), `h-control` / `h-control-sm` (inputs, buttons, rows), `size-icon` / `size-icon-sm`,
  `py-cell` (table cells). Raw `text-xs`, `text-[11px]`, `h-7` or `size-3.5` stay fixed in Normal mode.
- **Screen layout:** build screens from `Page`, `PageHeader` and `Section` in `components/layout.tsx`. The header has
  the title and primary actions on row 1 and filters plus list meta on row 2. Spacing comes from `p-page`,
  `gap-section` (between blocks) and `gap-stack` (inside a block); avoid one-off `space-y-*` values and half steps.
  Tables use `Table` from `components/ui/table.tsx` (bordered container, sentence-case headers, one cell text size);
  one main column takes `w-full` and the rest stay at content width.
- **Tables are sortable by default:** every `TableHead` with a text label is a sort button (ascending → descending →
  unsorted), and `TableBody` reorders its rows by what that column shows: numbers (incl. money and German/English
  separators) numerically, text naturally and case-insensitively, empty cells last. Rows must be direct, keyed
  children of `TableBody` with one `<tr>` each. When the shown text doesn't sort (dates, "5m ago", durations, enum
  labels such as priority), pass `sortValue` on the `TableCell` (ISO date, number; `null` sorts as empty).
  Virtualized tables and tables with j/k cursors or Shift-range selection sort their data instead, so keyboard order
  matches the screen: `useTableSort(items, accessors)` returns the sorted `rows` and `table` props for `<Table>`, and
  each sortable header gets a `sortKey` (see the invoice, contact and company lists). Tables whose row order carries
  meaning (ordered planning steps, permission matrix, field lists, side-by-side compares) opt out with
  `<Table sortable={false}>`; a single column with `<TableHead sortable={false}>`. Sorting is view state and resets on
  navigation.
- **Accent color is for actions:** selected tabs, filters and toggles use `Segmented` (`components/ui/segmented.tsx`),
  never a `bg-primary` fill. Status labels use `Badge` (sentence case; the variant carries the meaning). Uppercase is
  reserved for section titles.
- **Real links for navigation:** anything that opens a record or screen is an `<a href>` (router `Link`), so
  Cmd/Ctrl/middle-click and "Open in new tab" work. Clickable table rows put a `RowLink` in their main cell and spread
  `linkedRow` on the `<tr>`, which forwards row clicks to that link (Cmd/Ctrl/middle-click open a new tab). Don't
  stretch a link over a row with `::after`: Safari doesn't position it against the `<tr>`. Links that need extra click
  handling skip it on modified clicks (`isModifiedClick`). Clickable controls
  show the pointer cursor (global rule in `index.css`); don't put `onClick` on rows, divs or spans.
- Radix `<SelectItem>` cannot use an empty string. Use a sentinel such as `_none`.
- Validate dates before formatting them with date-fns.

## Release notes

`CHANGELOG.md` is the source for team updates. Keep entries short, human and non-technical where possible.
Update Unreleased as meaningful work is completed; do not wait for deployment or describe unfinished work as released.
Consolidate rapid fix iterations into one item.
