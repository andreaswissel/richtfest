import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { assessFireProtection } from "../src/components/building-model/fire-protection";
import { PlanHeights } from "../src/components/building-model/plan-heights";
import { adaptBuildingModel } from "../src/components/building-model/types";

test("inferred fire height requires approval; manual and last reviewed values remain usable", () => {
  const assess = (reviewStatus: string, provenance = "inferred", reviewedValue: number | null = null) => {
    const model = adaptBuildingModel({ buildings: [{ id: "b", name: "Building" }], properties: [
      { id: "state", entityId: "b", propertyKey: "federalState", current: { value: "BE" } },
      { id: "height", entityId: "b", propertyKey: "fireHeight", entityType: "building", current: { value: 15, provenance, reviewStatus }, reviewed: reviewedValue === null ? null : { value: reviewedValue } },
    ].map(item => ({ entityType: "building", ...item })) });
    return assessFireProtection(model).classification;
  };
  expect(assess("unreviewed").buildingClass).toBeNull();
  expect(assess("unreviewed").gaps).toContain("height");
  expect(assess("approved").buildingClass).toBe(5);
  expect(assess("unreviewed", "manual").buildingClass).toBe(5);
  expect(assess("rejected", "manual").buildingClass).toBeNull();
  expect(assess("unreviewed", "inferred", 15).buildingClass).toBe(5);
});

test("empty unavailable receipt and omitted pages stay explicit and cannot be rerun", () => {
  const model = adaptBuildingModel({ planSources: [{ id: "plan", page: 1, source: { versionId: "v" } }], automaticPlanProcessing: [{ sourceVersionId: "v", fileName: "Section.pdf", renderableSource: { mimeType: "application/pdf" }, heightExtraction: {
    version: "section-heights-v1", status: "unavailable", pages: [], selectedPages: [], omittedPages: [4, 5],
  } }] });
  const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><PlanHeights projectId="p" model={model} onPage={() => {}} /></QueryClientProvider>);
  expect(html).toContain("Unavailable");
  expect(html).toContain("4, 5");
  expect(html).toContain("No eligible section or elevation pages");
  expect(html).not.toContain("Extract heights");
  expect(html).not.toContain("Use height");
});

test("only nonempty partial receipts containing exclusively setup failures offer extraction retry", () => {
  const render = (status: string, statuses: string[], mimeType = "application/pdf", enrolled = true) => {
    const model = adaptBuildingModel({ planSources: enrolled ? [{ id: "plan", page: 1, source: { versionId: "v" } }] : [],
      automaticPlanProcessing: [{ sourceVersionId: "v", fileName: "Looks-like-plan.pdf", renderableSource: { mimeType }, heightExtraction: {
        version: "section-heights-v1", status, pages: statuses.map((status, index) => ({ page: index + 1, status, observations: [], gaps: [] })),
      } }] });
    return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><PlanHeights projectId="p" model={model} onPage={() => {}} /></QueryClientProvider>);
  };
  expect(render("partial", ["unconfigured", "forbidden", "unavailable"])).toContain("Extract heights");
  for (const statuses of [[], ["completed"], ["failed"], ["outcome_unknown"], ["unconfigured", "completed"]]) {
    expect(render("partial", statuses)).not.toContain("Extract heights");
  }
  expect(render("complete", ["unconfigured"])).not.toContain("Extract heights");
  expect(render("unavailable", [])).not.toContain("Extract heights");
  expect(render("partial", ["unconfigured"], "application/octet-stream")).toContain("No registered plan source");
  expect(render("partial", ["unconfigured"], "application/pdf", false)).toContain("No registered plan source");
});
