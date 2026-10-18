import "./messages";
import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { SiteAssessmentInput } from "@richtfest/shared";
import { useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { DateInput } from "../ui/date-input";
import { Input, Textarea } from "../ui/input";
import { Badge, Field, Segmented } from "../ui/primitives";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

type Constraints = SiteAssessmentInput["constraints"];
type Evidence = Constraints["parcelArea"];
type Facts = NonNullable<SiteAssessmentInput["planningFacts"]>;
type Rules = NonNullable<SiteAssessmentInput["designRules"]>;
export type ReviewItem =
  | { kind: "constraint"; key: keyof Constraints }
  | { kind: "check"; key: keyof SiteAssessmentInput["checks"] }
  | { kind: "fact"; key: keyof Facts }
  | { kind: "rules"; key: "designRules" };
export const reviewItemId = (item: ReviewItem) => `${item.kind}:${item.key}`;
export const EMPTY_RULES: Rules = { maxHeight: null, heightNotSpecified: false, buildingForm: "unresolved", source: "", sourceDate: null, reviewed: false };

/** One status vocabulary for constraint rows and the review panel: name the first thing that blocks review. */
export function evidenceStatus(value: Evidence, invalid: boolean) {
  if (invalid) return "InvalidShort";
  if (value.value === null) return "ValueMissing";
  if (!value.source.trim()) return "SourceMissing";
  if (!value.sourceDate) return "DateMissing";
  return value.reviewed ? "ReviewedShort" : "Unreviewed";
}

const decimalPattern = { de: /^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/, en: /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/ };
export const parseDecimal = (text: string, language: "en" | "de") =>
  !text.trim() ? null : !decimalPattern[language].test(text.trim()) ? NaN : Number(language === "de" ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, ""));

/** Numeric value with source, date, provenance and review; editing any of them revokes the review. */
export function EvidenceEditor({ name, value, change, disabled, invalid, raw, onRaw }: {
  name: string; value: Evidence; change: (v: Evidence) => void; disabled: boolean; invalid: boolean; raw?: string; onRaw: (text: string) => void;
}) {
  const t = useT(), language = usePreferences((s) => s.language);
  const label = (key: string) => t(`siteAssessment${key}` as Parameters<typeof t>[0]);
  const missing = [value.value === null && label("Value"), !value.source.trim() && label("SourceShort"), !value.sourceDate && label("Date")].filter(Boolean) as string[];
  return (
    <div className="site-evidence">
      <Field label={name}>
        <Input
          inputMode="decimal"
          disabled={disabled}
          aria-invalid={invalid || (value.value !== null && !Number.isFinite(value.value))}
          value={raw ?? (value.value === null ? "" : value.value.toLocaleString(language === "de" ? "de-DE" : "en-GB", { maximumFractionDigits: 10 }))}
          onChange={(event) => {
            onRaw(event.target.value);
            change({ ...value, value: parseDecimal(event.target.value, language), reviewed: false });
          }}
        />
      </Field>
      <Field label={label("SourceShort")}>
        <Input aria-label={`${name} · ${label("Source")}`} disabled={disabled} value={value.source} maxLength={2000} onChange={(event) => change({ ...value, source: event.target.value, reviewed: false })} />
      </Field>
      <Field label={label("Date")}>
        <DateInput aria-label={`${name} · ${label("Date")}`} disabled={disabled} value={value.sourceDate} onValueChange={(sourceDate) => change({ ...value, sourceDate, reviewed: false })} />
      </Field>
      <div className="site-evidence-kind">
        <span className="text-ui-xs">{label("Kind")}</span>
        <Segmented
          // An empty value has no provenance yet; do not present the stored default as a choice someone made.
          value={value.value === null && !value.source.trim() ? "" : value.kind}
          onChange={(kind) => change({ ...value, kind: kind as Evidence["kind"], reviewed: false })}
          items={["official", "calculated", "estimated", "assessment"].map((kind) => ({ value: kind, label: label(kind), disabled }))}
        />
      </div>
      <div className="site-review-block">
        <label className="site-review text-ui-xs">
          <Checkbox aria-label={`${name} · ${label("Reviewed")}`} disabled={disabled || missing.length > 0} checked={value.reviewed} onCheckedChange={(checked) => change({ ...value, reviewed: checked === true })} />
          {label("Reviewed")}
        </label>
        {!value.reviewed && missing.length > 0 && <small className="muted text-ui-2xs">{label("ReviewNeeds").replace("{items}", missing.join(", "))}</small>}
      </div>
    </div>
  );
}

