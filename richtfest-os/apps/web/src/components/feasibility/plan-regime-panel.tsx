import { BO58_BUILDING_CLASSES, LAND_USE_ORDINANCES, ORDINANCE_RULES, PLAN_TYPES, ordinanceForAdoption, type PlanRegime, type SiteAssessmentInput } from "@richtfest/shared";
import { Checkbox } from "../ui/checkbox";
import { DateInput } from "../ui/date-input";
import { NativeSelect } from "../ui/native-select";
import { Callout, Field } from "../ui/primitives";
import { proposeBuildingClassFigures } from "./site-summary";

type Constraints = SiteAssessmentInput["constraints"];
const NONE = "_none";
const EMPTY: PlanRegime = { regime: "b_plan", planType: null, planName: "", adoptedOn: null, ordinance: null, buildingClass: null, courtReview: null, source: "", sourceDate: null, reviewed: false };
/** The Baunutzungsplan is a scanned map published from 1:5,000; this window around the site stays above that scale. */
const BNP_HALF_HEIGHT_M = 400;
const bnpMapUrl = ([x, y]: [number, number]) => {
  const url = new URL("https://gdi.berlin.de/services/wms/bnp");
  url.search = new URLSearchParams({ service: "WMS", version: "1.3.0", request: "GetMap", layers: "bnp", styles: "", crs: "EPSG:25833", format: "image/png", width: "600", height: "400",
    bbox: [x - BNP_HALF_HEIGHT_M * 1.5, y - BNP_HALF_HEIGHT_M, x + BNP_HALF_HEIGHT_M * 1.5, y + BNP_HALF_HEIGHT_M].map(Math.round).join(",") }).toString();
  return url.href;
};
const BNP_LEGEND_URL = "https://gdi.berlin.de/services/wms/bnp?service=WMS&request=GetLegendGraphic&version=1.3.0&layer=bnp&format=image/png&sld_version=1.1.0";

/**
 * Planning regime of a B-Plan parcel: plan type, adoption date, BauNVO version or BO 58 with its building class. The version decides
 * whether attic rooms count toward GF and whether GRZ 2 has a cap, so the consequences are stated next to the inputs. Every change
 * revokes the review; choosing a building class proposes its figures unreviewed.
 */
export function PlanRegimePanel({ regime, constraints, origin, disabled, label, onChange }: {
  regime: PlanRegime | undefined;
  constraints: Constraints;
  origin: [number, number] | null;
  disabled: boolean;
  label: (key: string) => string;
  onChange: (change: { planRegime: PlanRegime; constraints?: Constraints }) => void;
}) {
  const value = regime ?? EMPTY;
  const set = (change: Partial<PlanRegime>) => onChange({ planRegime: { ...value, ...change, reviewed: false } });
  const rules = value.ordinance ? ORDINANCE_RULES[value.ordinance] : null;
  const invalidated = /unwirksam|nichtig/i.test(value.courtReview ?? "");
  const bnp = value.regime === "baunutzungsplan";
  return (
    <div className="site-regime">
      <div className="site-regime-fields">
        <Field label={label("RegimeKind")}>
          <NativeSelect size="sm" disabled={disabled} value={value.regime}
            onChange={(e) => set(e.target.value === "baunutzungsplan" ? { regime: "baunutzungsplan", planType: null, planName: "Baunutzungsplan 1960", adoptedOn: "1961-06-30", ordinance: "bo_58" } : EMPTY)}>
            {(["b_plan", "baunutzungsplan"] as const).map((k) => <option key={k} value={k}>{label(`Regime_${k}`)}</option>)}
          </NativeSelect>
        </Field>
        {!bnp && <Field label={label("RegimePlanType")}>
          <NativeSelect size="sm" disabled={disabled} value={value.planType ?? NONE} onChange={(e) => set({ planType: e.target.value === NONE ? null : (e.target.value as PlanRegime["planType"]) })}>
            <option value={NONE}>{label("RegimeUnknown")}</option>
            {PLAN_TYPES.map((k) => <option key={k} value={k}>{label(`PlanType_${k}`)}</option>)}
          </NativeSelect>
        </Field>}
        {!bnp && <Field label={label("RegimeAdoptedOn")}>
          <DateInput className="site-regime-date" disabled={disabled} value={value.adoptedOn} onValueChange={(adoptedOn) => set({ adoptedOn, ordinance: ordinanceForAdoption(adoptedOn).ordinance ?? value.ordinance })} />
        </Field>}
        <Field label={label("RegimeOrdinance")}>
          <NativeSelect size="sm" disabled={disabled || bnp} value={value.ordinance ?? NONE} onChange={(e) => set({ ordinance: e.target.value === NONE ? null : (e.target.value as PlanRegime["ordinance"]) })}>
            <option value={NONE}>{label("RegimeUnknown")}</option>
            {LAND_USE_ORDINANCES.filter((k) => (bnp ? k === "bo_58" : k !== "bo_58")).map((k) => <option key={k} value={k}>{label(`Ordinance_${k}`)}</option>)}
          </NativeSelect>
        </Field>
        {bnp && <Field label={label("RegimeBuildingClass")}>
          <NativeSelect size="sm" disabled={disabled} value={value.buildingClass ?? NONE}
            onChange={(e) => {
              const buildingClass = e.target.value === NONE ? null : (e.target.value as PlanRegime["buildingClass"]);
              const next = { ...constraints };
              if (buildingClass) proposeBuildingClassFigures(next, buildingClass, "berlin_proposals_v1");
              onChange({ planRegime: { ...value, buildingClass, reviewed: false }, constraints: next });
            }}>
            <option value={NONE}>{label("RegimeBuildingClassNone")}</option>
            {BO58_BUILDING_CLASSES.map((k) => <option key={k} value={k}>{k}</option>)}
          </NativeSelect>
        </Field>}
        <label className="site-regime-review text-ui-sm">
          <Checkbox disabled={disabled || !value.ordinance} checked={value.reviewed} onCheckedChange={(v) => onChange({ planRegime: { ...value, reviewed: v === true } })} />
          {label("Reviewed")}
        </label>
      </div>
      {!bnp && ordinanceForAdoption(value.adoptedOn).transitional && <p className="muted text-ui-xs">{label("RegimeTransitional")}</p>}
      {invalidated && <Callout tone="warning">{label("RegimeCourtReview").replace("{review}", value.courtReview ?? "")}</Callout>}
      {rules ? (
        <ul className="site-regime-rules text-ui-xs">
          <li>{label(rules.atticRooms === "count" ? "RegimeAtticCounts" : "RegimeAtticPlan")}</li>
          <li>{label(`RegimeAncillary_${rules.ancillary}`)}</li>
          <li className="muted">{rules.citation}</li>
        </ul>
      ) : (
        <p className="muted text-ui-xs">{label("RegimeOrdinanceUnknown")}</p>
      )}
      {value.source && <p className="muted text-ui-2xs site-regime-source">{value.source}</p>}
      {bnp && origin && (
        <figure className="site-regime-map">
          <div className="site-regime-map-frame">
            <img src={bnpMapUrl(origin)} alt={label("RegimeBnpMap")} width={600} height={400} loading="lazy" />
            <span className="site-regime-marker" aria-hidden="true" />
          </div>
          <figcaption className="muted text-ui-2xs">
            {label("RegimeBnpMapCaption")} <a href={BNP_LEGEND_URL} target="_blank" rel="noreferrer">{label("RegimeBnpLegend")}</a>
          </figcaption>
        </figure>
      )}
    </div>
  );
}
