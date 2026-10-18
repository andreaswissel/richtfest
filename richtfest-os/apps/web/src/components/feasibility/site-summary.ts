import type { SiteAssessmentInput, SiteReference } from "@richtfest/shared";
import type { MassingOptions } from "@richtfest/shared/site-geometry-model";
import { createEmptySiteGeometryInput } from "@richtfest/shared/site-geometry-model";
import type * as Proposals from "@richtfest/shared/site-proposals";
import { discoveryPolygons, planningLawAt, type BerlinParcel, type BerlinPlan, type BerlinSiteContext, type PlanningLaw, type SiteDiscovery } from "./site-lookups";
import { planBuildingForm, PLAN_FIGURES, PLAN_LISTED, type PlanExtraction } from "./plan-extraction";
import { BO58_CLASS_FIGURES, ordinanceForAdoption, planTypeFromRegister, regimeRules, SITE_ASSESSMENT_CONSTRAINT_KEYS, SITE_ASSESSMENT_OPTIONAL_CONSTRAINT_KEYS, type PlanRegime } from "@richtfest/shared";
const CONSTRAINT_KEYS: string[] = [...SITE_ASSESSMENT_CONSTRAINT_KEYS, ...SITE_ASSESSMENT_OPTIONAL_CONSTRAINT_KEYS];

type Draft = Omit<SiteAssessmentInput, "baseRevision">;
export type SummaryStepId = "parcel" | "basis" | "references" | "frame" | "form" | "envelope" | "upside" | "massing";
export type SummaryStep = { id: SummaryStepId; status: "done" | "kept" | "needs_input" | "failed" | "skipped"; detail?: string; values?: Record<string, string | number> };
export const SUMMARY_STEPS: SummaryStepId[] = ["parcel", "basis", "references", "frame", "form", "envelope", "upside", "massing"];
export const MAX_SUMMARY_REFERENCES = 5;
const STOREY_HEIGHT = 3;
const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const proposal = (value: number, source: string, kind: "official" | "calculated" | "estimated" | "assessment", sourceDate: string | null = null) => ({ value, source, sourceDate, kind, reviewed: false });

type Constraints = Draft["constraints"];
const FRAME = "§ 34 reference frame", GRZ2_DEFAULT = "§ 19 (4) BauNVO default";
/** Empty, or an unreviewed proposal of this kind: a changed reference selection may replace it; entered and reviewed values stay. */
const replaceable = (value: { value: number | null; source: string; reviewed: boolean } | undefined, method: string, kind: string) => !value || value.value === null || (!value.reviewed && value.source.startsWith(`${method}: ${kind}`));

/**
 * § 34 figures from the selected references: the upper end of their frame for GRZ, GFZ and storeys. Replaces only empty
 * figures and earlier frame proposals, and clears a frame proposal when no reference carries that figure any more.
 * Returns the figures it set.
 */
export function proposeFrameFigures(c: Constraints, references: SiteReference[], engine: Pick<typeof Proposals, "referenceFrame" | "siteProposalMethod">): string[] {
  const frame = engine.referenceFrame(references), method = engine.siteProposalMethod, filled: string[] = [];
  const describe = (name: string, m: { mean: number; max: number; count: number }) => `${method}: ${FRAME} ${name} mean ${round(m.mean)} – max ${round(m.max)} of ${m.count} references; comparison only`;
  const set = (key: "grz" | "gfz" | "maxFullStoreys", name: string, m: { mean: number; max: number; count: number } | null, value: (max: number) => number, note = "") => {
    if (!replaceable(c[key], method, FRAME)) return;
    if (!m) { if (c[key].value !== null) c[key] = { ...c[key], value: null, source: "" }; return; }
    const next = value(m.max);
    if (c[key].value !== next || !c[key].source.startsWith(`${method}: ${FRAME}`)) filled.push(name);
    c[key] = proposal(next, `${describe(name === "storeys" ? "storeys" : name.toUpperCase(), m)}${note}`, "estimated");
  };
  set("grz", "grz", frame.grz, (max) => round(max));
  set("gfz", "gfz", frame.gfz, (max) => round(max));
  set("maxFullStoreys", "storeys", frame.storeys, (max) => Math.max(1, Math.floor(max)), "; reported storeys are not legal full storeys");
  return filled;
}

/**
 * GRZ 2: from BauNVO 1990 (and when the version is unknown) § 19 (4) lets garages, parking, access and ancillary structures exceed GRZ by
 * 50 %, up to 0.8, unless the plan says otherwise. Earlier versions and BO 58 have no such cap, so no default is proposed and an earlier
 * default proposal is withdrawn.
 */
