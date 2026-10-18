import { Link } from "react-router-dom";
import { Lightbulb } from "lucide-react";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Callout } from "../ui/primitives";
import { useNoiseSiteSuggestions } from "../noise-sources/suggestions";

/** One proposal near the building; `axisId` highlights the matching road or railway in the viewport. */
export type SiteSuggestion = {
  id: string;
  title: string;
  detail: string;
  distanceMeters: number;
  reason: string;
  axisId?: string;
};

/** A planning domain that proposes site records for review, such as exterior noise sources. */
export type SiteSuggestionDomain = {
  key: string;
  title: string;
  hint: string;
  /** The domain's own screen, where accepted records are edited. */
  link: string;
  /** False until the domain has the data it screens, e.g. before the roads and railways lookup. */
  available: boolean;
  suggestions: SiteSuggestion[];
  accept: (ids: string[]) => void;
  accepting: boolean;
  error: unknown;
};

/** Every domain that suggests site records. A new domain adds its provider hook here. */
export function useSiteSuggestions(projectId: string): SiteSuggestionDomain[] {
  return [useNoiseSiteSuggestions(projectId)];
}

export function SiteSuggestionsSection({ domains, canWrite }: { domains: SiteSuggestionDomain[]; canWrite: boolean }) {
  const t = useT();
  return (
    <div className="location-layer-section">
      <h3 className="site-section-title site-suggestions-title">
        <Lightbulb className="size-icon-sm" />
        {t("siteSuggestions")}
      </h3>
      {domains.map((domain) => (
        <div key={domain.key} className="site-suggestion-domain">
          <div className="site-suggestion-head">
            <Link className="text-ui-xs underline underline-offset-2" to={domain.link}>{domain.title}</Link>
            {canWrite && domain.suggestions.length > 1 && (
              <Button size="sm" variant="ghost" disabled={domain.accepting} onClick={() => domain.accept(domain.suggestions.map((item) => item.id))}>
                {t("noiseSuggestedAddAll").replace("{count}", String(domain.suggestions.length))}
              </Button>
            )}
          </div>
          {!domain.available ? (
            <p className="text-ui-xs muted">{t("siteSuggestionsUnavailable")}</p>
          ) : domain.suggestions.length ? (
            <>
              {domain.suggestions.map((item) => (
                <div key={item.id} className="site-distance-row site-suggestion-row">
                  <span>
                    {item.title}
                    <span>{item.detail} · {item.distanceMeters} m · {item.reason}</span>
                  </span>
                  {canWrite && (
                    <Button size="sm" variant="ghost" disabled={domain.accepting} onClick={() => domain.accept([item.id])}>{t("noiseAdd")}</Button>
                  )}
                </div>
              ))}
              <p className="text-ui-2xs muted">{domain.hint} {t("siteSuggestionsHighlighted")}</p>
            </>
          ) : (
            <p className="text-ui-xs muted">{t("siteSuggestionsNone")}</p>
          )}
          {!!domain.error && <Callout tone="error">{domain.error instanceof Error ? domain.error.message : String(domain.error)}</Callout>}
        </div>
      ))}
    </div>
  );
}
