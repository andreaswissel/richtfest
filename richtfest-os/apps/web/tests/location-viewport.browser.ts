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
    layers: { buildings: true, trees: true, objects: true, lidar: false },
    selected: null,
    tool: "select",
    treeStyle: "schematic",
    measurement: [],
    clipHeight: 50,
    dark: false,
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
