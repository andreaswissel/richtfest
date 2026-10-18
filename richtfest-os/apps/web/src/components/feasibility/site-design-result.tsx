import { useEffect, useMemo, useState } from "react";
import type { SiteAssessmentInput } from "@richtfest/shared";
import type { SiteDesignResult as Result } from "@richtfest/shared/site-design";
import { useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Section } from "../layout";
import { Badge, Callout } from "../ui/primitives";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
export function SiteDesignResult({ input }: { input: SiteAssessmentInput }) {
  const t = useT(),
    language = usePreferences((s) => s.language),
    label = (key: string) => t(`siteDesign${key}` as Parameters<typeof t>[0]);
  const [calculate, setCalculate] =
    useState<(input: SiteAssessmentInput) => Result>();
  useEffect(() => {
    void import("@richtfest/shared/site-design").then((m) =>
      setCalculate(() => m.calculateSiteDesign),
    );
  }, []);
  const result = useMemo(() => calculate?.(input), [calculate, input]);
  const format = (n: number | null) =>
    n === null
      ? "–"
      : n.toLocaleString(language === "de" ? "de-DE" : "en-GB", {
          maximumFractionDigits: 3,
        });
  if (!input.geometry || !result) return null;
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
                {c.buildingId
                  ? ` · ${input.geometry!.buildings.find((b) => b.id === c.buildingId)?.label ?? ""}`
                  : ""}
              </TableCell>
              <TableCell>{format(c.actual)}</TableCell>
              <TableCell>{format(c.limit)}</TableCell>
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
