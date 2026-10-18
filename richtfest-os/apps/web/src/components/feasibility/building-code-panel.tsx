import "./messages";
import { BUILDING_CODE_TOPICS, BUILDING_CODES, BUILDING_CODES_VERSION, isBundesland, type BuildingCode, type BuildingCodeTopic } from "@richtfest/shared/building-codes";
import { useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Section } from "../layout";
import { Badge } from "../ui/primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

/**
 * The state's building-code rules the site tools apply, each with its paragraph. Unverified or missing rules read
 * "Not captured" and are not used in calculations.
 */
export function BuildingCodePanel({ jurisdiction }: { jurisdiction: string }) {
  const t = useT();
  const language = usePreferences((s) => s.language);
  if (!isBundesland(jurisdiction)) return null;
  const code = BUILDING_CODES[jurisdiction];
  const n = (value: number, digits = 2) => value.toLocaleString(language === "de" ? "de-DE" : "en-GB", { maximumFractionDigits: digits });
  const share = (value: number) => (Math.abs(value - 2 / 3) < 1e-6 ? "⅔" : Math.abs(value - 3 / 4) < 1e-6 ? "¾" : Math.abs(value - 1 / 3) < 1e-6 ? "⅓" : `${n(value * 100, 0)} %`);
  const fill = (key: Parameters<typeof t>[0], values: Record<string, string>) => Object.entries(values).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, v), t(key));
  const rule = (topic: BuildingCodeTopic, c: BuildingCode): string | null => {
    if (topic === "setback" && c.setback) {
      const base = fill("buildingCodeSetbackRule", { factor: n(c.setback.factor), minimum: n(c.setback.minimum) });
      return c.setback.commercialFactor != null && c.setback.commercialMinimum != null
        ? `${base} · ${fill("buildingCodeSetbackCommercial", { factor: n(c.setback.commercialFactor), minimum: n(c.setback.commercialMinimum) })}`
        : base;
    }
    if (topic === "publicSpace" && c.publicSpace) return t(c.publicSpace.allowed ? (c.publicSpace.extent === "centre" ? "buildingCodePublicCentre" : "buildingCodePublicAllowed") : "buildingCodePublicNo");
    if (topic === "ancillary" && c.ancillary) {
      const a = c.ancillary;
      return [fill("buildingCodeAncillaryRule", { height: n(a.maxWallHeight) }), a.maxLengthPerBoundary != null && fill("buildingCodePerBoundary", { length: n(a.maxLengthPerBoundary) }), a.maxTotalLength != null && fill("buildingCodeInTotal", { length: n(a.maxTotalLength) })].filter(Boolean).join(", ");
    }
    if (topic === "projections" && c.projections) {
      const p = c.projections;
      return [fill("buildingCodeProjectionRule", { projection: n(p.maxProjection) }), p.maxWallShare != null && fill("buildingCodeWallShare", { share: share(p.maxWallShare) }), p.minBoundaryDistance != null && fill("buildingCodeBoundaryDistance", { distance: n(p.minBoundaryDistance) })].filter(Boolean).join(", ");
    }
    if (topic === "storey" && c.storey) {
      const st = c.storey, height = st.height == null ? "" : fill(st.heightMeasure === "clear" ? "buildingCodeClearHeight" : "buildingCodeStoreyHeight", { height: n(st.height) });
      if (st.basis === "every_storey") return t("buildingCodeStoreyEvery");
      if (st.share == null) return null;
      if (st.basis === "own_area") return fill("buildingCodeStoreyOwn", { share: share(st.share), height });
      return fill(st.equalityCounts ? "buildingCodeStoreyFrom" : "buildingCodeStoreyAbove", { share: share(st.share), height });
    }
    return null;
  };
  return (
    <Section title={`${t("buildingCodeTitle")} · ${code.abbreviation}`}>
      <Table className="site-limits-table" aria-label={t("buildingCodeTitle")}>
        <colgroup><col className="site-limits-name" /><col /><col className="building-code-cite" /></colgroup>
        <TableHeader>
          <TableRow>
            <TableHead>{t("buildingCodeTopic")}</TableHead>
            <TableHead>{t("buildingCodeRule")}</TableHead>
            <TableHead>{t("buildingCodeSource")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {BUILDING_CODE_TOPICS.map((topic) => {
            const entry = code[topic];
            const text = entry?.verified ? rule(topic, code) : null;
            return (
              <TableRow key={topic}>
                <TableCell>{t(`buildingCodeTopic_${topic}` as Parameters<typeof t>[0])}</TableCell>
                <TableCell className="whitespace-normal">
                  {text ?? <Badge variant="outline">{t("buildingCodeNotCaptured")}</Badge>}
                  {text && entry?.unsupported && <> <Badge variant="outline">{t("buildingCodeNotApplied")}</Badge></>}
                </TableCell>
                <TableCell className="muted">{text ? entry!.cite : ""}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="muted text-ui-xs">
        {t("buildingCodeHint").replace("{version}", `${BUILDING_CODES_VERSION}${code.stand ? ` · ${code.stand}` : ""}`)}{" "}
        <a href={code.sourceUrl} target="_blank" rel="noreferrer">
          {code.name}
        </a>
      </p>
    </Section>
  );
}
