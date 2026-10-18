import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Download } from "lucide-react";
import {
  calculateFeasibility, feasibilityScenarioInputs, feasibilityScenarioKinds, feasibilityUnits,
  type FeasibilityResult, type FeasibilityScenario, type FeasibilityScenarioKey, type FeasibilitySiteFigures, type FeasibilitySiteKey, type FeasibilityStudy, type FeasibilityValue,
} from "@richtfest/shared";
import { api, ApiError } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input, Textarea } from "../ui/input";
import { Badge, Callout, Segmented } from "../ui/primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import "./feasibility.css";

type T = ReturnType<typeof useT>;
type Key = Parameters<T>[0];
type StudyResponse = { study: FeasibilityStudy; results: FeasibilityResult[]; figures: FeasibilitySiteFigures; method: string };
type Draft = Pick<FeasibilityStudy, "site" | "scenarios" | "notes">;

const camel = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const inputLabel = (key: string, t: T) => t(`feasibilityInput${camel(key)}` as Key);
const scenarioLabel = (kind: string, t: T) => t(`feasibilityScenario${camel(kind.replace(/_(\w)/, (_, c: string) => c.toUpperCase()))}` as Key);
/** Rows in task order: what is built, what it costs, what it earns, then the decision. */
const groups: Array<{ title: Key; keys: FeasibilityScenarioKey[] }> = [
  { title: "feasibilityGroupAreas", keys: ["existingLivingArea", "newGrossFloorArea", "livingAreaRatio"] },
  { title: "feasibilityGroupCosts", keys: ["renovationCost", "constructionCost", "contingencyRate", "demolitionCost", "otherCost", "financingRate", "marketingRate", "subsidies"] },
  { title: "feasibilityGroupRevenue", keys: ["salePrice", "monthlyRent", "operatingCostRate", "capitalizationRate", "profitRate"] },
];
const resultRows: Array<{ key: keyof FeasibilityResult; label: Key; perArea?: boolean; strong?: boolean }> = [
  { key: "livingArea", label: "feasibilityResultLivingArea" },
  { key: "revenue", label: "feasibilityResultRevenue" },
  { key: "totalCosts", label: "feasibilityResultTotalCosts" },
  { key: "profit", label: "feasibilityResultProfit" },
  { key: "residualLandValue", label: "feasibilityResultResidual", strong: true },
  { key: "residualPerParcelArea", label: "feasibilityResultPerParcel", perArea: true },
  { key: "headroom", label: "feasibilityResultHeadroom", strong: true },
];
const euro = (value: number) => `${Math.round(value).toLocaleString()} €`;
/** Accepts German ("1.500.000", "0,75") and English ("1,500,000", "0.75") input; a single dot or comma is a decimal separator. */
const parse = (text: string) => { const trimmed = text.trim().replace(/[\s€%]/g, ""); if (!trimmed) return null;
  const grouped = (separator: string) => trimmed.split(separator).length > 2;
  const normal = grouped(".") ? trimmed.replace(/\./g, "").replace(",", ".") : grouped(",") ? trimmed.replace(/,/g, "")
    : trimmed.includes(",") && trimmed.includes(".") ? (trimmed.lastIndexOf(",") > trimmed.lastIndexOf(".") ? trimmed.replace(/\./g, "").replace(",", ".") : trimmed.replace(/,/g, ""))
    : trimmed.replace(",", ".");
  const value = Number(normal); return Number.isFinite(value) && value >= 0 ? value : undefined; };

/** One editable value with where it came from. Typing a value makes it yours and reviewed; proposals need a tick. */
function ValueCell({ state, label, unit, disabled, t, onChange }: { state?: FeasibilityValue; label: string; unit: string; disabled: boolean; t: T; onChange: (state: FeasibilityValue | undefined) => void }) {
  const text = state?.value === null || state?.value === undefined ? "" : state.value.toLocaleString(undefined, { maximumFractionDigits: 2, useGrouping: false });
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const commit = () => {
    const value = parse(draft);
    if (value === undefined) { setDraft(text); return; }
    if (value === (state?.value ?? null)) return;
    onChange(value === null ? undefined : { value, source: "entered", note: null, reviewed: true });
  };
  const proposed = state && state.source !== "entered";
  return <div className="feasibility-cell">
    <Input aria-label={label} inputMode="decimal" value={draft} disabled={disabled} placeholder="–" title={state?.note ?? unit}
      onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit(); }} />
    {proposed && <span className="feasibility-proposal text-ui-2xs" title={state.note ?? undefined}>
      <Badge variant="outline">{state.source === "standard" ? t("feasibilitySourceStandard") : t("feasibilitySourceModel")}</Badge>
      <label className="muted">
        <Checkbox aria-label={`${label}: ${t("feasibilityReviewed")}`} checked={state.reviewed} disabled={disabled} onCheckedChange={(checked) => onChange({ ...state, reviewed: checked === true })} />
        {t("feasibilityReviewed")}
      </label>
    </span>}
  </div>;
}