export function proposeGrz2Default(c: Constraints, engine: Pick<typeof Proposals, "siteProposalMethod">, regime?: Pick<PlanRegime, "ordinance"> | null) {
  if (!replaceable(c.grz2, engine.siteProposalMethod, GRZ2_DEFAULT)) return;
  const rules = regimeRules(regime);
  if (rules && rules.ancillary !== "overrun_50") { if (c.grz2?.value != null) delete c.grz2; return; }
  if (c.grz.value === null) return;
  c.grz2 = proposal(round(Math.max(c.grz.value, Math.min(0.8, c.grz.value * 1.5))), `${engine.siteProposalMethod}: ${GRZ2_DEFAULT} (GRZ + 50 %, at most 0.8); replace with the plan's figure if it deviates`, "assessment");
}

/** Storeys implied by a measured building height, at about 3.4 m per storey (ceiling and slab): a cross-check for reported storeys, which can be wrong. */
export const storeysFromHeight = (height: number | null | undefined) => (height != null && height > 0 ? Math.max(1, Math.round(height / 3.4)) : null);

/**
 * A § 34 reference for one cadastral parcel from the nearby-buildings lookup: the parcel's observed GRZ, GRZ 2 and GFZ,
 * the summed footprint, the most storeys reported on it and the tallest measured height. Null without observed coverage.
 */
export function parcelReference(parcel: BerlinParcel, discovery: SiteDiscovery): SiteReference | null {
  const buildings = discovery.references.filter((r) => r.parcelId === parcel.id);
  const base = buildings.find((r) => r.metrics?.grz?.value != null);
  if (!base?.metrics) return null;
  const tallest = <K extends "storeys" | "ridgeHeight">(key: K) => buildings.map((r) => r.metrics?.[key]).filter((m) => m?.value != null).sort((a, b) => b!.value! - a!.value!)[0];
  const footprint = buildings.reduce((sum, r) => sum + (r.metrics?.footprint?.value ?? 0), 0);
  const { grz, grz2, gfz } = base.metrics;
  return {
    id: `parcel:${parcel.id}`, parcelId: parcel.id, label: parcel.label, source: `${parcel.sourceUrl} · ${base.source}`.slice(0, 2000), note: "", polygons: parcel.polygons,
    metrics: {
      ...(grz ? { grz } : {}), ...(grz2 ? { grz2 } : {}), ...(gfz ? { gfz } : {}),
      ...(footprint > 0 ? { footprint: { value: round(footprint, 1), source: base.metrics.footprint?.source ?? base.source, sourceDate: base.metrics.footprint?.sourceDate ?? null, kind: "calculated" as const, reviewed: false } } : {}),
      ...(tallest("storeys") ? { storeys: tallest("storeys")! } : {}), ...(tallest("ridgeHeight") ? { ridgeHeight: tallest("ridgeHeight")! } : {}),
    },
  };
}

/** Corrects a reference's storeys (e.g. from its measured height); GFZ, observed as GRZ × reported storeys, scales with it. */
export function correctReferenceStoreys(reference: SiteReference, storeys: number, source: string): SiteReference {
  const m = reference.metrics ?? {}, before = m.storeys?.value ?? null;
  const gfz = m.gfz?.value != null && before ? { ...m.gfz, value: round((m.gfz.value * storeys) / before), source: `${m.gfz.source} · scaled to ${storeys} storeys`.slice(0, 2000), kind: "estimated" as const, reviewed: false }
    : m.gfz?.value == null && m.grz?.value != null ? { value: round(m.grz.value * storeys), source: `${m.grz.source} · GRZ × ${storeys} storeys`.slice(0, 2000), sourceDate: null, kind: "estimated" as const, reviewed: false } : m.gfz;
  return { ...reference, metrics: { ...m, storeys: { value: storeys, source, sourceDate: null, kind: "estimated", reviewed: false }, ...(gfz ? { gfz } : {}) } };
}

const REGIME = "planning regime";
/** Partly or wholly invalid after a court review: a person must check which Festsetzungen still apply. */
const invalidated = (review: string | null | undefined) => /unwirksam|nichtig/i.test(review ?? "");

