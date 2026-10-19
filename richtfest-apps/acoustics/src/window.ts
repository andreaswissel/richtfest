import type { AcousticNormPack, Glazing, WindowCorrection, WindowRw, WindowRwInput } from "@richtfest/shared";

type Row = NonNullable<AcousticNormPack["din4109_35"]>["insulatingGlass"][number];

/** Whether a glazing build-up meets a row: total glass thickness or the two outer panes, and the summed cavities. */
function glazingMeets(glazing: Glazing, buildUp: NonNullable<Row["buildUp"]>) {
  const cavity = glazing.cavitiesMm.reduce((sum, value) => sum + value, 0);
  if (cavity < buildUp.cavityMinMm) return false;
  if (buildUp.totalMinMm !== undefined && glazing.panesMm.reduce((sum, value) => sum + value, 0) < buildUp.totalMinMm) return false;
  if (buildUp.panesMinMm) {
    const outer = [glazing.panesMm[0]!, glazing.panesMm[glazing.panesMm.length - 1]!].sort((a, b) => b - a);
    if (outer[0]! < buildUp.panesMinMm[0] || outer[1]! < buildUp.panesMinMm[1]) return false;
  }
  return true;
}

/**
 * Rw of a single window with insulating glass from the window catalogue: the
 * highest row its declared glass Rw or glazing build-up and its rebate seals
 * meet, plus the corrections for its frame, opening, size and glazing bars.
 * A condition nobody entered is taken at its least favourable, so the value
 * errs low and says which corrections were assumed. Every number comes from
 * the pack.
 */
export function catalogueWindowRw(pack: AcousticNormPack, input: WindowRwInput): WindowRw {
  const catalogue = pack.din4109_35;
  if (!catalogue) return { status: "unavailable", reason: "catalogue_missing" };
  if (input.glassRwDb === null && !input.glazing) return { status: "unavailable", reason: "glazing_missing" };
  const assumptions: Extract<WindowRw, { status: "calculated" }>["assumptions"] = ["insulating_glass_single_window"];
  if (input.seals === null) assumptions.push("seals_assumed");
  if (input.frame === null) assumptions.push("frame_unknown");
  // Without a count, one circumferential seal: every modern window has at least that.
  const seals = input.seals ?? 1;
  const row = catalogue.insulatingGlass
    .filter(item => seals >= (input.frame === "wood" ? item.woodSeals : item.seals))
    .filter(item => (input.glassRwDb !== null && input.glassRwDb >= item.glassRwMinDb) || (input.glazing && item.buildUp && glazingMeets(input.glazing, item.buildUp)))
    .reduce<Row | null>((best, item) => !best || item.rwDb > best.rwDb ? item : best, null);
  if (!row) return { status: "unavailable", reason: "below_catalogue" };
  const corrections: Array<{ kind: WindowCorrection; db: number; assumed: boolean }> = [];
  // A known condition applies its correction; an unknown one applies only when that lowers the value.
  const apply = (kind: WindowCorrection, value: number, applies: boolean | null) => {
    if (value === 0) return;
    if (applies === true || (applies === null && value < 0)) corrections.push({ kind, db: value, assumed: applies === null });
  };
  if (input.frame === "wood_aluminium") corrections.push({ kind: "wood_aluminium", db: catalogue.woodAluminiumDb, assumed: false });
  const { frameShare, twinSash, fixedGlazing, smallWindow, glazingBars } = row.corrections;
  // The frame-share correction never applies to fixed glazing.
  apply("frame_share", frameShare, input.opening === "fixed" ? false : input.frameSharePct === null ? null : input.frameSharePct < catalogue.frameSharePct);
  if (input.opening === null) {
    // Twin sash and fixed glazing exclude each other: the lower of the two, if either lowers the value.
    const lower = twinSash <= fixedGlazing ? { kind: "twin_sash" as const, value: twinSash } : { kind: "fixed_glazing" as const, value: fixedGlazing };
    apply(lower.kind, lower.value, null);
  } else {
    apply("twin_sash", twinSash, input.opening === "twin_sash");
    apply("fixed_glazing", fixedGlazing, input.opening === "fixed");
  }
  apply("small_window", smallWindow, input.areaM2 === null ? null : input.areaM2 < catalogue.smallWindowM2);
  // Pane sizes are not modelled: a window larger than the limit may hold a pane that large, so it takes the correction as assumed.
  apply("large_pane", catalogue.largePaneDb, input.areaM2 === null || input.areaM2 > catalogue.largePaneM2 ? null : false);
  apply("glazing_bars", glazingBars, input.glazingBars);
  const rwDb = row.rwDb + corrections.reduce((sum, item) => sum + item.db, 0);
  return { status: "calculated", rwDb, tableRwDb: row.rwDb, ref: row.ref, edition: catalogue.edition, equationRef: catalogue.equationRef, corrections, assumptions,
    limits: { frameSharePct: catalogue.frameSharePct, smallWindowM2: catalogue.smallWindowM2, largePaneM2: catalogue.largePaneM2 } };
}