/**
 * Feasibility: keep, densify or build new, compared by residual land value.
 * Values from the building model and company standards are proposals until
 * ticked; the comparison recalculates live and the decision sits last.
 */
export function Feasibility({ projectId }: { projectId: string }) {
  const t = useT();
  const path = `/feasibility/projects/${projectId}/study`;
  const query = useApi(path);
  const data = query.data as StudyResponse | undefined;
  const session = useApi("/auth/me");
  const [draft, setDraft] = useState<Draft>();
  const [conflict, setConflict] = useState<string>();
  useEffect(() => { if (data) setDraft({ site: data.study.site, scenarios: data.study.scenarios, notes: data.study.notes }); }, [data]);
  const results = useMemo(() => draft ? draft.scenarios.map((scenario) => calculateFeasibility(draft.site, scenario)) : [], [draft]);
  const dirty = Boolean(data && draft && JSON.stringify({ site: data.study.site, scenarios: data.study.scenarios, notes: data.study.notes }) !== JSON.stringify(draft));
  const save = useMutation({
    mutationFn: () => api<StudyResponse>(path, { baseRevision: data!.study.revision, ...draft }, "PUT"),
    onMutate: () => setConflict(undefined),
    onSuccess: (response) => queryClient.setQueryData([path], response),
    onError: (error) => setConflict(error instanceof ApiError && error.status === 409 ? t("feasibilityConflict") : error.message),
  });
  if (query.isError) return <Callout tone="error">{(query.error as Error).message}</Callout>;
  if (!data || !draft) return null;
  const canWrite = (session.data?.permissions || session.data?.user?.permissions || []).includes("projects:write");
  const setSite = (key: FeasibilitySiteKey, state: FeasibilityValue | undefined) => setDraft((current) => current && ({ ...current, site: { ...current.site, [key]: state } }));
  const setScenario = (kind: FeasibilityScenario["kind"], change: (scenario: FeasibilityScenario) => FeasibilityScenario) =>
    setDraft((current) => current && ({ ...current, scenarios: current.scenarios.map((scenario) => scenario.kind === kind ? change(scenario) : scenario) }));
  const ordered = feasibilityScenarioKinds.map((kind) => draft.scenarios.find((scenario) => scenario.kind === kind)!);
  const unreviewed = new Set(results.flatMap((result) => result.unreviewed)).size;
  const best = results.filter((result) => result.status === "complete").sort((a, b) => b.residualLandValue! - a.residualLandValue!)[0];
  return <div className="feasibility">
    <Section title={t("feasibilitySite")}>
      <Callout>{t("feasibilityScopeHint")}</Callout>
      <div className="feasibility-site">
        {(["parcelArea", "askingPrice", "acquisitionCostRate"] as const).map((key) => <label key={key} className="feasibility-site-field">
          <span className="text-ui-xs">{inputLabel(key, t)} <span className="muted">({feasibilityUnits[key]})</span></span>
          <ValueCell state={draft.site[key]} label={inputLabel(key, t)} unit={feasibilityUnits[key]} disabled={!canWrite} t={t} onChange={(state) => setSite(key, state)} />
        </label>)}
      </div>
      {(data.figures.gfz !== null || data.figures.grz !== null) && <p className="muted text-ui-2xs">
        {t("feasibilityZoning").replace("{grz}", data.figures.grz?.toLocaleString() ?? "–").replace("{gfz}", data.figures.gfz?.toLocaleString() ?? "–")}{" "}
        <Link className="underline underline-offset-2" to={`/projects/${projectId}?view=building-model`}>{t("feasibilityOpenModel")}</Link>
      </p>}
    </Section>
    <Section title={t("feasibilityScenarios")} meta={<div className="inline-actions">
      <Button asChild variant="outline" size="sm" disabled={!data.study.revision || dirty}>
        <a href={`/api${path}/report.pdf`} download aria-disabled={!data.study.revision || dirty} onClick={(event) => { if (!data.study.revision || dirty) event.preventDefault(); }}
          title={!data.study.revision || dirty ? t("feasibilityReportSaveFirst") : t("feasibilityReportHint")}>
          <Download aria-hidden="true" />{t("feasibilityReport")}
        </a>
      </Button>
      {canWrite && <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{t("feasibilitySave")}</Button>}
    </div>}>
      {conflict && <Callout tone="error">{conflict}</Callout>}
      <Table className="feasibility-table">
        <colgroup><col className="feasibility-label-col" /><col /><col /><col /></colgroup>
        <TableHeader>
          <TableRow>
            <TableHead />
            {ordered.map((scenario) => <TableHead key={scenario.kind}>
              <div className="feasibility-scenario-head">
                <span>{scenarioLabel(scenario.kind, t)}</span>
                <Segmented value={scenario.revenueMode} onChange={(mode) => canWrite && setScenario(scenario.kind, (current) => ({ ...current, revenueMode: mode as FeasibilityScenario["revenueMode"] }))}
                  items={[{ value: "sale", label: t("feasibilityModeSale"), disabled: !canWrite }, { value: "rent", label: t("feasibilityModeRent"), disabled: !canWrite }]} />
              </div>
            </TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((group) => <Fragment key={group.title}>
            <TableRow><TableCell colSpan={4} className="feasibility-group">{t(group.title)}</TableCell></TableRow>
            {group.keys.map((key) => <TableRow key={key}>
              <TableCell className="text-ui-xs">{inputLabel(key, t)} <span className="muted">({feasibilityUnits[key]})</span></TableCell>
              {ordered.map((scenario) => <TableCell key={scenario.kind}>
                {feasibilityScenarioInputs(scenario.kind, scenario.revenueMode).includes(key)
                  ? <ValueCell state={scenario.values[key]} label={`${inputLabel(key, t)} · ${scenarioLabel(scenario.kind, t)}`} unit={feasibilityUnits[key]} disabled={!canWrite} t={t}
                      onChange={(state) => setScenario(scenario.kind, (current) => ({ ...current, values: { ...current.values, [key]: state } }))} />
                  : <span className="muted text-ui-xs">—</span>}
              </TableCell>)}
            </TableRow>)}
          </Fragment>)}
          <TableRow><TableCell colSpan={4} className="feasibility-group">{t("feasibilityGroupResult")}</TableCell></TableRow>
          {resultRows.filter((row) => row.key !== "headroom" || draft.site.askingPrice?.value != null).map((row) => <TableRow key={row.key}>
            <TableCell className={`text-ui-xs${row.strong ? " font-medium" : ""}`}>{t(row.label)}</TableCell>
            {feasibilityScenarioKinds.map((kind) => { const result = results.find((item) => item.kind === kind)!; const value = result[row.key] as number | null;
              return <TableCell key={kind} className={`feasibility-number${row.strong ? " font-medium" : ""}`}>
                {result.status === "incomplete" ? (row.key === "residualLandValue" ? <span className="muted text-ui-2xs" title={result.missing.map((key) => inputLabel(key, t)).join(", ")}>{t("feasibilityMissing").replace("{count}", String(result.missing.length))}</span> : "–")
                  : value === null ? "–" : row.key === "livingArea" ? `${Math.round(value).toLocaleString()} m²` : row.perArea ? `${euro(value)}/m²` : euro(value)}
              </TableCell>; })}
          </TableRow>)}
        </TableBody>
      </Table>
      <p className="muted text-ui-2xs" role="status">
        {[best ? t("feasibilityBest").replace("{scenario}", scenarioLabel(best.kind, t)) : t("feasibilityNoneComplete"),
          unreviewed ? t("feasibilityUnreviewed").replace("{count}", String(unreviewed)) : null, t("feasibilityDisclaimer")].filter(Boolean).join(" · ")}
      </p>
    </Section>
    <Section title={t("feasibilityNotes")}>
      <Textarea aria-label={t("feasibilityNotes")} rows={3} value={draft.notes} disabled={!canWrite} onChange={(event) => setDraft((current) => current && ({ ...current, notes: event.target.value }))} />
    </Section>
  </div>;
}
