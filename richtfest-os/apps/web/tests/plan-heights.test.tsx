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

test("clear-height transfer starts with an explicit single-room choice scoped to its source and hierarchy", () => {
  const observation = { kind: "clear_height", value: 275, unit: "cm", unitBasis: "explicit", quote: "Lichte Höhe 275 cm",
    buildingLabel: "House", storeyLabel: "Ground", upperReference: "ceiling", lowerReference: "floor", floorBasis: "finished",
    constructionState: "proposed", region: { x: .1, y: .2, width: .3, height: .4 }, reason: "Printed floor-to-ceiling dimension." };
  const geometry = { source: { sourceVersionId: "v", page: 1 }, polygon: [{ x: .1, y: .1 }, { x: .5, y: .1 }, { x: .5, y: .5 }] };
  const model = adaptBuildingModel({ buildings: [{ id: "b", name: "House", constructionState: "unknown" }],
    storeys: [{ id: "s", name: "Ground", buildingId: "b" }],
    rooms: [
      { id: "target", name: "Saved room", storeyId: "s", constructionState: "proposed", geometry },
      { id: "other-document", name: "Other document room", storeyId: "s", constructionState: "proposed", geometry: { ...geometry, source: { sourceVersionId: "other", page: 1 } } },
      { id: "demolished", name: "Demolished room", storeyId: "s", constructionState: "demolished", geometry },
      { id: "existing", name: "Existing room", storeyId: "s", constructionState: "existing", geometry },
      { id: "wrong-storey", name: "Unassigned storey room", storeyId: "other", constructionState: "proposed", geometry },
    ],
    planSources: [{ id: "plan", storeyId: "s", page: 1, source: { versionId: "v" } }],
    automaticPlanProcessing: [{ sourceVersionId: "v", fileName: "Section.pdf", renderableSource: { mimeType: "application/pdf" },
      heightExtraction: { version: "section-heights-v2", status: "complete", pages: [{ page: 2, status: "completed", observations: [observation], gaps: [] }] } }],
  });
  model.states.proposed.push({ ...model.states.proposed[0]!, id: "candidate", label: "Unaccepted draft", isCandidate: true });
  const render = () => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><PlanHeights projectId="p" model={model} onPage={() => {}} /></QueryClientProvider>);
  const html = render();
  expect(html).toContain("Select one saved room");
  expect(html).toContain("House · Ground · Saved room");
  expect(html).toContain("must actually apply to this room");
  expect(html).toContain("not an adjacent section");
  expect(html).toContain("pending professional review");
  expect(html).not.toContain("Propose room height"); // No auto-selection, even with exactly one eligible room.
  for (const excluded of ["Other document room", "Demolished room", "Existing room", "Unassigned storey room", "Unaccepted draft"])
    expect(html).not.toContain(excluded);
  observation.floorBasis = "structural";
  expect(render()).not.toContain("Select one saved room");
  observation.floorBasis = "finished";
  observation.upperReference = "unknown";
  expect(render()).not.toContain("Select one saved room");
  observation.upperReference = "ceiling";
  for (const value of [149, 2001]) {
    observation.value = value;
    expect(render()).not.toContain("Select one saved room");
  }
  for (const value of [150, 2000]) {
    observation.value = value;
    expect(render()).toContain("Select one saved room");
  }
  model.supersededSources.push({ sourceVersionId: "v", fileName: "Section.pdf", supersededByVersionId: "next" });
  expect(render()).toContain("No registered plan source");
});
