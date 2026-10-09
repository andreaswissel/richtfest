# Richtfest web design system

This is the shared local design system for the web application. It is not a separate package. Screens compose the same components; new workflows must not introduce parallel button, input, dialog, or table implementations.

## Foundation

`components.json` configures the approved shadcn/ui preset `b6F9Mslb0` (Radix Nova, neutral base, indigo theme, Inter and Lucide) and the `@/` aliases. The source components in `src/components/ui` use the official generated baseline with shared density sizing:

- `Button`: Radix Slot for `asChild` and CVA variants. `default` is the indigo primary action; `outline`, `ghost`, and `link` are secondary.
- `Dialog`: Radix Root, Portal, Overlay, Content, Title, Description, and Close. Radix owns focus trapping, Escape, outside interaction, and accessibility semantics.
- `Label`: Radix Label. `Field` connects a generated label ID, input ID, and optional hint.
- `Tabs`: Radix Tabs for content views, including keyboard selection and panel association.
- `ToggleGroup`: Radix single-selection ToggleGroup behind `Segmented`, for view preferences and filters. Clearing the current choice is prevented.
- `Input`, `Textarea`, `NativeSelect`, `Badge`, and table primitives: typed, forwarded-ref source components with shared `cn` class merging. Badge and Button use CVA.

`cn` in `src/lib/utils.ts` combines `clsx` and `tailwind-merge`. These are source-owned components, not a runtime component package. The reference conventions are [shadcn/ui](https://ui.shadcn.com/docs/components/radix/button) and [Radix Dialog](https://ui.shadcn.com/docs/components/radix/dialog).

## Compose screens

Use `Page`, `PageHeader`, and `Section` from `components/layout.tsx`. Their layout follows shared page, section, and stack spacing. Use `Field`, `Callout`, `Empty`, `Modal`, and sortable `Table` from `components/ui/primitives.tsx` for semantic workflow patterns.

```tsx
<Page>
  <PageHeader title={t("projects")} actions={
    <Button variant="default" onClick={openCreate}>{t("newProject")}</Button>
  } />
  <Section title={t("projectDetails")}>
    <Field label={t("name")}><Input name="name" required /></Field>
  </Section>
</Page>
```

Use `Button asChild` with a router `Link` for actions that navigate. A table record link uses `RowLink`; never use a click-only row. `Table` sorts by explicit `sort` values where rendered content is a component. Do not place interactive controls inside another interactive control.

`Modal` is the app-level Radix Dialog wrapper, with a translated close control and required accessible title. Use `Tabs` for project panels; use `Segmented` for provider/scope/density choices.

## Tokens and density

`src/index.css` owns the preset's semantic theme mappings, neutral surfaces, indigo actions and density tokens. `data-density="dense"` is the default; `normal` increases text, controls, icons, cells, and spacing together. Use `text-ui`, `text-ui-sm`, `text-ui-xs`, `text-ui-2xs`, `text-ui-lg`, `h-control`, `h-control-sm`, `size-icon`, `size-icon-sm`, `py-cell`, `p-page`, `gap-section`, and `gap-stack`.

Keep operational copy in both locale JSON files. Reserve the primary action for the next meaningful step. Status badges and selected controls remain neutral. Page-specific CSS may lay out content but must not redefine shared control appearance.

## Verification

The agentic conversation layer uses the official shadcn chat primitives and follows the acceptance criteria in the root `DESIGN-PRINCIPLES.md`. OpenUI content composes with that layer rather than introducing separate scroll behavior. Provider execution remains visibly unavailable until a workspace or personal credential is configured.

Run `bun run --filter @richtfest/web typecheck`, `bun test richtfest-os/apps/web/tests`, `bun run --filter @richtfest/web build`, and `bun run --filter @richtfest/web budget`.

Browser acceptance must exercise source registration, conversations/tasks, manual draft approval, and AI connection forms in Dense and Normal, including keyboard focus, dialog dismissal and restoration, selected tabs, narrow layouts, and error states. A build is not a substitute for this browser check.
