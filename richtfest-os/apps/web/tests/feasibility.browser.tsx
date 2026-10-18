import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, Link, RouterProvider } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { Feasibility } from "../src/components/feasibility";
import { queryClient } from "../src/query";
import { usePreferences } from "../src/store";

/** Run through Vite: import('/tests/feasibility.browser.tsx').then(m => m.testFeasibility()) */
export async function testFeasibility() {
  const host = document.createElement("div");
  document.body.append(host);
  let root = createRoot(host);
  const path = "/feasibility/projects/ui-regression/study";
  const preferences = usePreferences.getState(), originalFetch = window.fetch;
  const v = (value: number) => ({ value, source: "entered", note: null, reviewed: true });
  let record = { canWrite: true, figures: { grz: null, gfz: null, parcelArea: null }, study: {
    revision: 1, updatedAt: null, notes: "Saved notes", site: { parcelArea: v(1000), askingPrice: v(1000000), acquisitionCostRate: v(8) },
    scenarios: ["existing", "densify", "new_build"].map(kind => ({ kind, revenueMode: "rent", values: {
      existingLivingArea: v(600), renovationCost: v(800), newGrossFloorArea: v(1200), livingAreaRatio: v(0.75), constructionCost: v(3000), contingencyRate: v(20),
      monthlyRent: v(14), operatingCostRate: v(15), capitalizationRate: v(3.8), financingRate: v(5), marketingRate: v(0), profitRate: v(10),
    } })),
  } };
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  const wait = async (predicate: () => unknown) => {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 20)); }
    throw new Error("Feasibility did not settle");
  };
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text)!;
  const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const fill = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value);
    flushSync(() => element.dispatchEvent(new Event("input", { bubbles: true })));
  };
  let router = createMemoryRouter([
    { path: "/study", element: <><Link to="/other">Leave study</Link><Feasibility projectId="ui-regression" /></> },
    { path: "/other", element: <p>Other view</p> },
  ], { initialEntries: ["/study"] });
  window.fetch = async (url, options) => {
    if (String(url) !== `/api${path}`) return originalFetch(url, options);
    if (options?.method === "PUT") {
      const next = JSON.parse(String(options.body));
      if (next.baseRevision !== record.study.revision) return Response.json({ message: "Revision conflict" }, { status: 409 });
      record = { ...record, study: { ...record.study, ...next, revision: next.baseRevision + 1 } };
    }
    return Response.json({ data: record });
  };
  try {
    usePreferences.getState().hydrate({ language: "en" });
    queryClient.setQueryData([path], record);
    flushSync(() => root.render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>));
    await wait(() => input("Existing living area"));
    check(!input("Construction cost KG 300–700"), "Only the selected input group is mounted");
    const rows = host.querySelectorAll<HTMLTableRowElement>(".feasibility-summary tbody tr");
    flushSync(() => rows[1]!.cells[1]!.click());
    check(button("Densify & renovate").getAttribute("aria-pressed") === "true" && input("Existing living area") && input("New floor area (GF)"), "Clicking the residual cell selects densification and its inputs");
    flushSync(() => rows[2]!.querySelector<HTMLElement>('[data-slot="badge"]')!.click());
    check(button("New build").getAttribute("aria-pressed") === "true" && !input("Existing living area") && input("New floor area (GF)"), "Clicking the status badge selects new build and its inputs");
    flushSync(() => rows[0]!.click());
    check(button("Keep existing").getAttribute("aria-pressed") === "true" && !input("New floor area (GF)"), "Clicking row whitespace selects the existing scenario");
    fill(input("Existing living area"), "1,000");
    flushSync(() => button("Save study").click());
    await wait(() => record.study.revision === 2 && button("Save study").disabled);
    check(record.study.scenarios[0]!.values.existingLivingArea.value === 1000, "English grouping must save one thousand, not one");

    flushSync(() => button("Revenue and profit").click());
    fill(input("Capitalisation rate"), "0");
    check(input("Capitalisation rate").getAttribute("aria-invalid") === "true", "Zero capitalisation must show a field error");
    check(button("Save study").disabled && button("Download report").disabled, "Invalid inputs must not save or export");
    check(host.querySelector("tbody tr")?.textContent?.includes("1 invalid inputs"), "Invalid scenario must not show a usable result");
    fill(input("Capitalisation rate"), "3.8");

    flushSync(() => button("Costs").click());
    host.querySelectorAll<HTMLDetailsElement>("details").forEach(d => { d.open = true; });
    fill(input("Other costs"), "1,00");
    check(button("Save study").disabled, "Malformed grouping in optional input must not be silently ignored");
    flushSync(() => button("Areas").click());
    check(button("Save study").disabled, "Switching groups must not hide an invalid draft from validation");
    flushSync(() => button("Costs · 1").click());
    check(input("Other costs").value === "1,00", "Invalid text survives group switching");
    fill(input("Other costs"), "100");
    flushSync(() => button("Save study").click());
    await wait(() => record.study.revision === 3 && button("Save study").disabled);

    // Refetched revisions must not silently replace an in-progress local draft.
    const notes = host.querySelector<HTMLTextAreaElement>("textarea")!;
    fill(notes, "My unsaved notes");
    record = { ...record, study: { ...record.study, revision: 4, notes: "Someone else's notes" } };
    await queryClient.invalidateQueries({ queryKey: [path] });
    check(notes.value === "My unsaved notes", "Background updates must preserve the local draft");
    flushSync(() => button("Save study").click());
    await wait(() => host.textContent?.includes("Someone saved a newer revision"));
    check(record.study.notes === "Someone else's notes" && notes.value === "My unsaved notes", "Stale save must not overwrite either user's work");
    flushSync(() => host.querySelector<HTMLAnchorElement>('a[href="/other"]')!.click());
    await wait(() => document.querySelector('[role="dialog"]'));
    check(router.state.location.pathname === "/study", "Dirty navigation must wait for confirmation");
    const stay = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "Keep editing")!;
    flushSync(() => stay.click());
    check(notes.value === "My unsaved notes", "Staying preserves edits");

    // A fresh German study uses comma decimals and dot grouping.
    root.unmount(); router.dispose();
    root = createRoot(host);
    usePreferences.getState().hydrate({ language: "de" });
    router = createMemoryRouter([{ path: "*", element: <Feasibility projectId="ui-regression" /> }]);
    flushSync(() => root.render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>));
    await wait(() => input("Bestandswohnfläche"));
    fill(input("Bestandswohnfläche"), "1.000,75");
    flushSync(() => button("Studie speichern").click());
    await wait(() => record.study.revision === 5 && button("Studie speichern").disabled);
    check(record.study.scenarios[0]!.values.existingLivingArea.value === 1000.75, "German grouping and decimal must preserve the amount");
    return "PASS: full-row scenario selection, grouped EN/DE inputs, one input group, invalid/optional values, draft retention, stale-save conflict, navigation guard";
  } finally {
    root.unmount(); router.dispose(); host.remove(); queryClient.removeQueries({ queryKey: [path] });
    window.fetch = originalFetch; usePreferences.getState().hydrate(preferences);
  }
}
