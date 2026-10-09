---
title: Design principles
description: How Richtfest OS screens stay dense but readable. Apply these before reaching for a new component.
---

Richtfest OS is dense operations software. Density is fine; noise is not. Every screen should answer "what is this,
what needs my attention, what do I do next" without the user hunting for it.

## 1. Follow the task

Lay a screen out in the order the work happens, top to bottom. Key facts first (amount, due date, number), then what
needs attention, then the inputs, and the decision last. Decisions live in a fixed footer or the page header, never
above the content they decide on.

Example: the invoice review panel reads summary → findings → classification → invoice / amount / payment fields,
with **Confirm** pinned at the bottom.

## 2. One accent per view

The primary color means "this is the next step". Use it for one button per view (per panel at most).

- Selected tabs, filters and toggles use `Segmented`: a muted track with the selected option raised.
- Selected options in a choice list use `ChoiceChips`: neutral border, check mark.
- Secondary actions are `ghost` or `outline` buttons.

## 3. Label and group

Every control group has a visible label, and related fields sit together under a section title (Invoice, Amount,
Payment). Labels sit above their control, the same way everywhere. Don't repeat an option in two places (an action
and a choice for the same thing).

## 4. Calm unless something needs attention

Color is for things that need a look. Findings and errors go in a callout tinted by severity, with the icon colored
and the text in normal foreground so it stays readable. Uppercase is only for section titles. When everything is
fine, say so (a short, positive "No findings").

## 5. Say what will happen

Button labels are verb + object and show the consequence: "Confirm as Prepayment · Richtfest Trade", not "OK". Show the
keyboard shortcut next to frequent actions (`⌘↵`).

## 6. Respect the reader in conversations

The agentic workspace is the project entry point. Conversation, delegated work and open artifacts share project records with the direct dashboard/file/table views.

Use shadcn's conversation primitives: `MessageScroller` for transcript behavior, `Message`/`MessageGroup` for rows, `Bubble` for message surfaces, `Attachment` for files with real processing state, and `Marker` for system activity. OpenUI-generated content belongs inside these rows or the artifact panel; it must not introduce a competing transcript scroller. Persisted messages, agent execution and approvals remain application responsibilities.

Acceptance criteria for the chat implementation:

- Treat scrolling as reader-controlled state, never unconditional auto-scroll. Follow streaming only while the reader is following at the live edge. Scrolling away, selecting text, keyboard navigation, opening a link or searching suspends following.
- Place a submitted turn near the top of the viewport, retaining some prior context. Let the answer expand below it without pulling the reader away.
- Allow output to arrive offscreen, indicate ongoing generation and unread messages, and provide a "Jump to latest" action that explicitly resumes following.
- Reopen at the reader's saved meaningful turn, usually the last user message, rather than the absolute bottom. Avoid a visible jump through the oldest messages during restoration.
- Keep position stable when older history loads, images/Markdown/code render, rich content expands or the artifact panel resizes.
- Use stable message IDs for restoration, citations, message links and direct jumps. Support search and unread markers for navigating long conversations. Preserve selected text and unsent composer input during updates.
- Stopping, retrying, regenerating, branching and errors must not unexpectedly change position or keyboard focus.
- Keep long transcripts responsive while text and rich content stream; do not rerender the whole history on each token or scroll event.
- Keep transcript navigation, keyboard focus and reduced-motion behavior intact; announce meaningful status changes at a manageable pace rather than every streamed token.

Verify these behaviors through `@Browser`, including long transcripts/replies, delayed artifact rendering, history loading, selection/search during streaming, message jumps, reopening a thread, interrupted/retried runs and both density modes. Do not replace the primitive's behavior with manual scroll calculations or a separate stick-to-bottom hook.

References: [streaming-chat rationale and examples](https://ui.shadcn.com/docs/components/base/message-scroller) and [official chat composition rules](https://github.com/shadcn-ui/ui/blob/main/skills/shadcn/rules/chat.md). Original inspiration: the [user-supplied post](https://x.com/shadcn/status/2070394918720221522).

## Building blocks

| Need                                                 | Use                                                |
| ---------------------------------------------------- | -------------------------------------------------- |
| Screen header with title, actions, filters           | `PageHeader` (`components/layout.tsx`)             |
| Titled block                                         | `Section` / `SectionTitle`                         |
| Tabs, filters, toggles                               | `Segmented`                                        |
| Single choice that wraps                             | `ChoiceChips`                                      |
| Status                                               | `Badge`                                            |
| Data table (sortable by default), clickable rows     | `Table`, `RowLink` + `linkedRow`                   |
| Text input, multi-line input                         | `Input`, `Textarea`                                |
| Labeled form field (label above, hint / error below) | `Field`                                            |
| Banner, alert, inline error                          | `Callout` (tone: error / warning / success / info) |

See [Conventions](/engineering/conventions) for density tokens, real links and the remaining UI rules.
