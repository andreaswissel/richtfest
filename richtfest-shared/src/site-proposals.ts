/**
 * Unreviewed proposals for the Berlin site assessment: building form from
 * neighbouring footprints, setbacks and a buildable envelope from the
 * confirmed figures, and a § 34 frame from selected references. Every result
 * is a starting point for review, never a planning determination.
 */
import { calculateSiteGeometry, createDefaultSetbacks, generateMassingCandidates, geometryArea, intersectGeometry } from "./site-geometry";
import type { EdgeSetback, GeometryEvidence, GeometryMultiPolygon, GeometryPoint, MassingCandidate, MassingOptions, SiteGeometryInput } from "./site-geometry-model";
import { createEmptySiteGeometryInput } from "./site-geometry-model";
import { compareSiteReferences, type SiteReference } from "./site-references";
import type { SiteAssessmentInput } from "./site-assessment";

export const siteProposalMethod = "berlin_proposals_v1" as const;
/** Cadastral footprints and parcel boundaries rarely coincide exactly; 0.5 m still means "on the boundary". */
export const BOUNDARY_TOLERANCE_M = 0.5;
/** A shared facade shorter than this (e.g. a garage corner) does not establish building to the boundary. */
export const MIN_BOUNDARY_CONTACT_M = 3;
const NEARBY_M = 30;
export const DEFAULT_STOREY_HEIGHT_M = 3;

export type NeighbourBuilding = { id: string; label: string; polygons: GeometryMultiPolygon };
export type BoundaryEdge = { id: string; polygonIndex: number; ringIndex: number; edgeIndex: number; length: number; contact: number; neighbours: string[]; distance: number | null };
export type BuildingFormInference = {
  method: typeof siteProposalMethod;
  form: "open" | "closed" | "unresolved";
  reason: "built_to_several_boundaries" | "free_standing_neighbours" | "built_to_one_boundary" | "no_neighbours";
  edges: BoundaryEdge[];
  builtTo: string[];
  neighbours: number;
};

const pointSegmentDistance = (p: GeometryPoint, a: GeometryPoint, b: GeometryPoint) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
  const t = length2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

/**
 * Neighbouring buildings standing on a parcel boundary suggest closed building form (BauNVO § 22 (3));
 * neighbours keeping their distance suggest open form. One-sided contact stays unresolved (semi-detached,
 * end of terrace or a deviating form). Buildings mostly on the site itself are existing stock, not neighbours.
 */
