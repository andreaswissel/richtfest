import {
  createViewport,
  type ViewportState,
} from "../src/components/location/viewport";

/** Run in Vite: import('/tests/location-viewport.browser.ts').then(m => m.testTrees()). */
export async function testTrees() {
  const assert = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
  };
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;inset:0;width:640px;height:480px;z-index:9999";
  document.body.append(host);
  let selected: string | null = null;
  let measuredHeight = -1;
  const viewport = createViewport(host, {
    select: (id) => {
      selected = id;
    },
    place: () => {},
    measure: (point) => {
      measuredHeight = point[1];
    },
    align: () => {},
  });
  const state: ViewportState = {
    context: {
      siteId: "berlin-giersstrasse-20",
      address: "Test fixture",
      origin: [0, 0],
      longitude: 0,
      latitude: 0,
      radius: 100,
      buildings: [],
      sources: [],
      importedAt: "2026-10-10",
      trees: [
        {
          id: "test-tree",
          sourceId: "test-tree",
          species: "Test tree",
          position: [0, 0],
          height: 20,
          crownDiameter: 8,
        },
      ],
    },
    objects: [],
    models: {},
    layers: { buildings: true, trees: true, objects: true, lidar: false, roads: true, railNoise: false, plan: true, aerial: false },
    site: { axes: [], plan: null, distances: [], railNoise: null, aerial: { near: null, far: null }, picks: [], snaps: [] },
    selected: null,
    tool: "select",
    treeStyle: "schematic",
    measurement: [],
    clipHeight: 50,
    dark: false,
    constructionLabel: "Planned construction",
  };
  try {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    viewport.update(state);
    viewport.view("top");
    const canvas = host.querySelector("canvas")!;
    const image = (next: ViewportState) => {
      viewport.update(next);
      return canvas.toDataURL();
    };
    const original = JSON.stringify(state.context);
    const schematic = image(state);
    const illustrated = image({ ...state, treeStyle: "illustrative" });
    assert(
      schematic !== illustrated,
      "Known dimensions must produce visibly different tree styles",
    );
    const clickCentre = () => {
      const bounds = canvas.getBoundingClientRect();
      const pointer = {
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
        button: 0,
      };
      canvas.dispatchEvent(new PointerEvent("pointerdown", pointer));
      canvas.dispatchEvent(new PointerEvent("pointerup", pointer));
    };
    clickCentre();
    assert(
      selected === "tree:test-tree",
      "Illustrative foliage must select its source tree",
    );
    viewport.update({ ...state, treeStyle: "illustrative", tool: "measure" });
    clickCentre();
    assert(
      Math.abs(measuredHeight - 20) < 0.001,
      "Measure must hit the recorded 20m schematic disc, not decorative foliage",
    );
    for (const missing of ["height", "crownDiameter"] as const) {
      const context = {
        ...state.context,
        trees: [{ ...state.context.trees[0], [missing]: null }],
      };
      assert(
        image({ ...state, context }) ===
          image({ ...state, context, treeStyle: "illustrative" }),
        `Missing ${missing} must preserve the schematic marker`,
      );
    }
    assert(
      JSON.stringify(state.context) === original,
      "View modes must not mutate source records",
    );
    return {
      checks:
        "distinct styles, source selection, measurement protection, missing height, missing diameter, source immutability",
      measuredHeight,
    };
  } finally {
    viewport.dispose();
    host.remove();
  }
}

