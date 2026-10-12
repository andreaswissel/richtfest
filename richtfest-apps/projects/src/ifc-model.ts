import { createRequire } from "node:module";
import type { SourceModelImport, SourceFactInput, SourceValue } from "@richtfest/shared";
import type { IfcAPI } from "web-ifc";

const require = createRequire(import.meta.url);
const webIfc = require("web-ifc") as typeof import("web-ifc");
type Line = Record<string, any>;

export function isIfcSource(mimeType: string, name: string): boolean {
  return /\.ifc$/i.test(name) || ["application/x-step", "application/ifc", "application/x-ifc"].includes(mimeType.split(";")[0].trim().toLowerCase());
}

/** Declared source claims only. No flattening, meshes, conversions or inferred quantities. */
export async function extractIfcModel(bytes: Uint8Array): Promise<SourceModelImport> {
  const api: IfcAPI = new webIfc.IfcAPI();
  let model: number | undefined;
  try {
    await api.Init(() => require.resolve("web-ifc/web-ifc-node.wasm"), true);
    model = api.OpenModel(bytes);
    if (model < 0) throw new Error("Invalid or unsupported IFC source");
    const schema = api.GetModelSchema(model);
    if (!["IFC2X3", "IFC4"].includes(schema)) throw new Error(`Unsupported IFC schema: ${schema || "unknown"}`);
    const read = (id: number): Line => {
      const line = api.GetLine(model!, id, false, false);
      if (!line || line.expressID !== id) throw new Error(`Malformed IFC entity #${id}`);
      return line;
    };
    const ids = (type: number): number[] => {
      const vector = api.GetLineIDsWithType(model!, type, true);
      try { return Array.from({ length: vector.size() }, (_, i) => vector.get(i)).sort((a, b) => a - b); }
      finally { (vector as typeof vector & { delete(): void }).delete(); }
    };
    const kind = (line: Line) => api.GetNameFromTypeCode(line.type).toUpperCase();
    const key = (id: number) => `#${id}`;
    const ref = (v: any): number | undefined => v?.type === 5 && Number.isInteger(v.value) ? v.value : undefined;
    const label = (v: any): string => typeof v?.value === "string" ? v.value : "";
    const pack = (v: any): any => {
      if (v === null || v === undefined) return v ?? null;
      if (Array.isArray(v)) return v.map(pack);
      if (ref(v)) return { reference: key(v.value) };
      if (v.name === "IFCLOGICAL" && v.value === undefined) return { ifcType: v.name, value: "unknown" };
      // Numeric wrappers expose value through an accessor, not Object.entries.
      if (v.name && "value" in v) return { ifcType: v.name, value: pack(v.value) };
      if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, pack(value)]));
      return v;
    };
    const value = (v: any): SourceValue | undefined => {
      if (v == null) return undefined;
      if (ref(v)) return { type: "reference", value: key(v.value) };
      if (v.name === "IFCLOGICAL" && v.value === undefined) return { type: "logical", value: "unknown" };
      const scalar = v.value;
      if (typeof scalar === "boolean") return { type: "boolean", value: scalar };
      if (typeof scalar === "number" && Number.isFinite(scalar)) return { type: "number", value: scalar };
      if (typeof scalar === "string") return { type: "text", value: scalar };
      return { type: "structured", value: pack(v) };
    };
    const objectIds = ids(webIfc.IFCOBJECTDEFINITION);
    if (!objectIds.length) throw new Error("Malformed or empty IFC source: no object definitions");
    const objects = new Set(objectIds);
    const facts: SourceFactInput[] = [];
    const omittedForms = new Set<string>();
    const defaults = new Map<string, Line[]>();
    for (const project of ids(webIfc.IFCPROJECT)) {
      const assignment = ref(read(project).UnitsInContext);
      if (!assignment) continue;
      for (const u of read(assignment).Units ?? []) {
        if (!ref(u)) continue;
        const unit = read(u.value);
        const type = label(unit.UnitType);
        defaults.set(type, [...(defaults.get(type) ?? []), { project: key(project), ...unit }]);
      }
    }
    const unitType = (ifcType: string): string | undefined => {
      const types: Record<string, string> = { WEIGHT: "MASSUNIT", COUNT: "", NUMERIC: "", REAL: "", INTEGER: "", NORMALISEDRATIO: "", RATIO: "" };
      const stem = ifcType.replace(/^IFC(?:QUANTITY)?/, "").replace(/MEASURE$/, "").replace(/^POSITIVE|^NONNEGATIVE/, "");
      // Only apply a default if that precise unit category is declared by a project.
      return types[stem] ?? (ifcType.endsWith("MEASURE") || ifcType.startsWith("IFCQUANTITY") ? `${stem}UNIT` : undefined);
    };
    const unitInfo = (explicit: any, ifcType: string): Record<string, unknown> | null => {
      const id = ref(explicit);
      if (id) return { source: "explicit", expressId: id, definition: pack(read(id)) };
      const candidates = defaults.get(unitType(ifcType) ?? "") ?? [];
      return candidates.length ? { source: "project-default", candidates: candidates.map(pack), ambiguous: candidates.length > 1 } : null;
    };
    const add = (entity: number, predicate: string, factKind: SourceFactInput["kind"], v: any, source: number, attribute: string,
      relationshipId?: number, unit: Record<string, unknown> | null = null, ifcType?: string) => {
      const converted = value(v);
      if (!converted) return;
      facts.push({ entityKey: key(entity), predicate, kind: factKind, value: converted, unit, provenance: "deterministic",
        evidence: { kind: "ifc", expressId: source, attribute, ...(relationshipId ? { relationshipId } : {}), ...((ifcType || v?.name) ? { dataType: ifcType ?? v.name } : {}) } });
    };
    const entities = objectIds.map(id => {
      const line = read(id);
      for (const [attribute, v] of Object.entries(line)) {
        if (["expressID", "type", "OwnerHistory", "ObjectPlacement", "Representation"].includes(attribute) || v == null || Array.isArray(v) || ref(v)) continue;
        add(id, attribute, "attribute", v, id, attribute, undefined, unitInfo(null, v?.name ?? ""));
      }
      return { key: key(id), kind: kind(line), name: label(line.Name), ...(label(line.GlobalId) ? { globalId: label(line.GlobalId) } : {}) };
    });
    const importSet = (entity: number, setId: number, scope: string, relationshipId?: number) => {
      const set = read(setId);
      const members = set.HasProperties ?? set.Quantities;
      if (!Array.isArray(members)) { omittedForms.add(kind(set)); add(entity, `${scope}.${label(set.Name) || key(setId)}`, "property", set, setId, "definition", relationshipId); return; }
      const visit = (id: number, path: string, ancestors: Set<number>) => {
        if (ancestors.has(id)) throw new Error(`Cyclic IFC property/quantity #${id}`);
        const p = read(id), type = kind(p);
        const predicate = `${path}.${label(p.Name) || key(id)}`;
        const children = p.HasProperties ?? p.HasQuantities;
        if (Array.isArray(children)) {
          for (const child of children) if (ref(child)) visit(child.value, predicate, new Set([...ancestors, id]));
        } else if (type === "IFCPROPERTYSINGLEVALUE") {
          add(entity, predicate, "property", p.NominalValue, id, "NominalValue", relationshipId, unitInfo(p.Unit, p.NominalValue?.name ?? ""));
        } else if (type.startsWith("IFCQUANTITY")) {
          const attr = Object.keys(p).find(k => k.endsWith("Value"));
          if (attr) add(entity, predicate, "quantity", p[attr], id, attr, relationshipId, unitInfo(p.Unit, type), p[attr]?.name ?? type);
          else { omittedForms.add(type); add(entity, predicate, "quantity", p, id, "definition", relationshipId); }
        } else {
          omittedForms.add(type);
          add(entity, predicate, "property", p, id, "definition", relationshipId);
        }
      };
      for (const member of members) if (ref(member)) visit(member.value, `${scope}.${label(set.Name) || key(setId)}`, new Set([setId]));
    };
    for (const id of objectIds) for (const set of read(id).HasPropertySets ?? []) if (ref(set)) importSet(id, set.value, "type");
    for (const id of ids(webIfc.IFCRELDEFINESBYPROPERTIES)) {
      const rel = read(id);
      // IFC4 permits an aggregate select of definitions as well as a single reference.
      const sets = Array.isArray(rel.RelatingPropertyDefinition) ? rel.RelatingPropertyDefinition : [rel.RelatingPropertyDefinition];
      for (const obj of rel.RelatedObjects ?? []) if (objects.has(ref(obj)!)) for (const set of sets) if (ref(set)) importSet(obj.value, set.value, "instance", id);
    }
    for (const [type, related, relating, predicate] of [
      [webIfc.IFCRELDEFINESBYTYPE, "RelatedObjects", "RelatingType", "type"],
      [webIfc.IFCRELCONTAINEDINSPATIALSTRUCTURE, "RelatedElements", "RelatingStructure", "containedIn"],
      [webIfc.IFCRELAGGREGATES, "RelatedObjects", "RelatingObject", "decomposes"],
      [webIfc.IFCRELNESTS, "RelatedObjects", "RelatingObject", "nestedIn"],
    ] as const) for (const id of ids(type)) {
      const rel = read(id);
      for (const obj of rel[related] ?? []) if (objects.has(ref(obj)!) && ref(rel[relating])) add(obj.value, predicate, "relationship", rel[relating], id, relating, id);
    }
    return { entities, facts, metadata: { schema, parser: "web-ifc", parserVersion: api.GetVersion(),
      importScope: "Object definitions and scalar attributes; occurrence/type property sets; declared quantities; type, containment and decomposition references",
      omissions: ["Geometry, placements and owner history are not traversed", "No calculated quantities, unit conversion or inherited type-property merging", "Other IFC relationships and non-scalar object attributes are not imported", "Non-single property forms are structured declarations with unresolved references", "Unit definitions retain unresolved component references; defaults require a matching declared unit category", "Parsing is not exhaustive IFC schema or reference validation"],
      structuredPropertyForms: [...omittedForms].sort() } };
  } finally {
    if (model !== undefined && model >= 0) api.CloseModel(model);
    api.Dispose();
  }
}
