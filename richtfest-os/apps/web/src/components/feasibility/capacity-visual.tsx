import type { SiteAssessmentConstraintKey, SiteAssessmentResult } from "@richtfest/shared";
import { useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { Badge } from "../ui/primitives";
import "./capacity-visual.css";

/** Compare like-for-like areas without suggesting surveyed geometry or a building placement. */
export function SiteCapacityVisual({ result, onEdit }: {
  result: SiteAssessmentResult | null;
  onEdit: (key: SiteAssessmentConstraintKey) => void;
}) {
  const t = useT(), language = usePreferences(s => s.language);
  const label = (key: string) => t(`siteAssessment${key}` as Parameters<typeof t>[0]);
  const format = (n: number) => `${n.toLocaleString(language === "de" ? "de-DE" : "en-GB", { maximumFractionDigits: 2 })} m²`;
  const value = result?.baseline;
  const capacityLabel = { grz: "VisualGrz", buildableFootprint: "VisualEnvelope", maxFullStoreys: "VisualStoreys", gfz: "VisualGfz" } as const;
  return <Section title={label("VisualTitle")}>
    <p className="text-ui-xs muted">{label("VisualHint")}</p>
    {value ? <>
      <div className="site-capacity-stages">
        {(["footprint_m2", "full_floor_m2"] as const).map((unit, stage) => {
          const limits = value.limits.filter(limit => limit.unit === unit);
          const scale = Math.max(1, ...limits.map(limit => limit.capacity));
          const usable = stage === 0 ? value.footprint : value.fullFloorArea;
          const minimum = Math.min(...limits.map(limit => limit.capacity));
          return <div className="site-capacity-stage" key={unit}>
            <h3 className="text-ui-sm font-medium">{label(stage === 0 ? "VisualFootprint" : "VisualFloors")}</h3>
            {limits.map(limit => <Button key={limit.id} variant="ghost" className="site-capacity-limit"
              aria-label={label("VisualEdit").replace("{name}", label(limit.id))}
              onClick={() => onEdit(limit.id)}>
              <span className="site-capacity-label text-ui-xs"><span>{label(capacityLabel[limit.id])}</span><span>{format(limit.capacity)}</span></span>
              <span className="site-capacity-track" aria-hidden="true"><span className="site-capacity-fill" style={{ width: `${limit.capacity / scale * 100}%` }} />
                <span className="site-capacity-marker" style={{ left: `${usable / scale * 100}%` }} /></span>
              <span className="site-capacity-status text-ui-2xs">{limit.capacity === minimum && <Badge variant="outline">{label("Binding")}</Badge>}</span>
            </Button>)}
            <div className="site-capacity-total text-ui-xs"><span>{label("VisualUsed")}</span><strong>{format(usable)}</strong></div>
          </div>;
        })}
      </div>
      <dl className="site-capacity-outcome">
        {(["grossFloorArea", "countableFloorArea", "unusedGfzCapacity"] as const).map(key => <div key={key}><dt className="text-ui-xs muted">{label(key)}</dt><dd className="text-ui-lg font-medium">{format(value[key])}</dd></div>)}
      </dl>
    </> : <div className="site-capacity-empty"><p className="text-ui-sm muted">{label("VisualEmpty")}</p><Button variant="outline" onClick={() => onEdit("parcelArea")}>{label("VisualEdit").replace("{name}", label("parcelArea"))}</Button></div>}
  </Section>;
}
