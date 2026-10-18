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
    projectExtentLabel: "Project extent · approximate",
    siteAddressLabel: "Project address",
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
    projectExtentLabel: "Project extent · approximate",
    siteAddressLabel: "Project address",
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
    const footprint = { id: "site", label: "Site", sourceId: "fixture", roof: null, height: 12,
      polygons: [[[[-7, -4], [3, -4], [3, 8], [-7, 8], [-7, -4]]]] as [number, number][][][] };
    const context: ViewportState["context"] = { ...state.context, buildings: [
      { ...footprint, id: "courtyard", polygons: [[
        [[-100, -100], [100, -100], [100, 100], [-100, 100]],
        [[-10, -10], [10, -10], [10, 10], [-10, 10]],
      ]] },
      footprint,
    ] };
    const projectExtent: NonNullable<ViewportState["projectExtent"]> = {
      rings: [[[-130, 50], [-45, 50], [-45, 110], [-130, 110]]],
      context: { siteId:context.siteId, origin:context.origin, crs:"EPSG:25833" },
      source: {fileId:"00000000-0000-4000-8000-000000000001",version:1,page:12},
      alignmentStatus:"approximate", note:"Plan-linked project behind, not at, the address",
    };
    viewport.update({ ...state, context, projectExtent });
    viewport.focus("build");
    const plannedOverSite = canvas.toDataURL();
    viewport.fitConstruction();
    assert(canvas.toDataURL() === plannedOverSite, "Visible planning geometry must take precedence over the approximate extent");
    const siteState = { ...state, context, objects: [], selected: null };
    viewport.update(siteState);
    viewport.focus();
    const addressOnly = canvas.toDataURL();
    viewport.view("area");
    viewport.fitConstruction();
    assert(canvas.toDataURL() === addressOnly, "An address-containing building must never be inferred as construction");
    for (const buildings of [true, false]) {
      viewport.update({ ...siteState, projectExtent, tool:"place", layers:{...state.layers, buildings} });
      viewport.view("area");
      viewport.fitConstruction();
      clickCentre();
      assert(Math.abs(placed[0] - (-87.5 - 0.08 * 0.8 / 0.95)) < 0.001 && Math.abs(placed[2] - (80 - 0.08 / 0.95)) < 0.001,
        "Fit must centre the source-backed extent independently of context building visibility");
    }
    const image = document.createElement("canvas");
    image.width = canvas.width; image.height = canvas.height;
    const pixels = image.getContext("2d")!;
    viewport.fitConstruction();
    pixels.drawImage(canvas, 0, 0);
    const rgba = pixels.getImageData(0, 0, image.width, image.height).data;
    let tealPixels = 0;
    for (let i = 0; i < rgba.length; i += 4)
      if (rgba[i + 1] > 60 && rgba[i + 1] > rgba[i] * 2 && rgba[i + 2] > rgba[i] * 1.5) tealPixels++;
    assert(tealPixels > 100, "A saved extent without planning geometry must have a visible teal locator");
    viewport.update({ ...siteState, projectExtent:{...projectExtent,context:{...projectExtent.context,origin:[1,2]}} });
    viewport.fitConstruction();
    assert(canvas.toDataURL() === addressOnly, "An extent from another coordinate frame must not be displayed");
    const concave = { ...footprint, polygons: [[[[-20, -20], [20, -20], [20, -5], [0, -5], [0, 20], [-20, 20], [-20, -20]]]] as [number, number][][][] };
    viewport.update({ ...siteState, context: { ...context, buildings: [concave] }, selected: "building:site" });
    viewport.focus();
    viewport.view("top");
    pixels.clearRect(0, 0, image.width, image.height);
    pixels.drawImage(canvas, 0, 0);
    // Top camera is 150 m above the home target (y=5); this roof is at y=12.
    const scale = canvas.height / (2 * Math.tan(17.5 * Math.PI / 180) * 143);
    const selectionAt = (x: number, z: number) => {
      const data = pixels.getImageData(Math.round(canvas.width / 2 + x * scale) - 6, Math.round(canvas.height / 2 + z * scale) - 6, 13, 13).data;
      for (let i = 0; i < data.length; i += 4)
        if (data[i] > 70 && data[i + 2] > data[i] * 1.35 && data[i + 2] > data[i + 1] * 1.35) return true;
      return false;
    };
    assert(selectionAt(0, 10), "Selection must follow the concave building's inset edge");
    assert(!selectionAt(20, 10), "Selection must not draw the bounding box across empty space beside the inset");
    viewport.update({ ...siteState, context: { ...context, buildings: [concave] }, selected: null });
    pixels.clearRect(0, 0, image.width, image.height);
    pixels.drawImage(canvas, 0, 0);
    assert(!selectionAt(0, 10), "Deselecting must remove the precise building outline");
    return { checks: "translated/rotated construction, selected vehicle excluded, wide and narrow framing, picking through locator, hidden and empty fallback, placed plan, loaded IFC, source-backed extent, no address-footprint inference, coordinate-frame guard, hidden context, concave building selection" };
  } finally {
    viewport.dispose();
    host.remove();
  }
}

