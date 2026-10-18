import { Sparkles } from "lucide-react";
import { useT } from "../../i18n";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { Badge, Callout } from "../ui/primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import type { SummaryStep, SummaryStepId } from "./site-summary";
import type { PlanProvider } from "./plan-extraction";
import { NativeSelect } from "../ui/native-select";

/** One click from the saved address to a reviewed-later frame; the checklist says what was proposed and what needs a person. */
export function SiteSummaryPanel({ steps, running, error, disabled, primary, onRun, onOpen, provider, onProvider }: {
  steps: SummaryStep[] | null;
  running: boolean;
  error: string | null;
  disabled: boolean;
  primary: boolean;
  onRun: () => void;
  onOpen: (step: SummaryStepId) => void;
  /** Provider used to read a covering B-Plan; selected explicitly, never inferred. */
  provider: PlanProvider;
  onProvider: (provider: PlanProvider) => void;
}) {
  const t = useT();
  const label = (key: string) => t(`siteSummary${key}` as Parameters<typeof t>[0]);
  const detail = (step: SummaryStep) => {
    if (!step.detail) return "";
    let text = label(step.detail);
    const values = { ...step.values };
    // Filled figures are stored as keys so the list follows the app language.
    if (typeof values.items === "string") values.items = values.items.split(", ").filter(Boolean).map((key) => (key === "storeys" ? label("Storeys") : key.toUpperCase())).join(", ");
    for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{${key}}`, String(value));
    return text;
  };
  return (
    <Section
      title={label("Title")}
      meta={
        !disabled && (
          <div className="inline-actions">
          <label className="site-summary-provider text-ui-xs">
            <span className="muted">{label("PlanReader")}</span>
            <NativeSelect value={provider} disabled={running} onChange={(e) => onProvider(e.target.value as PlanProvider)} aria-label={label("PlanReader")}>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </NativeSelect>
          </label>
          <Button size="sm" variant={primary ? "default" : "outline"} disabled={running} onClick={onRun}>
            <Sparkles className="size-icon-sm" aria-hidden="true" />
            {running ? label("Running") : label(steps ? "RunAgain" : "Run")}
          </Button>
          </div>
        )
      }
    >
      <p className="muted text-ui-xs">{label("Hint")}</p>
      {error && <Callout tone="error">{error}</Callout>}
      {steps && (
        <>
          <Table aria-label={label("Title")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("siteAssessmentStep")}</TableHead>
                <TableHead>{label("Outcome")}</TableHead>
                <TableHead>{t("status")}</TableHead>
                <TableHead><span className="sr-only">{t("siteAssessmentResolve")}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {steps.map((step) => (
                <TableRow key={step.id}>
                  <TableCell>{label(`Step_${step.id}`)}</TableCell>
                  <TableCell className="muted">{detail(step)}</TableCell>
                  <TableCell><Badge variant="outline">{label(`Status_${step.status}`)}</Badge></TableCell>
                  <TableCell className="text-right">
                    {step.status !== "skipped" && <Button size="sm" variant="ghost" onClick={() => onOpen(step.id)}>{t("siteAssessmentResolve")}</Button>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Callout>{label("ReviewNote")}</Callout>
        </>
      )}
    </Section>
  );
}