/** Run in Vite: import('/tests/location-viewport.browser.ts').then(m => m.testConstruction()). */
export async function testConstruction() {
  const assert = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
  };
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;width:640px;height:480px;z-index:9999";
  document.body.append(host);
  let selected: string | null = null;
  let placed = [0, 0, 0];
  const viewport = createViewport(host, {
    select: (id) => { selected = id; }, place: (point) => { placed = point; }, measure: () => {}, align: () => {},
  });
  const state: ViewportState = {
    context: { siteId: "test", address: "Test", origin: [0, 0], longitude: 0, latitude: 0, radius: 100, buildings: [], trees: [], sources: [], importedAt: "2026-10-18" },
    objects: [
      { id: "build", kind: "mass", label: "Build", position: [180, 7, -90], size: [48, 14, 9], rotation: 32, note: "" },
      { id: "vehicle", kind: "vehicle", label: "Vehicle", position: [-400, 0, 250], size: [3, 4, 8], rotation: 0, note: "" },
    ],
    models: {},
    layers: { buildings: true, trees: true, objects: true, lidar: false, roads: true, railNoise: false, plan: true, aerial: false },
    site: { axes: [], plan: null, distances: [], railNoise: null, aerial: { near: null, far: null }, picks: [], snaps: [] },
    selected: "vehicle", tool: "select", treeStyle: "schematic", measurement: [], clipHeight: 50, dark: false,
    constructionLabel: "Planned construction",
  };
  const canvas = host.querySelector("canvas")!;
  const clickCentre = () => {
    const bounds = canvas.getBoundingClientRect();
    const pointer = { clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2, button: 0 };
    canvas.dispatchEvent(new PointerEvent("pointerdown", pointer));
    canvas.dispatchEvent(new PointerEvent("pointerup", pointer));
  };
  try {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    for (const width of [640, 280]) {
      host.style.width = `${width}px`;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      viewport.update(state);
      viewport.focus("build");
      const expected = canvas.toDataURL();
      viewport.view("area");
      viewport.fitConstruction();
      assert(canvas.toDataURL() === expected, "Fit must frame the translated, rotated build, ignoring the selected distant vehicle");
      clickCentre();
      assert(selected === "build", "The locator must not intercept selection of the construction");
    }
    viewport.update({ ...state, layers: { ...state.layers, objects: false } });
    viewport.focus();
    const home = canvas.toDataURL();
    viewport.view("area");
    viewport.fitConstruction();
    assert(canvas.toDataURL() === home, "Hidden construction must fall back to the site, not remain highlighted or framed");
    viewport.update({ ...state, objects: [] });
    viewport.fitConstruction();
    assert(canvas.toDataURL() === home, "An empty scene must return to the site");
    viewport.update({ ...state, objects: [], tool: "place", site: { ...state.site, plan: { walls: [
      { id: "wall", exterior: true, ring: [[-80, 140], [-62, 140], [-62, 146], [-80, 146]] },
    ] } } });
    viewport.fitConstruction();
    clickCentre();
    // Wall centre is (-71, 1.52, 143); the home viewing ray meets ground along (0.8, 0.95, 1).
    assert(Math.abs(placed[0] - (-71 - 1.52 * 0.8 / 0.95)) < 0.001 && Math.abs(placed[2] - (143 - 1.52 / 0.95)) < 0.001,
      "Plan-only construction must frame its placed wall geometry, not the address origin");
    const { loadIfc } = await import("../src/components/location/ifc-loader");
    const model = await loadIfc(await (await fetch(new URL("./location-ifc-mm.ifc", import.meta.url))).arrayBuffer());
    const ifc = { ...state.objects[0], id: "ifc", kind: "ifc" as const, size: model.size };
    viewport.update({ ...state, objects: [ifc, state.objects[1]], models: { ifc: model } });
    viewport.focus("ifc");
    const expectedIfc = canvas.toDataURL();
    viewport.view("area");
    viewport.fitConstruction();
    assert(canvas.toDataURL() === expectedIfc, "Loaded IFC geometry must be framed at its placed bounds");
    clickCentre();
    assert(selected === "ifc", "IFC must remain selectable through its locator");
    return { checks: "translated/rotated construction, selected vehicle excluded, wide and narrow framing, picking through locator, hidden and empty fallback, placed plan, loaded IFC" };
  } finally {
    viewport.dispose();
    host.remove();
  }
}