/** Regime proposal from the register; an existing unreviewed proposal is refreshed, a reviewed one is never replaced. */
export function proposeRegime(law: PlanningLaw, adopted: BerlinPlan | undefined, current: PlanRegime | undefined, method: string): PlanRegime | null {
  if (current?.reviewed) return current;
  if (adopted) {
    const { ordinance, transitional } = ordinanceForAdoption(adopted.effectiveDate);
    const notes = [transitional ? "adopted within two years of a BauNVO change: the older version applies if the public display began earlier" : "", adopted.courtReview ? `court review: ${adopted.courtReview}` : ""].filter(Boolean).join("; ");
    return { regime: "b_plan", planType: planTypeFromRegister(adopted.planType), planName: adopted.name.slice(0, 300), adoptedOn: adopted.effectiveDate, ordinance, buildingClass: null, courtReview: adopted.courtReview ?? null,
      source: `${method}: ${REGIME} from the Berlin B-Plan register (${adopted.sourceUrl})${notes ? `; ${notes}` : ""}`.slice(0, 2000), sourceDate: adopted.effectiveDate, reviewed: false };
  }
  if (law.kind === "baunutzungsplan")
    return { regime: "baunutzungsplan", planType: null, planName: "Baunutzungsplan 1960", adoptedOn: "1961-06-30", ordinance: "bo_58", buildingClass: current?.regime === "baunutzungsplan" ? current.buildingClass : null, courtReview: null,
      source: `${method}: ${REGIME}: former West Berlin without a newer B-Plan; Baunutzungsplan 1960 with BO 58 (qualified where formally established building lines exist); read the building class from the plan map`, sourceDate: null, reviewed: false };
  return null;
}

/** Storeys, GRZ and GFZ of a BO 58 building class; replaces only empty figures and earlier building-class proposals. */
export function proposeBuildingClassFigures(c: Constraints, buildingClass: keyof typeof BO58_CLASS_FIGURES, method: string): string[] {
  const figures = BO58_CLASS_FIGURES[buildingClass], kind = "BO 58 building class", filled: string[] = [];
  const set = (key: "grz" | "gfz" | "maxFullStoreys", value: number | null) => {
    if (value === null || !replaceable(c[key], method, kind) || c[key].value === value) return;
    c[key] = proposal(value, `${method}: ${kind} ${buildingClass} (BO 58 § 7 Nr. 14); the building class is read from the Baunutzungsplan map`, "official");
    filled.push(key === "maxFullStoreys" ? "storeys" : key);
  };
  set("grz", figures.grz); set("gfz", figures.gfz); set("maxFullStoreys", figures.storeys);
  return filled;
}

/**
 * "Address in, frame out": fills what the public lookups and the deterministic proposals can supply, in task
 * order. Everything it adds is an unreviewed proposal in the draft; reviewed or entered values are never replaced.
 * A step that needs a person (an ambiguous parcel, missing plan figures) is reported instead of guessed.
 */
