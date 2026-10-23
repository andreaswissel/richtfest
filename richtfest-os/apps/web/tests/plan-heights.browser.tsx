import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PlanHeightObservation } from "@richtfest/shared/plan-heights";
import { PlanHeights } from "../src/components/building-model/plan-heights";
import { adaptBuildingModel } from "../src/components/building-model/types";
import { usePreferences } from "../src/store";

/** Run through Vite: import('/tests/plan-heights.browser.tsx').then(m => m.testPlanHeightTransfer()) */
export async function testPlanHeightTransfer() {
  const host = document.createElement("div"), root = createRoot(host);
  document.body.append(host);
  const previousFetch = window.fetch, previousLanguage = usePreferences.getState().language;
  const requests: Array<{ path: string; body: unknown }> = [];
  const pages: unknown[] = [];
  const observation: PlanHeightObservation = { kind: "fire_height", value: 750, unit: "cm", unitBasis: "explicit", quote: "750 cm", buildingLabel: "House", storeyLabel: "Top floor", upperReference: "highest_habitable_floor", lowerReference: "mean_terrain", floorBasis: "finished", constructionState: "proposed", region: { x: .1, y: .1, width: .5, height: .5 }, reason: "Printed endpoints" };
  const model = adaptBuildingModel({ revision: 8, planSources: [{ id: "plan", page: 3, source: { versionId: "v" } }], buildings: [{ id: "existing", name: "Has height" }, { id: "target", name: "Target" }],
    properties: [{ id: "height", entityType: "building", entityId: "existing", propertyKey: "fireHeight", current: { value: 4 } }],
    automaticPlanProcessing: [{ sourceVersionId: "v", fileName: "Section.pdf", renderableSource: { mimeType: "application/pdf" }, heightExtraction: { version: "section-heights-v1", status: "complete", pages: [{ page: 3, status: "completed", gaps: [], observations: [observation, { ...observation, kind: "ridge_height" }, { ...observation, lowerReference: "project_datum" }] }] } }] });
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  try {
    usePreferences.setState({ language: "en" });
    window.fetch = (async (input, init) => {
      requests.push({ path: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as typeof fetch;
    flushSync(() => root.render(<QueryClientProvider client={client}><PlanHeights projectId="p" model={model} onPage={(...args) => pages.push(args)} /></QueryClientProvider>));
    const useButtons = () => [...host.querySelectorAll("button")].filter(button => button.textContent?.startsWith("Use height"));
    assert(useButtons().length === 1 && useButtons()[0]!.disabled, "Only eligible saved height has an action; target selection is required");
    const select = host.querySelector("select")!;
    flushSync(() => { select.value = "existing"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    assert(useButtons()[0]!.disabled, "Existing height must never be overwritten");
    flushSync(() => { select.value = "target"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    assert(!useButtons()[0]!.disabled, "Empty target enables transfer");
    flushSync(() => [...host.querySelectorAll("button")].find(button => button.textContent === "Page 3")!.click());
    assert(JSON.stringify(pages) === JSON.stringify([[3, "v"]]), "Source page action must preserve version");
    flushSync(() => useButtons()[0]!.click());
    const deadline = Date.now() + 2000;
    while (!host.textContent?.includes("Height copied") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert(JSON.stringify(requests) === JSON.stringify([{ path: "/api/projects/p/building-model/height-observations", body: { baseRevision: 8, buildingId: "target", sourceVersionId: "v", page: 3, observationIndex: 0 } }]), "Transfer must reference saved observation and revision, never approve or send an editable value");
    assert(host.textContent?.includes("Height copied"), "Transfer success must make separate review explicit");
    return "PASS: eligibility, target selection, no overwrite, source page context, exact saved-observation transfer and separate review";
  } finally {
    root.unmount(); host.remove(); client.clear(); window.fetch = previousFetch;
    usePreferences.setState({ language: previousLanguage });
  }
}
