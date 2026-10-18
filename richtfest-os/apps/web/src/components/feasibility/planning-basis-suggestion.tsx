import "./messages";
import { useMutation } from "@tanstack/react-query";
import { Search, Sparkles } from "lucide-react";
import type { SiteAssessmentInput } from "@richtfest/shared";
import { queryClient } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { NativeSelect } from "../ui/native-select";
import { Callout } from "../ui/primitives";
import { useBerlinContext } from "./site-lookups";
import { extractPlanFigures, PLAN_LISTED, planToRead, type PlanExtraction, type PlanProvider } from "./plan-extraction";
import { suggestPlanningBasis } from "./site-summary";

type Draft = Omit<SiteAssessmentInput, "baseRevision">;
type Suggestion = NonNullable<ReturnType<typeof suggestPlanningBasis>>;

/**
 * Planning limits from the official registers: proposes the planning basis at the address and, under a covering
 * B-Plan, reads its figures and rules into the empty fields. Everything stays an unreviewed, cited proposal.
 */
export function PlanningBasisSuggestion({ projectId, draft, disabled, provider, onProvider, onBasis, onPlan }: {
  projectId: string;
  draft: Draft;
  disabled: boolean;
  /** Provider used to read the plan; selected explicitly, never inferred. */
  provider: PlanProvider;
  onProvider: (provider: PlanProvider) => void;
  /** Uses the suggested basis; a B-Plan suggestion carries the register entry for its regime. */
  onBasis: (suggestion: Suggestion) => void;
  /** Receives the plan reading; the caller merges it into the latest draft. */
  onPlan: (plan: PlanExtraction) => void;
}) {
  const t = useT();
  const label = (key: string) => t(`siteBasisSuggestion${key}` as Parameters<typeof t>[0]);
  const summary = (key: string, values: Record<string, string> = {}) =>
    Object.entries(values).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, v), t(`siteSummary${key}` as Parameters<typeof t>[0]));
  const lookup = useBerlinContext(projectId, draft.siteLocator);
  const context = lookup.data;
  const suggestion = context ? suggestPlanningBasis(context) : null;
  const plan = context ? planToRead(draft, context) : null;
  const read = useMutation({
    mutationFn: () => extractPlanFigures(projectId, draft.siteLocator, plan!, provider, draft),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: [`/feasibility/projects/${projectId}/evidence`] });
      onPlan(result);
    },
  });
  const open = draft.planningBasis === "unresolved";

  if (!context) {
    if (!open) return null;
    return <div className="site-basis-suggestions"><div className="site-basis-suggestion text-ui-xs">
      {lookup.error && !lookup.isFetching ? <Callout tone="error">{lookup.error.message}</Callout> : <span className="muted">{label("NotChecked")}</span>}
      <Button size="sm" variant="outline" disabled={lookup.isFetching} onClick={() => void lookup.refetch()}>
        <Search className="size-icon-sm" aria-hidden="true" />{label(lookup.isFetching ? "Checking" : "Check")}
      </Button>
    </div></div>;
  }

  const result = read.data;
  // Figures named like the summary lists them; plan rules alone get their own line.
  const items = (result?.constraints ?? []).map((c) => c.key).filter((key) => (PLAN_LISTED as readonly string[]).includes(key))
    .map((key) => (key === "maxFullStoreys" ? t("siteSummaryStoreys") : key === "grz2" ? "GRZ 2" : key.toUpperCase())).join(", ");
  const resultText = !result ? null
    : result.status === "extracted" ? (items ? summary("FramePlanExtracted", { items, plan: result.plan }) : label("FactsRead").replace("{plan}", result.plan))
    : result.status === "unconfigured" ? summary("FramePlanUnconfigured", { plan: result.plan })
    : result.status === "failed" ? summary("FramePlanReadFailed", { plan: result.plan, message: result.message ?? "" })
    : summary("FramePlanEmpty", { plan: result.plan });

  return <div className="site-basis-suggestions">
    {open && !suggestion && <Callout>{label("Unavailable")}</Callout>}
    {open && suggestion && <Callout tone={suggestion.basis === "section35" ? "warning" : undefined}>
      <div className="site-basis-suggestion">
        <span>{summary(suggestion.detail, suggestion.values)} <span className="muted">{label("Note")}</span></span>
        {suggestion.basis && <Button size="sm" variant="outline" disabled={disabled} onClick={() => onBasis(suggestion)}>
          {label("Use").replace("{basis}", t(`siteAssessment${suggestion.basis}` as Parameters<typeof t>[0]))}
        </Button>}
      </div>
    </Callout>}
    {draft.planningBasis === "b_plan" && plan && <div className="site-basis-suggestion text-ui-xs">
      <span>{label("ReadHint").replace("{plan}", plan.name)}</span>
      <label className="site-summary-provider">
        <span className="muted">{t("siteSummaryPlanReader")}</span>
        <NativeSelect value={provider} disabled={read.isPending} onChange={(e) => onProvider(e.target.value as PlanProvider)} aria-label={t("siteSummaryPlanReader")}>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </NativeSelect>
      </label>
      <Button size="sm" variant="outline" disabled={disabled || read.isPending} aria-busy={read.isPending} onClick={() => read.mutate()}>
        <Sparkles className="size-icon-sm" aria-hidden="true" />{label(read.isPending ? "Reading" : "Read")}
      </Button>
    </div>}
    {resultText && <Callout tone={result!.status === "failed" ? "error" : undefined}>{resultText}</Callout>}
  </div>;
}

