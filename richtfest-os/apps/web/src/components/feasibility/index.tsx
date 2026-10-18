import "./messages";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Link, useBlocker, useLocation, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Download } from "lucide-react";
import {
  calculateFeasibility, feasibilityOptionalInputs, feasibilityScenarioInputs, feasibilityScenarioKinds, feasibilitySiteKeys, feasibilityUnits, feasibilityValueError,
  type FeasibilityResult, type FeasibilityScenario, type FeasibilityScenarioKey, type FeasibilityScenarioKind, type FeasibilitySiteFigures, type FeasibilitySiteKey, type FeasibilityStudy, type FeasibilityValue,
} from "@richtfest/shared";
import { api, ApiError } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { usePreferences } from "../../store";
import { useFeatureFlag } from "../../feature-flags";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input, Textarea } from "../ui/input";
import { Badge, Callout, Modal, Segmented } from "../ui/primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import "./feasibility.css";
import { SiteAssessment } from "./site-assessment";

type T = ReturnType<typeof useT>;
type Key = Parameters<T>[0];
type SiteAssessmentSummary = { revision: number; parcelArea: number | null; parcelAreaReviewed: boolean; countableFloorArea: number | null; status: "incomplete" | "indicative" | "reviewed" };
type StudyResponse = { study: FeasibilityStudy; results: FeasibilityResult[]; figures: FeasibilitySiteFigures; siteAssessment: SiteAssessmentSummary | null; method: string; canWrite: boolean };
const sourceLabel = { standard: "feasibilitySourceStandard", building_model: "feasibilitySourceModel", site_assessment: "feasibilitySourceSiteAssessment" } as const;
type InputKey = FeasibilitySiteKey | FeasibilityScenarioKey;
const camel = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const inputLabel = (key: string, t: T) => t(`feasibilityInput${camel(key)}` as Key);
const scenarioLabel = (kind: string, t: T) => t(`feasibilityScenario${camel(kind.replace(/_(\w)/, (_, c: string) => c.toUpperCase()))}` as Key);
const groups: Array<{ title: Key; keys: FeasibilityScenarioKey[] }> = [
  { title: "feasibilityGroupAreas", keys: ["existingLivingArea", "newGrossFloorArea", "livingAreaRatio"] },
  { title: "feasibilityGroupCosts", keys: ["renovationCost", "constructionCost", "contingencyRate", "financingRate", "demolitionCost", "otherCost", "subsidies"] },
  { title: "feasibilityGroupRevenue", keys: ["salePrice", "monthlyRent", "operatingCostRate", "capitalizationRate", "marketingRate", "profitRate"] },
];
const hints: Partial<Record<InputKey, Key>> = {
  acquisitionCostRate: "feasibilityHintAcquisition", livingAreaRatio: "feasibilityHintRatio", financingRate: "feasibilityHintFinancing",
  contingencyRate: "feasibilityHintContingency", marketingRate: "feasibilityHintRevenueRate", profitRate: "feasibilityHintRevenueRate",
  operatingCostRate: "feasibilityHintOperating", capitalizationRate: "feasibilityHintCapitalization", newGrossFloorArea: "feasibilityHintFloorArea",
};
const resultRows: Array<{ key: "livingArea" | "revenue" | "totalCosts" | "profit" | "residualLandValue" | "residualPerParcelArea" | "headroom"; label: Key }> = [
  { key: "livingArea", label: "feasibilityResultLivingArea" }, { key: "revenue", label: "feasibilityResultRevenue" },
  { key: "totalCosts", label: "feasibilityResultTotalCosts" }, { key: "profit", label: "feasibilityResultProfit" },
  { key: "residualLandValue", label: "feasibilityResultResidual" }, { key: "residualPerParcelArea", label: "feasibilityResultPerParcel" },
  { key: "headroom", label: "feasibilityResultHeadroom" },
];

/** Separators follow the selected language; malformed grouping is rejected, never guessed. */
const parse = (text: string, language: "en" | "de") => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const pattern = language === "de" ? /^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/ : /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;
  if (!pattern.test(trimmed)) return undefined;
  const value = Number(language === "de" ? trimmed.replace(/\./g, "").replace(",", ".") : trimmed.replace(/,/g, ""));
  return Number.isFinite(value) ? value : undefined;
};

