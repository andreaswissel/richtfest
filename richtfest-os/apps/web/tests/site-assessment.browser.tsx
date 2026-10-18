import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createEmptySiteAssessmentInput,
  SITE_ASSESSMENT_CONSTRAINT_KEYS,
  SITE_ASSESSMENT_CHECK_KEYS,
} from "@richtfest/shared";
import { Feasibility } from "../src/components/feasibility";
import { queryClient } from "../src/query";
import { usePreferences } from "../src/store";

/** Run in Vite: import('/tests/site-assessment.browser.tsx').then(m => m.testSiteAssessment()) */
export async function testSiteAssessment() {
  const host = document.createElement("div");
  document.body.append(host);
  let root = createRoot(host);
  const path = "/feasibility/projects/site-ui-regression/site-assessment";
  const originalFetch = window.fetch,
    preferences = usePreferences.getState();
  const { baseRevision: _, ...defaults } = createEmptySiteAssessmentInput();
  const values = [1000, 0.3, 1.2, 260, 3, 80, 0];
  const constraints = Object.fromEntries(
    SITE_ASSESSMENT_CONSTRAINT_KEYS.map((key, i) => [
      key,
      {
        value: values[i],
        source: "Reviewed test plan",
        sourceDate: "2026-10-18",
        kind: "official",
        reviewed: true,
      },
    ]),
  ) as typeof defaults.constraints;
  let record = {
    canWrite: true,
    assessment: {
      ...defaults,
      planningBasis: "section34" as const,
      references: [
        {
          id: "ref-test",
          label: "Reference building",
          source: "Test plan",
          note: "Reviewed comparator",
        },
      ],
      constraints,
      checks: Object.fromEntries(
        SITE_ASSESSMENT_CHECK_KEYS.map((key) => [
          key,
          { status: "confirmed", source: "Test plan", note: "Test review" },
        ]),
      ) as typeof defaults.checks,
      revision: 1,
      updatedAt: null,
    },
  };
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
  };
  const wait = async (predicate: () => unknown) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("Site assessment did not settle");
  };
  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const closeEditor = () => {
    const close = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".site-editor-panel button",
      ),
    ].find((b) => b.textContent === "Close editor");
    if (close) flushSync(() => close.click());
  };
  const field = (text: string) => {
    let label = [
      ...document.querySelectorAll<HTMLLabelElement>(
        ".site-editor-panel label",
      ),
      ...host.querySelectorAll<HTMLLabelElement>("label"),
    ].find((l) => l.textContent === text);
    if (!label) {
      closeEditor();
      const edit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) =>
          [`Edit ${text}`, `Review evidence ${text}`].includes(
            b.getAttribute("aria-label") ?? "",
          ),
      );
      if (edit) flushSync(() => edit.click());
      label = [
        ...document.querySelectorAll<HTMLLabelElement>(
          ".site-editor-panel label",
        ),
        ...host.querySelectorAll<HTMLLabelElement>("label"),
      ].find((l) => l.textContent === text);
    }
    if (label) {
      let parent = label.parentElement;
      while (parent) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
      }
    }
    return label
      ? (document.getElementById(label.htmlFor) as HTMLInputElement)
      : null;
  };
  const fill = (
    element: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ) => {
    Object.getOwnPropertyDescriptor(
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    flushSync(() =>
      element.dispatchEvent(new Event("input", { bubbles: true })),
    );
  };
  let router = createMemoryRouter(
    [{ path: "*", element: <Feasibility projectId="site-ui-regression" /> }],
    { initialEntries: ["/project?view=feasibility&study=site"] },
  );
  window.fetch = async (url, options) => {
    if (String(url).includes("berlin-context"))
      return Response.json({ data: { candidates: [] } });
    if (String(url) !== `/api${path}`) return originalFetch(url, options);
    if (options?.method === "PUT") {
      const next = JSON.parse(String(options.body));
      if (next.baseRevision !== record.assessment.revision)
        return Response.json({ message: "Revision conflict" }, { status: 409 });
      const { baseRevision, ...rest } = next;
      check(
        !("revision" in rest) && !("updatedAt" in rest),
        "Save sends only the strict input contract",
      );
      record = {
        ...record,
        assessment: { ...rest, revision: baseRevision + 1, updatedAt: null },
      };
    }
    return Response.json({ data: record });
  };
  try {
    usePreferences.getState().hydrate({ language: "en" });
    queryClient.setQueryData([path], record);
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    await wait(() => field("Parcel area (m²)"));
    check(
      host.textContent?.includes("780 m²") &&
        host.textContent.includes("860 m²"),
      "GF and BGF are shown separately",
    );
    check(
      button("Save assessment")?.disabled,
      "Saved assessment has no pending save",
    );
    fill(field("Parcel area (m²)")!, "1200");
    check(!button("Save assessment")?.disabled, "Valid edit can save");
    check(
      document
        .querySelector('[aria-label="Parcel area (m²) · Evidence reviewed"]')
        ?.getAttribute("data-state") === "unchecked",
      "Changing a number clears evidence review",
    );
    closeEditor();
    flushSync(() => button("Save assessment").click());
    await wait(
      () =>
        record.assessment.revision === 2 && button("Save assessment")?.disabled,
    );
    check(
      record.assessment.constraints.parcelArea.value === 1200,
      "Save persists the numeric change",
    );
    button("Add reference building").closest("details")!.open = true;
    flushSync(() => button("Add reference building").click());
    closeEditor();
    flushSync(() => button("Save assessment").click());
    await wait(
      () =>
        record.assessment.revision === 3 && button("Save assessment")?.disabled,
    );
    check(
      record.assessment.checks.planningBasis.status === "unresolved",
      "Changing §34 references requires planning-basis review again",
    );
    fill(field("Full storeys")!, "1.5");
    check(
      button("Save assessment")?.disabled &&
        !host.textContent?.includes("860 m²"),
      "Invalid storeys suppress results and save",
    );
    fill(field("Full storeys")!, "3");
    closeEditor();
    const notes = field("Notes") as unknown as HTMLTextAreaElement;
    fill(notes, "My unsaved review");
    record = {
      ...record,
      assessment: {
        ...record.assessment,
        revision: 4,
        notes: "Concurrent review",
      },
    };
    await queryClient.invalidateQueries({ queryKey: [path] });
    check(notes.value === "My unsaved review", "Refetch preserves draft");
    closeEditor();
    flushSync(() => button("Save assessment").click());
    await wait(() =>
      host.textContent?.includes("Someone saved a newer revision"),
    );
    check(
      record.assessment.notes === "Concurrent review",
      "Stale save cannot overwrite new server revision",
    );
    flushSync(() =>
      document
        .querySelector<HTMLAnchorElement>(
          'a[href="/project?view=feasibility"]',
        )!
        .click(),
    );
    await wait(() => document.querySelector('[role="dialog"]'));
    check(
      router.state.location.search.includes("study=site"),
      "Switching subviews blocks unsaved navigation",
    );
    const stay = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ].find((b) => b.textContent === "Keep editing")!;
    flushSync(() => stay.click());
    root.unmount();
    router.dispose();
    root = createRoot(host);
    record = { ...record, canWrite: false };
    queryClient.setQueryData([path], record);
    router = createMemoryRouter(
      [{ path: "*", element: <Feasibility projectId="site-ui-regression" /> }],
      { initialEntries: ["/project?view=feasibility&study=site"] },
    );
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    await wait(() => field("Parcel area (m²)"));
    check(
      field("Parcel area (m²)")!.disabled &&
        !button("Save assessment") &&
        !button("Add reference building"),
      "Read-only users cannot modify the assessment",
    );
    return { passed: true, checks: 13 };
  } finally {
    root.unmount();
    router.dispose();
    host.remove();
    window.fetch = originalFetch;
    queryClient.removeQueries({ queryKey: [path] });
    usePreferences.getState().hydrate({ language: preferences.language });
  }
}
