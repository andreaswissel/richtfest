import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createEmptySiteGeometryInput,
  type SiteGeometryInput,
  type GeometryEvidence,
} from "@richtfest/shared/site-geometry-model";
import { createDefaultSetbacks } from "@richtfest/shared/site-geometry";
import { SiteGeometryEditor } from "../src/components/feasibility/site-geometry-editor";
import { queryClient } from "../src/query";
import { usePreferences } from "../src/store";

export async function testSiteGeometry() {
  const host = document.createElement("div");
  host.style.width = "1100px";
  document.body.append(host);
  const root = createRoot(host),
    preferences = usePreferences.getState(),
    originalFetch = window.fetch;
  const ring = (
    x: number,
    y: number,
    w: number,
    h: number,
  ): [number, number][] => [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
    [x, y],
  ];
  const ev = (id: string, r: [number, number][]): GeometryEvidence => ({
    id,
    label: id,
    geometry: [[r]],
    source: "Reviewed test survey",
    sourceDate: "2026-10-18",
    reviewed: true,
  });
  const parcel = ev("parcel", ring(390000, 5820000, 40, 40));
  let state: SiteGeometryInput = {
    ...createEmptySiteGeometryInput(),
    parcel,
    envelope: ev("envelope", ring(390002, 5820002, 36, 36)),
    setbacks: createDefaultSetbacks(parcel, 0).map((e) => ({
      ...e,
      source: "Boundary review",
      sourceDate: "2026-10-18",
      reviewed: true,
    })),
    exclusionsReviewed: true,
    buildings: [
      {
        id: "building-a",
        label: "Building A",
        footprint: ev("footprint", ring(390005, 5820005, 10, 10)),
        fullStoreys: 2,
        storeyHeight: 3,
        height: null,
        storeysSource: "Plan",
        storeysReviewed: true,
        staffel: [],
      },
    ],
  };
  let adopted: number | null = null;
  const locationPath = "/projects/geometry-regression/location",
    evidencePath = "/feasibility/projects/geometry-regression/evidence";
  queryClient.setQueryData([locationPath], { context: null });
  queryClient.setQueryData([evidencePath], { sources: [], proposals: [] });
  window.fetch = async (url, options) =>
    String(url).includes("geometry-regression")
      ? Response.json({
          data: String(url).includes("evidence")
            ? { sources: [], proposals: [] }
            : { context: null },
        })
      : originalFetch(url, options);
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
  };
  const wait = async (p: () => unknown) => {
    for (let n = 0; n < 100; n++) {
      if (p()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("Geometry editor did not settle");
  };
  const button = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === name,
    )!;
  const input = (name: string) => {
    const l = [...host.querySelectorAll<HTMLLabelElement>("label")].find(
      (l) => l.textContent === name,
    )!;
    return host.querySelector<HTMLInputElement>(`[id="${l.htmlFor}"]`)!;
  };
  const fill = (el: HTMLInputElement, text: string) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(el, text);
    flushSync(() => el.dispatchEvent(new Event("input", { bubbles: true })));
  };
  function Harness() {
    const [value, setValue] = useState(state);
    return (
      <SiteGeometryEditor
        projectId="geometry-regression"
        value={value}
        disabled={false}
        options={{ grz: 0.4, gfz: 1.2, maxFullStoreys: 3, storeyHeight: 3 }}
        onUseArea={(a) => {
          adopted = a;
        }}
        onChange={(v) => {
          state = v;
          setValue(v);
        }}
      />
    );
  }
  try {
    usePreferences.getState().hydrate({ language: "en" });
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
      ),
    );
    await wait(() => host.textContent?.includes("GF 200"));
    const selection = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Selected geometry"]',
    )!;
    flushSync(() => {
      selection.value = "building-a";
      selection.dispatchEvent(new Event("change", { bubbles: true }));
    });
    fill(input("Full storeys"), "3");
    await wait(() => host.textContent?.includes("GF 300"));
    check(
      !state.buildings[0]!.storeysReviewed,
      "Changing full storeys invalidates its review",
    );
    const before = state.buildings[0]!.footprint.geometry[0]![0]![0]![0];
    flushSync(() =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Move 1 m →"]')!
        .click(),
    );
    check(
      state.buildings[0]!.footprint.geometry[0]![0]![0]![0] === before + 1 &&
        !state.buildings[0]!.footprint.reviewed,
      "Moving a footprint changes projected coordinates and invalidates evidence",
    );
    flushSync(() => button("Use usable area as capacity input").click());
    check(adopted === 1296, "Usable area adoption is explicit and calculated");
    flushSync(() => button("Trace mandatory building line").click());
    const canvas = host.querySelector<HTMLElement>(".geometry-plan")!,
      box = canvas.getBoundingClientRect();
    for (const [x, y] of [
      [0.2, 0.2],
      [0.8, 0.2],
    ])
      flushSync(() =>
        canvas.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            clientX: box.left + box.width * x!,
            clientY: box.top + box.height * y!,
          }),
        ),
      );
    flushSync(() => button("Finish outline").click());
    check(
      state.mandatoryLines.length === 1 && !state.mandatoryLines[0]!.reviewed,
      "Mandatory lines are drawn in geographic space and start unreviewed",
    );
    check(
      host.querySelectorAll(".geometry-plan .geometry-mandatory-line")
        .length === 1,
      "Mandatory line remains visible on map",
    );
    return { passed: true, checks: 6 };
  } finally {
    root.unmount();
    host.remove();
    window.fetch = originalFetch;
    queryClient.removeQueries({ queryKey: [locationPath] });
    queryClient.removeQueries({ queryKey: [evidencePath] });
    usePreferences.getState().hydrate({ language: preferences.language });
  }
}