/** Raw drafts live in the editor so switching input groups never drops invalid text. */
function ValueField({ state, field, label, disabled, language, raw, onRaw, onChange }: {
  state?: FeasibilityValue; field: InputKey; label: string; disabled: boolean; language: "en" | "de";
  raw?: string; onRaw: (text: string | undefined) => void; onChange: (state: FeasibilityValue | undefined) => void;
}) {
  const t = useT(), id = useId();
  const locale = language === "de" ? "de-DE" : "en-GB";
  const text = raw ?? (state?.value == null ? "" : state.value.toLocaleString(locale, { useGrouping: true, maximumFractionDigits: 10 }));
  const value = parse(text, language);
  const error = value === undefined ? "number" : feasibilityValueError(field, value);
  const optional = feasibilityOptionalInputs.has(field);
  const missing = value === null && !optional;
  const hint = hints[field];
  return <div className="feasibility-field">
    <label className="text-ui-xs" htmlFor={id}>{label} <span className="muted">({feasibilityUnits[field]}){optional ? ` · ${t("optional")}` : ""}</span></label>
    <Input id={id} aria-label={label} aria-invalid={!!error} aria-describedby={`${id}-help`} inputMode="decimal" disabled={disabled} value={text} placeholder="–"
      onChange={event => {
        const next = event.target.value;
        onRaw(next);
        const parsed = parse(next, language);
        // Invalid drafts suppress the result, rather than leaving the last valid number visible as a calculation.
        if (parsed === undefined) onChange({ value: NaN, source: "entered", note: null, reviewed: true });
        else if (parsed !== (state?.value ?? null)) onChange(parsed === null ? undefined : { value: parsed, source: "entered", note: null, reviewed: true });
      }}
      onBlur={() => { if (!error) onRaw(undefined); }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    <div id={`${id}-help`} className="text-ui-2xs muted">
      {error ? <span role="alert">{t(`feasibilityError${camel(error)}` as Key)}</span> : missing ? t("feasibilityRequired") : hint ? t(hint) : optional ? t("feasibilityOptionalZero") : null}
    </div>
    {state && state.source !== "entered" && <div className="feasibility-proposal text-ui-2xs">
      <Badge variant="outline">{t(sourceLabel[state.source as keyof typeof sourceLabel])}</Badge>
      <label><Checkbox aria-label={`${label}: ${t("feasibilityReviewed")}`} checked={state.reviewed} disabled={disabled}
        onCheckedChange={checked => onChange({ ...state, reviewed: checked === true })} />{t("feasibilityReviewed")}</label>
      {state.note && <span className="muted">{state.note}</span>}
    </div>}
  </div>;
}

export function Feasibility({ projectId }: { projectId: string }) {
  const [params] = useSearchParams();
  // Site assessment is the feasibility workspace. The residual-land-value study is a second tab for people with the
  // `feasibility_financial_study` flag; for everyone else a `study=financial` link falls back to the site assessment.
  const financialEnabled = useFeatureFlag("feasibility_financial_study");
  const financial = financialEnabled && params.get("study") === "financial";
  const nav = financialEnabled ? <StudyTabs current={financial ? "financial" : "site"} /> : null;
  if (financial) return <FinancialFeasibility key={projectId} projectId={projectId} nav={nav} />;
  return <SiteAssessment key={projectId} projectId={projectId} nav={nav} />;
}

/** Real links that keep the selected study in the URL; the site assessment keeps its current step. */
function StudyTabs({ current }: { current: "site" | "financial" }) {
  const t = useT(), [params] = useSearchParams(), { pathname } = useLocation();
  const link = (study: "site" | "financial") => {
    const next = new URLSearchParams(params);
    if (study === "financial") next.set("study", "financial"); else next.delete("study");
    return `${pathname}?${next}`;
  };
  return <nav className="feasibility-studies" aria-label={t("feasibilityStudies")}>
    <Segmented value={current} items={[
      { value: "site", label: t("siteAssessmentTitle"), to: link("site") },
      { value: "financial", label: t("feasibilityTabFinancial"), to: link("financial") },
    ]} />
  </nav>;
}

function FinancialFeasibility({ projectId, nav }: { projectId: string; nav?: ReactNode }) {
  const t = useT(), language = usePreferences(s => s.language);
  const locale = language === "de" ? "de-DE" : "en-GB";
  const euro = (value: number | null) => value === null || !Number.isFinite(value) ? "–" : `${Math.round(value).toLocaleString(locale)} €`;
  const path = `/feasibility/projects/${projectId}/study`;
  const query = useApi(path);
  const data = query.data as StudyResponse | undefined;
  // Capture the revision at the first edit. Background refetches cannot replace this draft or its base revision.
  const [draft, setDraft] = useState<FeasibilityStudy>();
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<FeasibilityScenarioKind>("existing");
  const [group, setGroup] = useState("0");
  const [siteOpen, setSiteOpen] = useState<boolean>();
  const study = draft ?? data?.study;
  const dirty = !!draft || Object.keys(raw).length > 0;
  const results = study?.scenarios.map(scenario => calculateFeasibility(study.site, scenario)) ?? [];
  const invalidText = Object.values(raw).some(text => parse(text, language) === undefined);
  const invalid = invalidText || results.some(result => result.invalid.length > 0);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));
  useEffect(() => {
    if (!dirty) return;
    const before = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  useEffect(() => { setDraft(undefined); setRaw({}); }, [projectId]);
  const save = useMutation({
    mutationFn: () => api<StudyResponse>(path, { baseRevision: study!.revision, site: study!.site, scenarios: study!.scenarios, notes: study!.notes }, "PUT"),
    onSuccess: response => { queryClient.setQueryData([path], response); setDraft(undefined); setRaw({}); },
  });
  if (query.isError) return <Callout tone="error">{(query.error as Error).message}</Callout>;
  if (!data || !study) return null;
  const disabled = !data.canWrite || save.isPending;
  const scenario = study.scenarios.find(s => s.kind === selected)!;
  const result = results.find(r => r.kind === selected)!;
  const used = feasibilityScenarioInputs(selected, scenario.revenueMode);
  const setScenario = (change: Partial<FeasibilityScenario>) => setDraft({ ...study, scenarios: study.scenarios.map(s => s.kind === selected ? { ...s, ...change } : s) });
  const field = (key: InputKey, site = false) => {
    const rawKey = `${site ? "site" : selected}:${key}`;
    return <ValueField key={rawKey} field={key} label={inputLabel(key, t)} state={site ? study.site[key as FeasibilitySiteKey] : scenario.values[key as FeasibilityScenarioKey]}
      disabled={disabled} language={language} raw={raw[rawKey]} onRaw={text => setRaw(current => { const next = { ...current }; if (text === undefined) delete next[rawKey]; else next[rawKey] = text; return next; })}
      onChange={state => site ? setDraft({ ...study, site: { ...study.site, [key]: state } }) : setScenario({ values: { ...scenario.values, [key]: state } })} />;
  };
  const status = (r: FeasibilityResult) => [
    r.invalid.length ? t("feasibilityInvalid").replace("{count}", String(r.invalid.length)) : null,
    r.missing.length ? t("feasibilityMissing").replace("{count}", String(r.missing.length)) : null,
    r.unreviewed.length ? t("feasibilityUnreviewed").replace("{count}", String(r.unreviewed.length)) : null,
  ].filter(Boolean).join(" · ") || t("feasibilityReady");
  const canReport = !!data.study.revision && !dirty && !invalid && !save.isPending;
  return <div className="feasibility">
    {nav}
    {blocker.state === "blocked" && <Modal title={t("feasibilityUnsaved")} onClose={() => blocker.reset()}>
      <p>{t("feasibilityUnsavedHint")}</p><div className="inline-actions">
        <Button variant="outline" onClick={() => blocker.proceed()}>{t("locationLeave")}</Button>
        <Button onClick={() => blocker.reset()}>{t("locationStay")}</Button>
      </div>
    </Modal>}
    <Section title={t("feasibilityScenarios")} meta={<div className="inline-actions">
      <span className="muted text-ui-2xs">{dirty ? t("feasibilityUnsaved") : data.study.revision ? `r${data.study.revision} · ${t("feasibilitySaved")}` : t("feasibilityNew")}</span>
      <Button variant="outline" size="sm" disabled={!canReport} title={canReport ? t("feasibilityReportHint") : t("feasibilityReportSaveFirst")}
        onClick={() => { const a = document.createElement("a"); a.href = `/api${path}/report.pdf?lang=${language}`; a.download = ""; a.click(); }}><Download aria-hidden="true" />{t("feasibilityReport")}</Button>
      {data.canWrite && <Button size="sm" disabled={!dirty || invalid || save.isPending} onClick={() => save.mutate()}>{save.isPending ? t("saving") : t("feasibilitySave")}</Button>}
    </div>}>
      {save.error && <Callout tone="error">{save.error instanceof ApiError && save.error.status === 409 ? t("feasibilityConflict") : save.error.message}</Callout>}
      {dirty && data.study.revision !== study.revision && <Callout>{t("feasibilityConflict")}</Callout>}
      {invalid && <Callout tone="error">{t("feasibilityFixInputs")}</Callout>}
      <Table className="feasibility-summary">
        <TableHeader><TableRow><TableHead>{t("feasibilityScenario")}</TableHead><TableHead>{t("feasibilityResultResidual")}</TableHead><TableHead>{t("status")}</TableHead></TableRow></TableHeader>
        <TableBody>{feasibilityScenarioKinds.map(kind => {
          const r = results.find(item => item.kind === kind)!;
          const s = study.scenarios.find(item => item.kind === kind)!;
          return <TableRow key={kind} className="cursor-pointer" data-state={kind === selected ? "selected" : undefined} onClick={() => setSelected(kind)}>
            <TableCell><Button variant="ghost" size="sm" aria-pressed={kind === selected}>{scenarioLabel(kind, t)}</Button><span className="muted text-ui-2xs feasibility-mode">{t(s.revenueMode === "sale" ? "feasibilityModeSale" : "feasibilityModeRent")}</span></TableCell>
            <TableCell className="feasibility-number">{euro(r.residualLandValue)}</TableCell><TableCell><Badge variant="outline">{status(r)}</Badge></TableCell>
          </TableRow>;
        })}</TableBody>
      </Table>
      <p className="muted text-ui-2xs">{t("feasibilityScopeHint")}</p>
    </Section>
    <details className="feasibility-disclosure" open={siteOpen ?? (study.site.parcelArea?.value == null || study.site.acquisitionCostRate?.value == null)} onToggle={event => setSiteOpen(event.currentTarget.open)}>
      <summary className="text-ui-sm">{t("feasibilitySite")}<span className="muted text-ui-xs">{Number.isFinite(study.site.parcelArea?.value) ? study.site.parcelArea!.value!.toLocaleString(locale) : "–"} m² · {euro(study.site.askingPrice?.value ?? null)}</span></summary>
      <div className="feasibility-fields">{feasibilitySiteKeys.map(key => field(key, true))}</div>
      <SiteAssessmentLink projectId={projectId} summary={data.siteAssessment} locale={locale} disabled={disabled}
        parcelArea={study.site.parcelArea} newGrossFloorArea={study.scenarios.find(s => s.kind === "new_build")?.values.newGrossFloorArea}
        onParcelArea={parcelArea => setDraft({ ...study, site: { ...study.site, parcelArea } })}
        onNewGrossFloorArea={value => setDraft({ ...study, scenarios: study.scenarios.map(s => s.kind === "new_build" ? { ...s, values: { ...s.values, newGrossFloorArea: value } } : s) })} />
      {(data.figures.gfz !== null || data.figures.grz !== null) && <p className="muted text-ui-2xs">{t("feasibilityZoning").replace("{grz}", data.figures.grz?.toLocaleString(locale) ?? "–").replace("{gfz}", data.figures.gfz?.toLocaleString(locale) ?? "–")}{" "}<Link className="underline" to={`/projects/${projectId}?view=building-model`}>{t("feasibilityOpenModel")}</Link></p>}
    </details>
    <Section title={scenarioLabel(selected, t)} meta={<Segmented value={scenario.revenueMode} onChange={mode => setScenario({ revenueMode: mode as FeasibilityScenario["revenueMode"] })}
      items={[{ value: "sale", label: t("feasibilityModeSale"), disabled }, { value: "rent", label: t("feasibilityModeRent"), disabled }]} />}>
      <Segmented value={group} onChange={setGroup} items={groups.map((g, i) => {
        const count = g.keys.filter(key => result.missing.includes(key) || result.invalid.includes(key)).length;
        return { value: String(i), label: `${t(g.title)}${count ? ` · ${count}` : ""}` };
      })} />
      <div className="feasibility-fields">{groups[Number(group)]!.keys.filter(key => used.includes(key) && !feasibilityOptionalInputs.has(key)).map(key => field(key))}</div>
      {group === "1" && <details className="feasibility-disclosure"><summary className="text-ui-xs">{t("feasibilityAdditionalCosts")}</summary><div className="feasibility-fields">{groups[1]!.keys.filter(key => used.includes(key) && feasibilityOptionalInputs.has(key)).map(key => field(key))}</div></details>}
      <p className="muted text-ui-2xs" role="status">{status(result)}{result.missing.length ? `: ${result.missing.map(key => inputLabel(key, t)).join(", ")}` : ""}</p>
    </Section>
    <details className="feasibility-disclosure"><summary className="text-ui-sm">{t("feasibilityGroupResult")} · {scenarioLabel(selected, t)}<span className="feasibility-number">{euro(result.residualLandValue)}</span></summary>
      <dl className="feasibility-results">{resultRows.filter(row => row.key !== "headroom" || study.site.askingPrice?.value != null).map(row => <div key={row.key}><dt>{t(row.label)}</dt><dd>{row.key === "livingArea" ? result.livingArea === null ? "–" : `${result.livingArea.toLocaleString(locale)} m²` : euro(result[row.key])}</dd></div>)}</dl>
    </details>
    <details className="feasibility-disclosure"><summary className="text-ui-sm">{t("feasibilityNotes")}</summary><Textarea aria-label={t("feasibilityNotes")} maxLength={5000} rows={3} value={study.notes} disabled={disabled} onChange={event => setDraft({ ...study, notes: event.target.value })} /></details>
  </div>;
}

/** Figures from the saved site assessment, adopted into the study as unreviewed, source-labelled proposals. */
function SiteAssessmentLink({ projectId, summary, locale, disabled, parcelArea, newGrossFloorArea, onParcelArea, onNewGrossFloorArea }: {
  projectId: string; summary: SiteAssessmentSummary | null; locale: string; disabled: boolean;
  parcelArea?: FeasibilityValue; newGrossFloorArea?: FeasibilityValue;
  onParcelArea: (value: FeasibilityValue) => void; onNewGrossFloorArea: (value: FeasibilityValue) => void;
}) {
  const t = useT();
  const link = <Link className="underline" to={`/projects/${projectId}?view=feasibility&study=site`}>{t(summary ? "feasibilityOpenSiteAssessment" : "feasibilityStartSiteAssessment")}</Link>;
  if (!summary) return <p className="muted text-ui-2xs">{t("feasibilityNoSiteAssessment")} {link}</p>;
  const m2 = (n: number) => `${Math.round(n).toLocaleString(locale)} m²`;
  const proposal = (value: number): FeasibilityValue => ({ value: Math.round(value * 100) / 100, source: "site_assessment", note: `Grundstücksprüfung r${summary.revision}`, reviewed: false });
  const same = (state: FeasibilityValue | undefined, value: number | null) => value !== null && state?.source === "site_assessment" && state.value === Math.round(value * 100) / 100;
  return <div className="feasibility-site-link text-ui-xs" aria-label={t("feasibilitySiteAssessmentFigures")}>
    <span className="muted">{t("feasibilitySiteAssessmentFigures")} · r{summary.revision}</span>
    <Badge variant="outline">{t(summary.status === "reviewed" ? "siteAssessmentReviewedShort" : summary.status === "indicative" ? "siteAssessmentindicative" : "siteAssessmentincomplete")}</Badge>
    <span>{t("feasibilityParcelArea")}: <strong className="tabular-nums">{summary.parcelArea === null ? "–" : m2(summary.parcelArea)}</strong></span>
    {summary.parcelArea !== null && <Button variant="outline" size="sm" disabled={disabled || same(parcelArea, summary.parcelArea)} onClick={() => onParcelArea(proposal(summary.parcelArea!))}>{t("feasibilityUseParcelArea")}</Button>}
    <span>{t("feasibilityMaxCountableFloorArea")}: <strong className="tabular-nums">{summary.countableFloorArea === null ? "–" : m2(summary.countableFloorArea)}</strong></span>
    {summary.countableFloorArea !== null && <Button variant="outline" size="sm" disabled={disabled || same(newGrossFloorArea, summary.countableFloorArea)} onClick={() => onNewGrossFloorArea(proposal(summary.countableFloorArea!))}>{t("feasibilityUseFloorArea")}</Button>}
    {link}
  </div>;
}