export function inferBuildingForm(parcel: GeometryEvidence, buildings: NeighbourBuilding[]): BuildingFormInference {
  const site = parcel.geometry;
  const neighbours = buildings.filter((building) => {
    const area = geometryArea(building.polygons);
    return area > 0 && geometryArea(intersectGeometry(building.polygons, site)) < area * 0.5;
  });
  const edges: BoundaryEdge[] = [];
  const nearby = new Set<string>();
  for (const setback of createDefaultSetbacks(parcel)) {
    const ring = site[setback.polygonIndex]![setback.ringIndex]!;
    const a = ring[setback.edgeIndex]!, b = ring[setback.edgeIndex + 1]!;
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (length < 0.01) continue;
    const along = (p: GeometryPoint) => ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length;
    const offset = (p: GeometryPoint) => Math.abs(dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / length;
    let contact = 0, distance: number | null = null;
    const touching = new Set<string>();
    for (const building of neighbours) {
      for (const polygon of building.polygons) {
        const outer = polygon[0]!;
        for (const p of outer) {
          const d = pointSegmentDistance(p, a, b);
          if (d > NEARBY_M) continue;
          nearby.add(building.id);
          if (distance === null || d < distance) distance = d;
        }
        for (let i = 0; i < outer.length - 1; i++) {
          const p = outer[i]!, q = outer[i + 1]!;
          if (offset(p) > BOUNDARY_TOLERANCE_M || offset(q) > BOUNDARY_TOLERANCE_M) continue;
          const overlap = Math.min(length, Math.max(along(p), along(q))) - Math.max(0, Math.min(along(p), along(q)));
          if (overlap <= 0) continue;
          contact += overlap;
          touching.add(building.id);
        }
      }
    }
    edges.push({ id: setback.id, polygonIndex: setback.polygonIndex, ringIndex: setback.ringIndex, edgeIndex: setback.edgeIndex, length, contact: Math.min(length, contact), neighbours: [...touching], distance });
  }
  const builtTo = edges.filter((edge) => edge.contact >= Math.min(MIN_BOUNDARY_CONTACT_M, edge.length * 0.8)).map((edge) => edge.id);
  const base = { method: siteProposalMethod, edges, builtTo, neighbours: nearby.size };
  if (builtTo.length >= 2) return { ...base, form: "closed", reason: "built_to_several_boundaries" };
  if (builtTo.length === 1) return { ...base, form: "unresolved", reason: "built_to_one_boundary" };
  if (nearby.size > 0) return { ...base, form: "open", reason: "free_standing_neighbours" };
  return { ...base, form: "unresolved", reason: "no_neighbours" };
}

/** H for the § 6 setback: a confirmed maximum height wins; otherwise full storeys × storey height. */
export function proposedSetbackHeight(input: Pick<SiteAssessmentInput, "constraints" | "designRules">, storeyHeight = DEFAULT_STOREY_HEIGHT_M): { value: number; basis: "max_height" | "full_storeys" } | null {
  const rules = input.designRules;
  if (rules && !rules.heightNotSpecified && rules.maxHeight !== null) return { value: rules.maxHeight, basis: "max_height" };
  const storeys = input.constraints.maxFullStoreys.value;
  return storeys === null ? null : { value: storeys * storeyHeight, basis: "full_storeys" };
}

/**
 * Reviewed setbacks are kept. Other edges get the Berlin standard profile (0.4 H, at least 3 m) from the
 * proposed height, or zero where closed building form puts the building on that boundary.
 */
export function proposeSetbacks(parcel: GeometryEvidence, existing: EdgeSetback[], height: number, boundaryEdgeIds: Set<string>, heightNote: string): EdgeSetback[] {
  return createDefaultSetbacks(parcel).map((edge) => {
    const kept = existing.find((e) => e.polygonIndex === edge.polygonIndex && e.ringIndex === edge.ringIndex && e.edgeIndex === edge.edgeIndex);
    if (kept?.reviewed) return kept;
    if (boundaryEdgeIds.has(edge.id))
      return { ...edge, profile: "boundary_exception", distance: 0, source: `${siteProposalMethod}: neighbouring building on this boundary (closed building form proposal); verify the planning-law basis`, sourceDate: null, reviewed: false };
    return { ...edge, profile: "standard", heightSource: "manual", assessmentHeight: height, reviewedHeight: null, distance: null, source: `${siteProposalMethod}: BauO Bln § 6 standard profile 0.4 H, at least 3 m; ${heightNote}`, sourceDate: null, reviewed: false };
  });
}

export type EnvelopeProposal =
  | { ok: true; geometry: SiteGeometryInput; height: number; heightBasis: "max_height" | "full_storeys"; usableArea: number; envelopeBasis: "traced" | "parcel"; boundaryEdges: string[] }
  | { ok: false; reason: "needs_parcel" | "needs_height" | "geometry_failed" };

/**
 * A traced Baugrenze is kept as the envelope; without one the whole parcel is the envelope and the setback
 * hull alone limits it. Berlin publishes no machine-readable Baugrenzen, so lines are never inferred from a plan image.
 */
export function proposeEnvelope(input: Pick<SiteAssessmentInput, "constraints" | "designRules" | "geometry">, inference: BuildingFormInference | null, storeyHeight = DEFAULT_STOREY_HEIGHT_M): EnvelopeProposal {
  const geometry = input.geometry ?? createEmptySiteGeometryInput();
  const parcel = geometry.parcel;
  if (!parcel) return { ok: false, reason: "needs_parcel" };
  const height = proposedSetbackHeight(input, storeyHeight);
  if (!height) return { ok: false, reason: "needs_height" };
  const boundaryEdges = inference?.form === "closed" ? inference.builtTo : [];
  const heightNote = height.basis === "max_height" ? `H = ${height.value} m maximum height` : `H = ${input.constraints.maxFullStoreys.value} full storeys × ${storeyHeight} m`;
  const envelope: GeometryEvidence = geometry.envelope ?? { id: "envelope-proposed", label: "Buildable envelope", geometry: parcel.geometry, source: `${siteProposalMethod}: whole parcel; no Baugrenze traced`, sourceDate: null, reviewed: false };
  const next: SiteGeometryInput = { ...geometry, envelope, setbacks: proposeSetbacks(parcel, geometry.setbacks, height.value, new Set(boundaryEdges), heightNote) };
  const result = calculateSiteGeometry({ ...next, buildings: [] });
  if (result.status === "incomplete") return { ok: false, reason: "geometry_failed" };
  return { ok: true, geometry: next, height: height.value, heightBasis: height.basis, usableArea: result.usableArea, envelopeBasis: geometry.envelope ? "traced" : "parcel", boundaryEdges };
}

export type ReferenceFrame = { grz: { mean: number; max: number; count: number } | null; gfz: { mean: number; max: number; count: number } | null; storeys: { mean: number; max: number; count: number } | null };
/** § 34 frame as the span from mean to maximum of the selected references. Descriptive, not an entitlement. */
export function referenceFrame(references: SiteReference[]): ReferenceFrame {
  const c = compareSiteReferences(references);
  const pick = (m: (typeof c)[keyof typeof c]) => (m ? { mean: m.mean, max: m.max, count: m.count } : null);
  return { grz: pick(c.grz), gfz: pick(c.gfz), storeys: pick(c.storeys) };
}

/** The densest bounded massing for the given limits, or null when nothing fits. */
export function bestMassing(geometry: SiteGeometryInput, options: MassingOptions): MassingCandidate | null {
  return generateMassingCandidates({ ...geometry, buildings: [] }, options)[0] ?? null;
}
