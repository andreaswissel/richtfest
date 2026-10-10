import { loadIfc } from "../src/components/location/ifc-loader";

/** Run from a Vite-served browser: import('/tests/location-ifc.browser.ts').then(m => m.testIfc()). */
export async function testIfc() {
  const assert = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
  };
  const bytes = await (
    await fetch(new URL("./location-ifc-mm.ifc", import.meta.url))
  ).arrayBuffer();
  const source = bytes.slice(0);
  const geometry = await loadIfc(bytes);
  assert(bytes.byteLength === 0, "Input must transfer to worker");
  assert(
    geometry.size.every((v, i) => Math.abs(v - [3, 4, 2][i]) < 1e-5),
    "Rotated millimetre box must measure 3 x 4 x 2 metres",
  );
  assert(geometry.meshes.length === 1, "Expected actual box mesh");
  const mesh = geometry.meshes[0];
  assert(mesh.indices.length === 36, "Expected twelve box triangles");
  const bounds = [0, 1, 2].map((axis) => {
    const values = Array.from(mesh.positions).filter((_, i) => i % 3 === axis);
    return [Math.min(...values), Math.max(...values)];
  });
  assert(
    JSON.stringify(bounds) ===
      JSON.stringify([
        [-1.5, 1.5],
        [0, 4],
        [-1, 1],
      ]),
    "Bounds must be centred and grounded",
  );
  for (let i = 0; i < mesh.normals.length; i += 3) {
    assert(
      Math.abs(Math.hypot(...mesh.normals.subarray(i, i + 3)) - 1) < 1e-5,
      "Normals must remain unit vectors",
    );
  }
  const expectError = async (
    action: () => Promise<unknown>,
    expected: string,
  ) => {
    try {
      await action();
    } catch (error) {
      assert(
        error instanceof Error &&
          (error.name === expected || error.message.includes(expected)),
        `Expected ${expected}, got ${String(error)}`,
      );
      return;
    }
    throw new Error(`Expected rejection: ${expected}`);
  };
  await expectError(() => loadIfc(new ArrayBuffer(0)), "IFC file is empty");
  await expectError(
    () => loadIfc(new TextEncoder().encode("not an IFC file").buffer),
    "could not be parsed",
  );
  const text = new TextDecoder().decode(source).replace(/^#36=.*$/m, "");
  await expectError(
    () => loadIfc(new TextEncoder().encode(text).buffer),
    "no renderable triangle geometry",
  );
  const before = new AbortController();
  before.abort();
  const preserved = source.slice(0);
  await expectError(() => loadIfc(preserved, before.signal), "AbortError");
  assert(
    preserved.byteLength === source.byteLength,
    "Pre-aborted input must not detach",
  );
  const during = new AbortController();
  const pending = loadIfc(source.slice(0), during.signal);
  during.abort();
  await expectError(() => pending, "AbortError");
  return {
    size: geometry.size,
    bounds,
    meshes: geometry.meshes.length,
    triangles: mesh.indices.length / 3,
    checks:
      "geometry, units, placement, normals, transfers, empty, invalid, no geometry, pre-abort, in-flight abort",
  };
}
