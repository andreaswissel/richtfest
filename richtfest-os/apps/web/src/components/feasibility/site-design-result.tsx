import type { SiteAssessmentInput } from "@richtfest/shared";
import type { SiteDesignResult as Result } from "@richtfest/shared/site-design";
import { useT } from "../../i18n";
import { displayName } from "./site-geometry-editor";
import { usePreferences } from "../../store";
import { Section } from "../layout";
import { Badge } from "../ui/primitives";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
/** Shows a design result computed by the assessment, so the check and the step counts stay in agreement. */
export function SiteDesignResult({ input, result }: { input: SiteAssessmentInput; result: Result | null }) {
  const t = useT(),
    language = usePreferences((s) => s.language),
    label = (key: string) => t(`siteDesign${key}` as Parameters<typeof t>[0]);
  const format = (n: number | null) =>
    n === null
      ? "–"
      : n.toLocaleString(language === "de" ? "de-DE" : "en-GB", {
          maximumFractionDigits: 3,
        });
  if (!input.geometry || !result) return null;
  const buildingName = (id: string) => {
    const index = input.geometry!.buildings.findIndex((b) => b.id === id);
    return index < 0 ? "" : displayName(input.geometry!.buildings[index]!.label, t("siteGeometryObjectBuilding").replace("{n}", String(index + 1)));
  };
  const issueLabel = (issue: string) => {
    const [prefix, code] = issue.split(":");
    if (prefix === "geometry")
      return (
        t(`siteGeometry${code}` as Parameters<typeof t>[0]) ||
        label("GeometryIssue")
      );
    if (prefix === "unreviewed_assessment")
      return `${label("UnreviewedInput")}: ${t(`siteAssessment${code?.split(".")[1] ?? code}` as Parameters<typeof t>[0]) || label("UnreviewedInput")}`;
    return label(prefix!) || label("ReviewRequired");
  };
  return (
    <Section
      title={label("Title")}
      meta={
        <Badge variant="outline">
          {t(`siteAssessment${result.status}` as Parameters<typeof t>[0])}
        </Badge>
      }
    >
      <p className="text-ui-xs muted">{label("Hint")}</p>
      <Table className="site-design-table">
        <TableHeader>
          <TableRow>
            <TableHead>{label("Check")}</TableHead>
            <TableHead>{label("Actual")}</TableHead>
            <TableHead>{label("Limit")}</TableHead>
            <TableHead>{t("status")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.checks.map((c, i) => (
            <TableRow key={`${c.id}:${c.buildingId ?? i}`}>
              <TableCell>
                {label(c.id)}
                {c.buildingId ? ` · ${buildingName(c.buildingId)}` : ""}
              </TableCell>
              {c.id === "placement" ? (
                <>
                  <TableCell>{label(c.actual === 0 ? "PlacementFits" : "PlacementConflict")}</TableCell>
                  <TableCell>{label("PlacementLimit")}</TableCell>
                </>
              ) : (
                <>
                  <TableCell>{format(c.actual)}</TableCell>
                  <TableCell>{format(c.limit)}</TableCell>
                </>
              )}
              <TableCell>
                <Badge variant="outline">{label(c.status)}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {result.issues.length > 0 && (
        <details>
          <summary className="text-ui-xs">
            {label("ReviewRequired")} · {result.issues.length}
          </summary>
          <ul className="text-ui-xs">
            {[...new Set(result.issues.map(issueLabel))].map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </details>
      )}
    </Section>
  );
}