export function applySiteSummary<T extends Draft>(draft: T, sources: { context: BerlinSiteContext | null; contextError?: string; discovery: SiteDiscovery | null; discoveryError?: string; plan?: PlanExtraction | null }, engine: typeof Proposals, today: string): { draft: T; steps: SummaryStep[] } {
  let next: T = { ...draft, constraints: { ...draft.constraints } };
  const steps: SummaryStep[] = [];
  const step = (id: SummaryStepId, status: SummaryStep["status"], detail?: string, values?: SummaryStep["values"]) => steps.push({ id, status, ...(detail ? { detail } : {}), ...(values ? { values } : {}) });
  const finish = () => {
    for (const id of SUMMARY_STEPS) if (!steps.some((s) => s.id === id)) step(id, "skipped", "AfterParcel");
    return { draft: next, steps };
  };

  // 1. Parcel: only the single official parcel containing the address point is adopted automatically.
  const { context, discovery } = sources;
  let geometry = next.geometry ?? createEmptySiteGeometryInput();
  if (geometry.parcel) step("parcel", "kept", "ParcelKept", { parcel: geometry.parcel.label });
  else if (!context) {
    step("parcel", "failed", "LookupFailed", { message: sources.contextError ?? "" });
    return finish();
  } else {
    const containing = context.parcels.filter((p) => p.containsAddress && p.area !== null);
    if (containing.length !== 1) {
      step("parcel", "needs_input", containing.length ? "ParcelAmbiguous" : "ParcelNone");
      return finish();
    }
    const parcel = containing[0]!;
    geometry = { ...geometry, parcel: { id: parcel.id, label: parcel.label, geometry: parcel.polygons, source: parcel.sourceUrl, sourceDate: parcel.sourceDate, reviewed: false }, setbacks: [] };
    if (!next.constraints.parcelArea.reviewed)
      next.constraints.parcelArea = { value: parcel.area, source: `${parcel.sourceUrl} · ${parcel.id} · retrieved ${context.retrievedAt}`, sourceDate: parcel.sourceDate, kind: "official", reviewed: false };
    step("parcel", "done", "ParcelAdopted", { parcel: parcel.label, area: round(parcel.area!, 0) });
  }
  next = { ...next, geometry };

  // 2. Planning basis from the plan register: an adopted plan covering the address suggests a B-Plan, the Baunutzungsplan applies in
  // former West Berlin, building land elsewhere suggests § 34.
  const law = context && context.planStatus === "available" ? planningLawAt(context, context.origin) : null;
  const adopted = law?.plans.find((p) => p.status === "adopted");
  if (next.planningBasis !== "unresolved") step("basis", "kept", next.planningBasis === "b_plan" ? "BasisBPlan" : "BasisSection34");
  else if (!law) step("basis", "needs_input", "BasisUnavailable");
  else {
    // B-Plan register first, then the land-use plan: open land points to § 35, which the assessment cannot model.
    if (adopted) next = { ...next, planningBasis: "b_plan" };
    else if (law.kind === "in_progress") step("basis", "needs_input", "BasisInProgress", { plan: law.plans[0]!.name });
    else if (law.kind === "section35") { next = { ...next, planningBasis: "section35" }; step("basis", "needs_input", "BasisSection35", { landUse: law.landUse!.label }); }
    else if (law.kind === "baunutzungsplan") next = { ...next, planningBasis: "b_plan" };
    else { next = { ...next, planningBasis: "section34" }; step("basis", "done", law.landUse ? "BasisSection34Fnp" : "BasisSection34", law.landUse ? { landUse: law.landUse.label } : undefined); }
  }
  // The regime decides how GF and GRZ 2 count: plan type and BauNVO version from the register, or BO 58 for the Baunutzungsplan.
  if (next.planningBasis === "b_plan" && law && !next.planRegime?.reviewed) {
    const regime = proposeRegime(law, adopted, next.planRegime, engine.siteProposalMethod);
    if (regime) next = { ...next, planRegime: regime };
  }
  if (next.planningBasis === "b_plan" && !steps.some((s) => s.id === "basis")) {
    const regime = next.planRegime;
    if (regime?.regime === "baunutzungsplan") step("basis", "done", "BasisBaunutzungsplan", { locality: context?.locality?.name ?? "" });
    else if (adopted) step("basis", invalidated(adopted.courtReview) ? "needs_input" : "done", invalidated(adopted.courtReview) ? "BasisBPlanCourtReview" : "BasisBPlanFound", { plan: adopted.name, review: adopted.courtReview ?? "" });
  }

  // 3. § 34 references: the nearest buildings with measured coverage, outside the site itself. A person still gives each a reason.
  if (next.planningBasis !== "section34") step("references", "skipped", "ReferencesNotNeeded");
  else if (next.references.length) step("references", "kept", "ReferencesKept", { count: next.references.length });
  else if (!discovery) step("references", "failed", "LookupFailed", { message: sources.discoveryError ?? "" });
  else {
    const siteParcel = next.geometry?.parcel?.id;
    const picked: SiteReference[] = discovery.references
      .filter((r) => r.parcelId !== siteParcel && r.metrics?.grz?.value != null && r.metrics?.gfz?.value != null)
      .slice(0, MAX_SUMMARY_REFERENCES);
    if (picked.length) { next = { ...next, references: picked.map((r) => ({ ...r, note: "" })) }; step("references", "done", "ReferencesAdded", { count: picked.length }); }
    else step("references", "needs_input", "ReferencesNone");
  }

  // 4. Figures: § 34 proposes the upper end of the reference frame; a B-Plan needs its figures from the plan.
  const c = next.constraints;
  if (next.planningBasis === "section34") {
    const filled = proposeFrameFigures(c, next.references, engine);
    step("frame", filled.length ? "done" : c.grz.value !== null && c.gfz.value !== null && c.maxFullStoreys.value !== null ? "kept" : "needs_input", filled.length ? "FrameFilled" : "FrameMissing", { items: filled.join(", ") });
  } else if (next.planningBasis === "b_plan" && next.planRegime?.regime === "baunutzungsplan") {
    // Baunutzungsplan: the building class read from the plan map sets storeys, GRZ and GFZ (BO 58 § 7 Nr. 14).
    const buildingClass = next.planRegime.buildingClass;
    if (!buildingClass) step("frame", PLAN_FIGURES.every((k) => c[k].value !== null) ? "kept" : "needs_input", PLAN_FIGURES.every((k) => c[k].value !== null) ? "FrameKept" : "FrameBuildingClass");
    else {
      const filled = proposeBuildingClassFigures(c, buildingClass, engine.siteProposalMethod);
      step("frame", filled.length ? "done" : "kept", filled.length ? "FrameBuildingClass_done" : "FrameKept", { items: filled.join(", "), class: buildingClass });
    }
  } else if (next.planningBasis === "b_plan") {
    // A B-Plan sets the figures: take what was read from the plan sheet (cited, unreviewed), never neighbours.
    const plan = sources.plan, filled: string[] = [];
    for (const { key, value } of plan?.constraints ?? []) {
      const k = key as keyof typeof c;
      if (!CONSTRAINT_KEYS.includes(k) || (c[k]?.value ?? null) !== null || typeof value.value !== "number") continue;
      c[k] = { ...value, value: value.value };
      if ((PLAN_LISTED as readonly string[]).includes(k)) filled.push(k === "maxFullStoreys" ? "storeys" : k);
    }
    const facts = (plan?.facts ?? []).filter((f) => !next.planningFacts?.[f.key as keyof NonNullable<Draft["planningFacts"]>]?.value);
    if (facts.length) next = { ...next, planningFacts: { ...next.planningFacts, ...Object.fromEntries(facts.map((f) => [f.key, { ...f.value, value: String(f.value.value) }])) } };
    const missing = PLAN_FIGURES.filter((k) => c[k].value === null);
    if (filled.length) step("frame", missing.length ? "needs_input" : "done", "FramePlanExtracted", { items: filled.join(", "), plan: plan!.plan });
    else if (!missing.length) step("frame", "kept", "FrameKept");
    else if (plan?.status === "unconfigured") step("frame", "needs_input", "FramePlanUnconfigured", { plan: plan.plan });
    else if (plan?.status === "failed") step("frame", "needs_input", "FramePlanReadFailed", { plan: plan.plan, message: plan.message ?? "" });
    else if (plan) step("frame", "needs_input", "FramePlanEmpty", { plan: plan.plan });
    else step("frame", "needs_input", "FramePlanMissing");
  } else step("frame", "needs_input", next.planningBasis === "section35" ? "FrameSection35" : "FrameNeedsBasis");
  // GRZ 2: § 19 (4) BauNVO lets garages, parking, access and ancillary structures exceed GRZ by 50 %, up to 0.8, unless the plan says otherwise.
  if (next.planningBasis !== "section35") proposeGrz2Default(c, engine, next.planningBasis === "b_plan" ? next.planRegime : null);
  // Area additions default to zero only as visible, unreviewed proposals so the capacity can be shown.
  const atticRules = next.planningBasis === "b_plan" ? regimeRules(next.planRegime) : null;
  for (const key of ["additionalGrossArea", "additionalCountableArea"] as const)
    if (c[key].value === null) c[key] = proposal(0, key === "additionalCountableArea" && atticRules?.atticRooms === "count"
      ? `${engine.siteProposalMethod}: no additional area assumed; under ${atticRules.citation} habitable rooms in attics and Staffel storeys count toward GF, so enter their planned area here`
      : `${engine.siteProposalMethod}: no additional area assumed; enter Staffel or attic areas if planned`, "assessment");

  // 5. Building form from neighbours standing on the boundaries.
  const parcel = next.geometry!.parcel!;
  let inference: Proposals.BuildingFormInference | null = null;
  if (!discovery) step("form", "failed", "LookupFailed", { message: sources.discoveryError ?? "" });
  else {
    inference = engine.inferBuildingForm(parcel, discovery.buildings.map((b) => ({ id: b.id, label: b.label, polygons: discoveryPolygons(discovery, b) })));
    const rules = next.designRules;
    // The Baunutzungsplan's building class fixes the form: II/1 and II/2 open, from II/3 closed (BO 58 § 7 Nr. 16).
    const buildingClass = next.planningBasis === "b_plan" && next.planRegime?.regime === "baunutzungsplan" ? next.planRegime.buildingClass : null;
    const planFact = next.planningBasis === "b_plan" ? next.planningFacts?.buildingForm ?? (buildingClass ? { value: BO58_CLASS_FIGURES[buildingClass].buildingForm, source: `${engine.siteProposalMethod}: BO 58 § 7 Nr. 16, building class ${buildingClass}` } : undefined) : undefined;
    const planForm = planFact ? planBuildingForm(planFact.value) : null;
    if (rules && (rules.reviewed || rules.buildingForm !== "unresolved")) step("form", "kept", "FormKept");
    // The plan's Bauweise wins over what the neighbours suggest.
    else if (planFact && planForm) {
      next = { ...next, designRules: { maxHeight: rules?.maxHeight ?? null, heightNotSpecified: rules?.heightNotSpecified ?? false, buildingForm: planForm, source: planFact.source, sourceDate: null, reviewed: false } };
      step("form", "done", planForm === "closed" ? "FormPlanClosed" : "FormPlanOpen");
    }
    else if (inference.form === "unresolved") step("form", "needs_input", `Form_${inference.reason}`);
    else {
      const source = `${inference.method}: ${inference.form === "closed" ? `neighbours on ${inference.builtTo.length} parcel boundaries` : `${inference.neighbours} nearby buildings keep a boundary distance`} (public footprints, ±${engine.BOUNDARY_TOLERANCE_M} m); verify on site`;
      next = { ...next, designRules: { maxHeight: rules?.maxHeight ?? null, heightNotSpecified: rules?.heightNotSpecified ?? false, buildingForm: inference.form, source, sourceDate: null, reviewed: false } };
      step("form", "done", inference.form === "closed" ? "FormClosed" : "FormOpen", { count: inference.form === "closed" ? inference.builtTo.length : inference.neighbours });
    }
  }

  // 6. Setback hull and envelope from the figures so far.
  // Closed form builds to the boundaries the neighbours actually stand on; other edges keep the standard distance.
  const envelope = engine.proposeEnvelope(next, inference && next.designRules?.buildingForm === "closed" ? inference : null, STOREY_HEIGHT);
  if (!envelope.ok) step("envelope", envelope.reason === "needs_height" ? "needs_input" : "failed", envelope.reason === "needs_height" ? "EnvelopeNeedsHeight" : "EnvelopeFailed");
  else {
    next = { ...next, geometry: envelope.geometry };
    if (!next.constraints.buildableFootprint.reviewed)
      next.constraints.buildableFootprint = proposal(round(envelope.usableArea), `${engine.siteProposalMethod}: ${envelope.envelopeBasis === "traced" ? "traced Baugrenze" : "parcel"} less setbacks (H = ${round(envelope.height)} m)`, "calculated", today);
    step("envelope", "done", "EnvelopeProposed", { area: round(envelope.usableArea, 0), height: round(envelope.height, 1) });
  }

  // 7. Exemption scenario: one additional full storey, kept separate from the baseline.
  const storeys = next.constraints.maxFullStoreys.value;
  if (next.upside) step("upside", "kept", "UpsideKept");
  else if (storeys === null) step("upside", "needs_input", "EnvelopeNeedsHeight");
  else {
    next = { ...next, upside: { maxFullStoreys: proposal(storeys + 1, `${engine.siteProposalMethod}: one additional full storey by exemption (§ 31 (3) or § 34 (3b) BauGB); requires municipal consent`, "assessment"), note: "" } };
    step("upside", "done", "UpsideProposed", { storeys: storeys + 1 });
  }

  // 8. Massing that uses the frame, between the real neighbours.
  const options = massingOptions(next.constraints);
  if (next.geometry!.buildings.length) step("massing", "kept", "MassingKept");
  else if (!options || !envelope.ok) step("massing", "needs_input", "MassingNeedsFigures");
  else {
    const best = engine.bestMassing(next.geometry!, options);
    if (!best) step("massing", "failed", "MassingNone");
    else { next = { ...next, geometry: { ...next.geometry!, buildings: [best.building] } }; step("massing", "done", "MassingPlaced", { area: round(best.metrics.grossFloorArea, 0) }); }
  }
  return { draft: next, steps };
}

export function massingOptions(constraints: Draft["constraints"], storeys?: number | null): MassingOptions | null {
  const { grz, gfz, maxFullStoreys } = constraints;
  const full = storeys ?? maxFullStoreys.value;
  return grz.value && gfz.value && full ? { grz: grz.value, gfz: gfz.value, maxFullStoreys: full, storeyHeight: STOREY_HEIGHT } : null;
}