export function SiteReviewPanel({ item, items, assessment, disabled, canWrite, invalidKeys, raw, onRaw, onUpdate, onNavigate, onClose }: {
  item: ReviewItem | undefined;
  items: ReviewItem[];
  assessment: Omit<SiteAssessmentInput, "baseRevision">;
  disabled: boolean;
  canWrite: boolean;
  invalidKeys: Set<string>;
  raw: Record<string, string>;
  onRaw: (key: string, text: string) => void;
  onUpdate: (change: Partial<Omit<SiteAssessmentInput, "baseRevision">>) => void;
  onNavigate: (item: ReviewItem) => void;
  onClose: () => void;
}) {
  const t = useT();
  const label = (key: string) => t(`siteAssessment${key}` as Parameters<typeof t>[0]);
  const opener = useRef<HTMLElement | null>(null);
  if (item && !opener.current && document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
  const index = item ? items.findIndex((i) => reviewItemId(i) === reviewItemId(item)) : -1;
  const previous = index > 0 ? items[index - 1] : undefined, next = index >= 0 ? items[index + 1] : undefined;
  const itemName = (i: ReviewItem) => label(i.key);
  return (
    <Dialog open={!!item} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="site-editor-panel"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          opener.current?.focus();
          opener.current = null;
        }}
      >
        <DialogTitle>{item ? itemName(item) : ""}</DialogTitle>
        <DialogDescription>{label(canWrite ? "PanelHint" : "PanelHintReadOnly")}</DialogDescription>
        {item?.kind === "constraint" && (
          <EvidenceEditor
            name={label(item.key)}
            value={assessment.constraints[item.key] ?? { value: null, source: "", sourceDate: null, kind: "assessment", reviewed: false }}
            disabled={disabled}
            invalid={invalidKeys.has(item.key)}
            raw={raw[`baseline:${item.key}`]}
            onRaw={(text) => onRaw(`baseline:${item.key}`, text)}
            change={(value) => onUpdate({ constraints: { ...assessment.constraints, [item.key]: value } })}
          />
        )}
        {item?.kind === "fact" && (() => {
          const fact = assessment.planningFacts?.[item.key] ?? { value: "", source: "", sourceDate: null, kind: "assessment" as const, reviewed: false };
          const change = (patch: Partial<typeof fact>) => onUpdate({ planningFacts: { ...assessment.planningFacts, [item.key]: { ...fact, ...patch } } });
          const missing = [!fact.value && label("Value"), !fact.source && label("SourceShort"), !fact.sourceDate && label("Date")].filter(Boolean) as string[];
          return (
            <>
              <Field label={label(item.key)}>
                <Textarea disabled={disabled} value={fact.value} onChange={(e) => change({ value: e.target.value, reviewed: false })} />
              </Field>
              <Field label={label("SourceShort")}>
                <Input disabled={disabled} value={fact.source} onChange={(e) => change({ source: e.target.value, reviewed: false })} />
              </Field>
              <Field label={label("Date")}>
                <DateInput disabled={disabled} value={fact.sourceDate} onValueChange={(sourceDate) => change({ sourceDate, reviewed: false })} />
              </Field>
              <div className="site-review-block">
                <label className="site-review text-ui-xs">
                  <Checkbox disabled={disabled || missing.length > 0} checked={fact.reviewed} onCheckedChange={(v) => change({ reviewed: v === true })} />
                  {label("Reviewed")}
                </label>
                {!fact.reviewed && missing.length > 0 && <small className="muted text-ui-2xs">{label("ReviewNeeds").replace("{items}", missing.join(", "))}</small>}
              </div>
            </>
          );
        })()}
        {item?.kind === "check" && (() => {
          const check = assessment.checks[item.key];
          const change = (patch: Partial<typeof check>) => onUpdate({ checks: { ...assessment.checks, [item.key]: { ...check, ...patch } } });
          const missing = [!check.source.trim() && label("SourceShort"), !check.note.trim() && label("Note")].filter(Boolean) as string[];
          return (
            <div className="site-check-fields">
              <Field label={label("SourceShort")}>
                <Input aria-label={`${label(item.key)} · ${label("Source")}`} disabled={disabled} value={check.source} onChange={(event) => change({ source: event.target.value, status: "unresolved" })} />
              </Field>
              <Field label={label("Note")}>
                <Textarea aria-label={`${label(item.key)} · ${label("Note")}`} rows={3} disabled={disabled} value={check.note} onChange={(event) => change({ note: event.target.value, status: "unresolved" })} />
              </Field>
              <div className="site-evidence-kind">
                <span className="text-ui-xs">{label("Assessment")}</span>
                <Segmented
                  value={check.status}
                  onChange={(status) => change({ status: status as typeof check.status })}
                  items={["unresolved", "confirmed", "not_applicable"].map((value) => ({ value, label: label(value), disabled: disabled || (value !== "unresolved" && missing.length > 0) }))}
                />
                {missing.length > 0 && <small className="muted text-ui-2xs">{label("ConfirmNeeds").replace("{items}", missing.join(", "))}</small>}
              </div>
            </div>
          );
        })()}
        {item?.kind === "rules" && (() => {
          const rules = assessment.designRules ?? EMPTY_RULES;
          const change = (patch: Partial<Rules>) => onUpdate({ designRules: { ...rules, ...patch } });
          const missing = [
            rules.buildingForm === "unresolved" && label("buildingForm"),
            !rules.heightNotSpecified && !rules.maxHeight && label("MaxHeight"),
            !rules.source && label("SourceShort"),
            !rules.sourceDate && label("Date"),
          ].filter(Boolean) as string[];
          return (
            <div className="site-design-rules">
              <div className="site-evidence-kind">
                <span className="text-ui-xs">{label("buildingForm")}</span>
                <Segmented value={rules.buildingForm} onChange={(v) => change({ buildingForm: v as Rules["buildingForm"], reviewed: false })} items={["open", "closed", "deviating", "unresolved"].map((value) => ({ value, label: label(value), disabled }))} />
              </div>
              <Field label={label("MaxHeight")}>
                <Input type="number" min={0.1} step={0.1} disabled={disabled || rules.heightNotSpecified} value={rules.maxHeight ?? ""} onChange={(e) => change({ maxHeight: Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : null, reviewed: false })} />
              </Field>
              <label className="site-review text-ui-xs">
                <Checkbox disabled={disabled} checked={rules.heightNotSpecified} onCheckedChange={(v) => change({ heightNotSpecified: v === true, maxHeight: null, reviewed: false })} />
                {label("HeightNotSpecified")}
              </label>
              <Field label={label("SourceShort")}>
                <Input disabled={disabled} value={rules.source} onChange={(e) => change({ source: e.target.value, reviewed: false })} />
              </Field>
              <Field label={label("Date")}>
                <DateInput disabled={disabled} value={rules.sourceDate} onValueChange={(sourceDate) => change({ sourceDate, reviewed: false })} />
              </Field>
              <div className="site-review-block">
                <label className="site-review text-ui-xs">
                  <Checkbox disabled={disabled || missing.length > 0} checked={rules.reviewed} onCheckedChange={(v) => change({ reviewed: v === true })} />
                  {label("Reviewed")}
                </label>
                {!rules.reviewed && missing.length > 0 && <small className="muted text-ui-2xs">{label("ReviewNeeds").replace("{items}", missing.join(", "))}</small>}
              </div>
            </div>
          );
        })()}
        <div className="site-panel-footer">
          <Button variant="ghost" size="sm" disabled={!previous} aria-label={previous ? `${label("Previous")}: ${itemName(previous)}` : label("Previous")} onClick={() => previous && onNavigate(previous)}>
            <ChevronLeft className="size-icon-sm" aria-hidden="true" />{label("Previous")}
          </Button>
          {index >= 0 && <span className="muted text-ui-xs tabular-nums whitespace-nowrap">{label("PanelPosition").replace("{n}", String(index + 1)).replace("{total}", String(items.length))}</span>}
          {next ? (
            <Button variant="outline" size="sm" onClick={() => onNavigate(next)}>
              {label("NextItem").replace("{name}", itemName(next))}<ChevronRight className="size-icon-sm" aria-hidden="true" />
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={onClose}>{label("Done")}</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ReviewStatusBadge({ status }: { status: string }) {
  const t = useT();
  return <Badge variant="outline">{t(`siteAssessment${status}` as Parameters<typeof t>[0])}</Badge>;
}
