import { createRequire } from "node:module";
import type { IfcBuildingEntity, IfcBuildingPreview, IfcFootprint } from "@richtfest/shared";
import { unionGeometry, type GeometryMultiPolygon } from "@richtfest/shared/site-geometry";
import { extractIfcModel } from "./ifc-model";

const require = createRequire(import.meta.url);
const webIfc = require("web-ifc") as typeof import("web-ifc");

/** Separate from source claims: deterministic, unreviewed orthographic mesh projections, not floor cuts. */
export async function extractIfcBuildingModel(bytes: Uint8Array): Promise<IfcBuildingPreview> {
  const source = await extractIfcModel(bytes);
  const api = new webIfc.IfcAPI();
  let model: number | undefined;
  try {
    await api.Init(() => require.resolve("web-ifc/web-ifc-node.wasm"), true);
    model = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
    if (model < 0) throw new Error("Invalid IFC model");
    const ids = (type: number) => {
      const values = api.GetLineIDsWithType(model!, type, true);
      try { return new Set(Array.from({ length: values.size() }, (_, i) => values.get(i))); }
      finally { (values as typeof values & { delete(): void }).delete(); }
    };
    const buildings = ids(webIfc.IFCBUILDING), storeys = ids(webIfc.IFCBUILDINGSTOREY);
    const spaces = ids(webIfc.IFCSPACE), elements = ids(webIfc.IFCELEMENT);
    const parents = new Map<number, Set<number>>();
    for (const fact of source.facts) if (["containedIn", "decomposes", "nestedIn"].includes(fact.predicate) && fact.value.type === "reference") {
      const child = Number(fact.entityKey.slice(1)), parent = Number(fact.value.value.slice(1));
      const set = parents.get(child) ?? new Set<number>(); set.add(parent); parents.set(child, set);
    }
    const ancestor = (id: number, candidates: Set<number>): number | undefined => {
      const seen = new Set<number>();
      while (!seen.has(id)) {
        if (candidates.has(id)) return id;
        seen.add(id);
        const next = parents.get(id);
        if (next?.size !== 1) return undefined;
        id = [...next][0];
      }
      return undefined;
    };
    const warnings: IfcBuildingPreview["warnings"] = [];
    let unmapped = 0;
    const entities: IfcBuildingEntity[] = [];
    for (const item of source.entities) {
      const id = Number(item.key.slice(1));
      const entityType = buildings.has(id) ? "building" : storeys.has(id) ? "storey" : spaces.has(id) ? "room" : elements.has(id) ? "element" : null;
      if (!entityType) continue;
      const building = ancestor(id, buildings), storey = ancestor(id, storeys);
      if (!building || (["room", "element"].includes(entityType) && !storey)) { unmapped++; continue; }
      const longName = entityType === "room" ? api.GetLine(model, id)?.LongName?.value : undefined;
      const name = typeof longName === "string" && longName.trim() && longName !== item.name ? [item.name, longName].filter(Boolean).join(" · ") : item.name;
      entities.push({ expressId: id, globalId: item.globalId, name: name || `${item.kind} #${id}`,
        ifcType: item.kind, entityType, buildingExpressId: building, storeyExpressId: storey, geometry: null });
    }
    if (!entities.some(e => e.entityType === "storey")) throw new Error("IFC has no storeys with an unambiguous building assignment");
    const byId = new Map(entities.map(e => [e.expressId, e]));
    let failedGeometry = 0;
    api.StreamMeshes(model, entities.filter(e => ["room", "element"].includes(e.entityType)).map(e => e.expressId), mesh => {
      const entity = byId.get(mesh.expressID)!;
      const triangles: GeometryMultiPolygon[] = [];
      let low = Infinity, high = -Infinity;
      try {
        for (let g = 0; g < mesh.geometries.size(); g++) {
          const placed = mesh.geometries.get(g), matrix = placed.flatTransformation;
          const geometry = api.GetGeometry(model!, placed.geometryExpressID);
          try {
            const vertices = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
            const indices = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
            const points: [number, number][] = [];
            for (let i = 0; i < vertices.length; i += 6) {
              const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
              const world = [0, 1, 2].map(a => matrix[a] * x + matrix[4 + a] * y + matrix[8 + a] * z + matrix[12 + a]);
              if (!world.every(Number.isFinite)) throw new Error("Non-finite IFC geometry");
              // web-ifc returns Y-up, scaled to metres. Restore IFC X/Y plan and Z elevation.
              // Micrometre quantization removes floating-point seams before polygon union.
              points.push([Math.round(world[0] * 1e6) / 1e6, Math.round(-world[2] * 1e6) / 1e6]);
              low = Math.min(low, world[1]); high = Math.max(high, world[1]);
            }
            for (let i = 0; i < indices.length; i += 3) {
              const a = points[indices[i]], b = points[indices[i + 1]], c = points[indices[i + 2]];
              if (!a || !b || !c) throw new Error("Invalid IFC mesh indices");
              const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
              if (Math.abs(area) > 1e-8) triangles.push([[[a, b, c, a]]]);
            }
          } finally { geometry.delete(); }
        }
        // Bounded batches avoid argument limits on tessellated products; union preserves holes/disconnected parts.
        let footprint: GeometryMultiPolygon = [];
        for (let i = 0; i < triangles.length; i += 100) footprint = unionGeometry(footprint, ...triangles.slice(i, i + 100));
        if (footprint.length) entity.geometry = { coordinateSpace: "ifc-metre", method: "mesh-plan-projection-v1", footprint, elevationRange: [low, high] } satisfies IfcFootprint;
      } catch { failedGeometry++; }
    }, true);
    // Composite walls often carry no representation themselves: their declared parts do.
    const compose = (entity: IfcBuildingEntity, seen = new Set<number>()): IfcFootprint | null => {
      if (entity.geometry || seen.has(entity.expressId)) return entity.geometry;
      seen.add(entity.expressId);
      const children = entities.filter(e => e.entityType === "element" && parents.get(e.expressId)?.size === 1 && parents.get(e.expressId)?.has(entity.expressId));
      const geometries = children.map(child => compose(child, seen));
      if (!children.length || geometries.some(g => !g)) return null;
      try {
        entity.geometry = { coordinateSpace: "ifc-metre", method: "mesh-plan-projection-v1",
          footprint: unionGeometry(...geometries.map(g => g!.footprint)),
          elevationRange: [Math.min(...geometries.map(g => g!.elevationRange[0])), Math.max(...geometries.map(g => g!.elevationRange[1]))],
          composedFromExpressIds: children.map(e => e.expressId) };
      } catch { failedGeometry++; }
      return entity.geometry;
    };
    for (const entity of entities) if (entity.entityType === "element") compose(entity);
    const missingGeometry = entities.filter(e => ["room", "element"].includes(e.entityType) && !e.geometry).length;
    if (unmapped) warnings.push({ code: "unmapped", count: unmapped });
    if (missingGeometry) warnings.push({ code: "missingGeometry", count: missingGeometry });
    if (failedGeometry) warnings.push({ code: "failedGeometry", count: failedGeometry });
    const absent = ["IFCSLAB", "IFCWINDOW", "IFCSTAIR", "IFCROOF"].filter(type => !source.entities.some(e => e.kind === type));
    if (absent.length) warnings.push({ code: "missingClasses", count: absent.length, detail: absent.join(", ") });
    const doorKeys = new Set(source.entities.filter(e => e.kind === "IFCDOOR").map(e => e.key));
    const externalDoors = new Set(source.facts.filter(f => doorKeys.has(f.entityKey) && /\.IsExternal$/.test(f.predicate) && f.value.type === "boolean" && f.value.value).map(f => f.entityKey));
    if (doorKeys.size && externalDoors.size === doorKeys.size) warnings.push({ code: "allDoorsExternal", count: doorKeys.size });
    const spaceKeys = new Set(source.entities.filter(e => e.kind === "IFCSPACE").map(e => e.key));
    const assignments = source.facts.filter(f => spaceKeys.has(f.entityKey) && /\.(Einheitennummer|ApartmentNumber|UnitNumber)$/i.test(f.predicate) && f.value.type === "text" && f.value.value.trim());
    if (spaceKeys.size > 1 && new Set(assignments.map(f => f.entityKey)).size === spaceKeys.size && new Set(assignments.map(f => JSON.stringify(f.value))).size === 1)
      warnings.push({ code: "identicalUnits", count: spaceKeys.size });
    const fireKeys = new Set(source.facts.filter(f => /\.(FireRating|Brandschutz|Feuerwiderstand)$/i.test(f.predicate) && f.value.type === "text" && f.value.value.trim()).map(f => f.entityKey));
    const unrated = source.entities.filter(e => /^(IFCWALL|IFCWALLSTANDARDCASE|IFCDOOR)$/.test(e.kind) && !fireKeys.has(e.key)).length;
    if (unrated) warnings.push({ code: "missingFireRatings", count: unrated });
    return { schema: String(source.metadata.schema), parserVersion: api.GetVersion(), entities, warnings };
  } finally {
    if (model !== undefined && model >= 0) api.CloseModel(model);
    api.Dispose();
  }
}