/** Run on a loaded project location route. Exercises the real editor without saving project data. */
export async function testMeasurementOverlay() {
  const host = document.querySelector<HTMLElement>(
    '.location-viewport[data-ready="true"]',
  );
  if (!host) throw new Error("Open a project with loaded 3D location first");
  const canvas = host.querySelector("canvas")!;
  const check = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
  };
  const settle = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  const key = async (value: string) => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: value }));
    await settle();
  };
  const bounds = () => JSON.stringify(host.getBoundingClientRect().toJSON());
  const click = async (x: number, y: number) => {
    const rect = host.getBoundingClientRect();
    const pointer = {
      clientX: rect.x + rect.width * x,
      clientY: rect.y + rect.height * y,
      button: 0,
    };
    canvas.dispatchEvent(new PointerEvent("pointerdown", pointer));
    canvas.dispatchEvent(new PointerEvent("pointerup", pointer));
    await settle();
  };
  await key("Escape");
  await key("Escape");
  const before = bounds();
  try {
    await key("m");
    check(
      bounds() === before,
      "Entering measurement must not resize or shift the viewport",
    );
    await click(0.2, 0.2);
    check(bounds() === before, "First point must not resize the viewport");
    await click(0.5, 0.3);
    check(
      bounds() === before,
      "Completed measurement must not resize the viewport",
    );
    const panel = document.querySelector<HTMLElement>(".location-measurement")!;
    check(
      panel.querySelectorAll("dd").length === 3,
      "Show spatial, horizontal and vertical distances without a source choice",
    );
    const rect = panel.getBoundingClientRect(),
      view = host.getBoundingClientRect();
    check(
      rect.left >= view.left &&
        rect.right <= view.right &&
        rect.top >= view.top &&
        rect.bottom <= view.bottom,
      "Result floats inside the viewport",
    );
    const metrics = panel.querySelector("dl")!.textContent;
    panel.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    await settle();
    check(
      panel.querySelector("dl")!.textContent === metrics,
      "Changing snap must not remeasure finished endpoints",
    );
    check(
      !panel.querySelector(".measurement-noise"),
      "A general measurement must not offer noise assessment",
    );
    const description = panel.querySelector<HTMLInputElement>("input")!;
    const purpose = panel.querySelector<HTMLSelectElement>("select")!;
    if (!description.disabled) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(description, "Neighbor, not the road");
      description.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      check(
        purpose.value === "general" &&
          !panel.querySelector(".measurement-noise"),
        "Description keywords must not infer a domain",
      );
      purpose.value = "rail";
      purpose.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
      check(
        !panel.querySelector(".measurement-noise"),
        "Domain follow-up requires a saved purpose, not an unsaved selection",
      );
    }
    check(
      bounds() === before && panel.querySelector("dl")!.textContent === metrics,
      "Describing a measurement must not move the map or change its values",
    );
    await key("Escape");
    check(
      !document.querySelector(".location-measurement dl"),
      "Escape clears the result",
    );
    check(bounds() === before, "Clearing must not resize the viewport");
    return "PASS: stable canvas and three metrics; general default; no keyword inference; no domain action before saving intent";
  } finally {
    await key("Escape");
    await key("Escape");
  }
}
