import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AutomaticPlanCoverage, BuildingModelBootstrap, BuildingModelMode, CandidateInspector, ExtractionPanel, outlineTargetsAt, automaticPageDisposition, automaticProcessingActive, candidateOverlaysForSource, candidatesForGroup, candidatesForSource, candidatesForModelState, copyStableObjectId, isEntityDeepLink, planSourceForSelection, planSourceForView, preferredAutomaticProcessing, preferredPlanSource, regionsForSource } from "../src/components/building-model";
import commonEn from "../src/locales/en.json";
import commonDe from "../src/locales/de.json";
import buildingEn from "../src/components/building-model/locales/en.json";
import buildingDe from "../src/components/building-model/locales/de.json";
import { RegulatoryBasis } from "../src/components/building-model/sound-insulation";
import { PropertyRow } from "../src/components/building-model/component-properties";
import { assessFireProtection } from "../src/components/building-model/fire-protection";
import { BUILDING_CODES } from "@richtfest/shared/building-codes";
import { PdfEvidenceRenderer } from "../src/components/building-model/pdf-evidence-renderer";
import { inlinePdfSource, overlayInteractionStyle, overlayRegionAtPoint, partOverlayStyle, polygonClipPath } from "../src/components/building-model/pdf-evidence-renderer";
import { adaptBuildingModel, candidateRole } from "../src/components/building-model/types";
import { metresToPoint, planDistanceM, pointToMetres } from "../src/components/building-model/outline-geometry";
import { buildingVolumeGeometry, roomVolumeGeometry } from "../src/components/building-model/room-volumes";
import { buildingPresentation, buildingSiteTransform } from "../src/components/building-model/building-presentation";
import { geometryArea } from "@richtfest/shared/site-geometry";
import { BuildingConnections } from "../src/components/building-model/connections";
import { buildingComponentProperties, createEmptySiteAssessmentInput } from "@richtfest/shared";

const en = { ...commonEn, ...buildingEn };
const de = { ...commonDe, ...buildingDe };
const projectId = "550e8400-e29b-41d4-a716-446655440000";

test("planner chooses a source explicitly without changing Nerd mode or blocking evidence links", () => {
  const model = {
    planSources: [
      { id: "a", page: 2, storeyId: "a-ground", source: { versionId: "a-version", fileName: "Approval.pdf" } },
      { id: "b", page: 7, storeyId: "b-upper", source: { versionId: "b-version", fileName: "Earlier.pdf" } },
    ],
    rooms: [{ id: "room", name: "Office", storeyId: "b-upper", geometry: { source: { sourceVersionId: "b-version", page: 7 } } }],
    supersededSources: [{ sourceVersionId: "b-version" }],
  };
  const search = "?view=building-model&perspective=planner";
  for (const suffix of ["", "&sourceVersion=deleted&sourceSelection=manual"]) {
    const html = render(model, search + suffix);
    expect(html).toContain(en.plannerPlanChoose);
    expect(html).toContain(en.plannerPlanSuperseded);
    expect(html).not.toContain('data-model-view=');
    const choices = [...html.matchAll(/<a(?=[^>]*aria-label="View plan:)[^>]*href="([^"]+)"/g)].map(match => new URL(match[1]!.replaceAll("&amp;", "&"), "https://app.example").searchParams);
    expect(choices.map(choice => [choice.get("sourceVersion"), choice.get("page"), choice.get("storey"), choice.get("sourceSelection")]))
      .toEqual([["a-version", "2", "a-ground", "manual"], ["b-version", "7", "b-upper", "manual"]]);
  }
  const chosen = render(model, search + "&sourceVersion=b-version&storey=b-upper&page=7&sourceSelection=manual");
  expect(chosen).not.toContain(en.plannerPlanChoose);
  expect(chosen).toContain(en.plannerPlanShown);
  expect(chosen).toContain(en.plannerPlanScope);
  expect(render(model, search + "&entity=room:room")).not.toContain(en.plannerPlanChoose);
  expect(render(model, "?view=building-model&perspective=nerd")).not.toContain(en.plannerPlanChoose);
  expect(render({ ...model, planSources: [model.planSources[0]] }, search)).not.toContain(en.plannerPlanChoose);
});

test("planner's next action distinguishes preparation, missing scale and source review", () => {
  const model = { planSources: [{ id: "source", page: 1, storeyId: "ground", source: { versionId: "version", fileName: "Plans.pdf" } }] };
  const search = "?view=building-model&perspective=planner&sourceSelection=manual&sourceVersion=version&storey=ground&page=1&modelView=3d";
  for (const status of ["running", "failed", "complete"]) {
    const html = render({ ...model, extractions: [{ id: "job", sourceVersionId: "version", storeyId: "ground", page: 1, status,
      result: { pageScale: { pageAspectRatio: 1, metresPerPageHeight: 20 } } }] }, search);
    expect(html).toContain(status === "complete" ? en.plannerPlanReviewHint : en.plannerPlanPreparationHint);
    expect(html).not.toContain(en.plannerPlanScaleHint);
    if (status === "complete") expect(html).toMatch(/href="[^"]*modelView=2d[^"]*"[^>]*>Review floor plan/);
  }
  expect(render(model, search)).toContain(en.plannerPlanScaleHint);
});

test("floor navigation uses semantic names, preserves custom names and never treats page numbers or conflicting titles as levels", () => {
  const storeys = ["ground", "unknown", "conflict", "entered", "custom"].map((id, index) => ({ id, name: id === "custom" ? "Workshop mezzanine" : `Plan page ${index + 8} (draft)`, levelIndex: id === "entered" ? -2 : null }));
  const planSources = storeys.map((storey, index) => ({ id: storey.id, storeyId: storey.id, page: index + 8,
    source: { versionId: "plan", fileName: "Plan.pdf" }, storeyTitle: storey.id === "unknown" ? null : { level: 0, quote: "Grundriss EG" } }));
  const model = { storeys, planSources: [...planSources, { ...planSources[2], id: "conflicting", page: 50, storeyTitle: { level: 2, quote: "Grundriss 2. OG" } }],
    extractions: storeys.map((storey, i) => ({ id: `job${i}`, storeyId: storey.id, page: i + 8, sourceVersionId: "plan", status: "complete",
      result: { pageScale: { pageAspectRatio: 1, metresPerPageHeight: 10 } } })),
    extractionCandidates: storeys.map((storey, i) => ({ id: `candidate${i}`, entityType: "room", storeyId: storey.id, page: i + 8,
      sourceVersionId: "plan", status: "unreviewed", geometry: { quality: "enclosed_region",
        polygon: [{ x: .1, y: .1 }, { x: .5, y: .1 }, { x: .5, y: .3 }] } })),
  };
  const html = render(model, "?view=building-model&modelView=3d&page=8&storey=ground&sourceVersion=plan&floorFocus=1&roomFocus=1&entity=room:old-selection");
  const nav = html.split('<nav class="building-volume-floors"')[1]!.split("</nav>")[0]!;
  expect(nav).toContain("Ground floor");
  expect(nav).toContain("Basement 2 (2. UG)");
  expect(nav).toContain("Workshop mezzanine");
  expect(nav.match(/Unidentified floor/g)).toHaveLength(2);
  expect(nav).not.toContain("Plan page");
  expect(html).toContain("Printed floor title · unreviewed: Grundriss EG");
  const currentLink = nav.match(/<a\b[^>]*aria-current="true"[^>]*>/g)!.find(link => link.includes("storey=ground"))!;
  expect(currentLink).not.toContain("floorFocus");
  expect(currentLink).not.toContain("roomFocus");
  expect(currentLink).not.toContain("entity=");
  const roomHtml = render({ ...model, rooms: [{ id: "room", storeyId: "ground", name: "Office", geometry: { source: { sourceVersionId: "plan", page: 8 } } }] },
    "?view=building-model&modelView=3d&page=8&storey=ground&sourceVersion=plan&floorFocus=1&roomFocus=1&entity=room:room");
  const roomNav = roomHtml.split('<nav class="building-volume-floors"')[1]!.split("</nav>")[0]!;
  const returnToFloor = roomNav.match(/<a\b[^>]*aria-current="true"[^>]*>/g)!.find(link => link.includes("storey=ground"))!;
  expect(returnToFloor).toContain("floorFocus=1");
  expect(returnToFloor).not.toContain("roomFocus");
  expect(returnToFloor).not.toContain("entity=");
  expect(JSON.stringify(model)).toContain("Plan page 8 (draft)"); // Display projection, not a canonical rename.
});

test("connection inspector retains rejected evidence but excludes it from active room boundaries and opening hosts", () => {
  const links = [
    { id: "boundary", fromEntityType: "element", fromEntityId: "wall", toEntityType: "room", toEntityId: "room", relationshipType: "separates", reviewStatus: "rejected", metadata: { side: 0, sourceVersionId: "source", page: 2 } },
    { id: "outside", fromEntityType: "element", fromEntityId: "wall", toEntityType: "storey", toEntityId: "storey", relationshipType: "faces_exterior", reviewStatus: "approved", metadata: { side: 1 } },
    { id: "host", fromEntityType: "element", fromEntityId: "door", toEntityType: "element", toEntityId: "wall", relationshipType: "opening_in", reviewStatus: "superseded", metadata: null },
  ];
  const model = adaptBuildingModel({ relationships: links, rooms: [{ id: "room", name: "Office", storeyId: "storey" }],
    elements: [{ id: "wall", kind: "wall", name: "Wall" }, { id: "door", kind: "door", name: "Door" }] });
  expect(model.relationships).toEqual(links);
  const objects = model.states.existing;
  const wall = objects.find(object => object.id === "wall")!;
  expect(wall.separates).toEqual([{ side: 1, roomIds: [], exterior: true }]);
  expect(wall.openings).toBeUndefined();
  expect(objects.find(object => object.id === "door")!.inWall).toBeUndefined();
  const renderInspector = (id: string) => renderToStaticMarkup(<MemoryRouter><BuildingConnections model={model} objects={objects}
    selected={objects.find(object => object.id === id)} hrefFor={object => `?entity=${object.entityType}:${object.id}`}
    onReview={() => {}} onDerive={() => {}} pending={false} /></MemoryRouter>);
  const html = renderInspector("wall");
  expect(html).toContain("Rejected");
  expect(html).toContain("Confirmed");
  expect(html).toContain("Wall side 1 is unresolved");
  expect(html).toContain("sourceVersion=source");
  expect(html).toContain("entity=room:room");
  expect(renderInspector("room")).toContain("Enclosure is unresolved");
  expect(renderInspector("door")).toContain("No active wall host");
});

test("3D consumes canonical and provisional room outlines, but never label boxes, rejected drafts or duplicate matches", () => {
  const polygon = [{ x: .1, y: .2 }, { x: .4, y: .2 }, { x: .4, y: .6 }, { x: .1, y: .6 }];
  const room = { id: "room", kind: "room" as const, entityType: "room" as const, label: "Room", page: 1, polygon,
    holes: [[{ x: .2, y: .3 }, { x: .25, y: .3 }, { x: .25, y: .35 }]] };
  const scale = { pageAspectRatio: 2, metresPerPageHeight: 10 };
  const draft = { ...room, id: "candidate", isCandidate: true, status: "unreviewed", geometryQuality: "enclosed_region" };
  const result = roomVolumeGeometry([room, draft, { ...draft, id: "label", geometryQuality: "anchor" },
    { ...draft, id: "rejected", status: "rejected" }, { ...draft, id: "accepted", status: "approved" },
    { ...draft, id: "matched", match: { existingId: room.id } }], [], scale);
  expect(result.map(item => item.room.id)).toEqual(["room", "candidate"]);
  expect(result[0]!.mesh.polygons).toEqual([[[[2, 2], [8, 2], [8, 6], [2, 6]], [[4, 3], [5, 3], [5, 3.5]]]]);
  expect(result[1]!.mesh.polygons).toEqual(result[0]!.mesh.polygons);
  expect(result[0]!.mesh.height).toBe(2.6);
  expect(result[0]!.height.calculationValue).toBeNull();
  expect(roomVolumeGeometry([room], [], null)).toEqual([]);
  const reviewedHeight = { propertyId: "height", version: 1, value: 3.1, unit: "m", provenance: "inferred", reviewStatus: "approved", reviewRevision: 1, reviewedValue: 3.1 };
  const inherited = roomVolumeGeometry([{ ...room, storeyId: "storey" }, { ...draft, storeyId: "storey" }],
    [{ id: "storey", componentProperties: { clearRoomHeight: reviewedHeight } }], scale);
  expect(inherited.map(item => item.mesh.height)).toEqual([3.1, 3.1]);
  expect(inherited[1]!.mesh.color).toBe(result[1]!.mesh.color); // Reviewing the height must not visually approve a draft outline.
  expect(inherited[0]!.mesh.color).not.toBe(inherited[1]!.mesh.color);
});

test("3D opens source-scoped extraction drafts before any canonical rooms exist and explains missing prerequisites", () => {
  const model = {
    revision: 1,
    storeys: [{ id: "storey", name: "Ground floor" }],
    planSources: [{ id: "plan", page: 3, storeyId: "storey", source: { versionId: "version", fileName: "Plan.pdf" } }],
    extractions: [{ id: "job", page: 3, storeyId: "storey", sourceVersionId: "version", status: "complete", result: { pageScale: { pageAspectRatio: 2, metresPerPageHeight: 10 } } }],
    extractionCandidates: [
      { id: "draft", name: "Visible draft", page: 3, sourceVersionId: "version", status: "unreviewed" },
      { id: "other-page", name: "Wrong page", page: 4, sourceVersionId: "version", status: "unreviewed" },
      { id: "other-source", name: "Wrong revision", page: 3, sourceVersionId: "old", status: "unreviewed" },
      { id: "rejected", name: "Rejected draft", page: 3, sourceVersionId: "version", status: "rejected" },
    ].map(candidate => ({ ...candidate, entityType: "room", storeyId: "storey", geometry: { quality: "enclosed_region", polygon: [{ x: .1, y: .1 }, { x: .4, y: .1 }, { x: .4, y: .5 }] } })),
  };
  const route = "?view=building-model&modelView=3d&page=3&storey=storey&sourceVersion=version&candidate=candidate:draft";
  const html = render(model, route);
  expect(html).toContain("Visible draft");
  expect(html).toContain("Draft outline · 2.60 m");
  expect(html).toContain("Accept room outline");
  expect(html).toContain("Review outline in 2D");
  expect(html).not.toContain("Save assumed height"); // No properties may be written against a candidate ID.
  for (const excluded of ["Wrong page", "Wrong revision", "Rejected draft"]) expect(html).not.toContain(excluded);
  const noScale = render({ ...model, extractions: [] }, route);
  expect(noScale).toContain("this page has no metric scale");
  expect(noScale).not.toContain('class="building-volume-legend');
  expect(render({ ...model, extractionCandidates: [] }, route)).toContain("No rooms or room drafts on this source page");
});

test("3D stacks source-scaled floors and real wall polygons without inventing enclosure or mixing buildings and revisions", () => {
  const storeys = [{ id: "upper", buildingId: "building", levelIndex: 1 }, { id: "lower", buildingId: "building", levelIndex: 0 },
    { id: "section", buildingId: "building" }, { id: "other", buildingId: "other-building" }, { id: "old", buildingId: "building" }];
  const polygon = [{ x: .1, y: .2 }, { x: .4, y: .2 }, { x: .4, y: .6 }, { x: .1, y: .6 }];
  const model = adaptBuildingModel({ storeys,
    planSources: storeys.map((storey, i) => ({ id: `source-${storey.id}`, storeyId: storey.id, page: i + 1, source: { versionId: storey.id === "old" ? "old" : "version" } })),
    supersededSources: [{ sourceVersionId: "old" }],
    automaticPlanProcessing: [{ sourceVersionId: "version", nonFloorPlanPages: [{ page: 3 }] }],
    extractions: storeys.map((storey, i) => ({ id: `job-${i}`, storeyId: storey.id, page: i + 1, sourceVersionId: "version", status: "complete",
      result: { pageScale: { pageAspectRatio: i === 0 ? 1 : 2, metresPerPageHeight: i === 0 ? 30 : 10 } } })),
    extractionCandidates: storeys.flatMap((storey, i) => ["draft_wall", "construction_fragment_assembly", "footprint"].map(quality => ({
      id: `${storey.id}-${quality}`, entityType: "element", name: quality, storeyId: storey.id, page: i + 1,
      sourceVersionId: "version", status: "unreviewed", geometry: { quality, polygon, holes: [[{ x: .2, y: .3 }, { x: .25, y: .3 }, { x: .2, y: .35 }]] },
    }))),
  });
  const before = JSON.stringify(model);
  const floors = buildingVolumeGeometry(model, model.extractionCandidates, "source-lower");
  expect(floors.map(floor => floor.storey.id)).toEqual(["lower", "upper"]); // Level order, not PDF page order.
  expect(floors.map(floor => floor.wallCount)).toEqual([1, 1]); // Generic fills never become walls.
  expect(floors.map(floor => floor.base)).toEqual([0, 2.9]);
  expect(floors[0]!.meshes[0]!.polygons[0]![0]).toEqual([[-3, -2], [3, -2], [3, 2], [-3, 2]]);
  expect(floors[1]!.meshes[0]!.polygons[0]![0]).toEqual([[-2, 2], [7, 2], [7, 14], [-2, 14]]); // Same metric sheet origin, not independently re-centred.
  expect(floors[1]!.meshes[0]!.base).toBe(2.9);
  expect(floors[0]!.meshes[0]!.polygons[0]).toHaveLength(2); // Preserve source holes, not a bounding-box enclosure.
  expect(JSON.stringify(model)).toBe(before); // Stacking and alignment remain unsaved preview assumptions.
  const context = { siteId: "test", address: "", origin: [990, 2010] as [number, number], crs: "EPSG:25832" as const,
    longitude: 0, latitude: 0, radius: 100, buildings: [], trees: [], sources: [], importedAt: "" };
  const placement = { id: "placement", origin: { x: 1000, y: 2000, crs: "EPSG:25832" as const }, orientation: { degrees: 90 },
    alignmentStatus: "approximate" as const, evidence: [{ kind: "page", sourceVersionId: "version", page: 2 }] };
  const transform = buildingSiteTransform(floors, context, placement)!;
  // Sheet (2,2) rotated 90° gives UTM (1002,2002), then site-local (12,8).
  expect(transform(floors[0]!.meshes[0]!.polygons[0]![0]![0]!)).toEqual([12, 8]);
  expect(transform(floors[1]!.meshes[0]!.polygons[0]![0]![0]!)).toEqual([16, 7]);
  expect(buildingSiteTransform(floors, context, null)).toBeNull();
  expect(buildingSiteTransform(floors, context, { ...placement, alignmentStatus: "unknown" })).toBeNull();
  expect(buildingSiteTransform(floors, { ...context, crs: "EPSG:25833" }, placement)).toBeNull();
  expect(buildingSiteTransform(floors, context, { ...placement, evidence: [{ kind: "page", sourceVersionId: "obsolete", page: 2 }] })).toBeNull();
  model.extractions[0]!.result!.pageScale = null;
  const missing = buildingVolumeGeometry(model, model.extractionCandidates, "source-lower");
  expect(missing.map(floor => floor.storey.id)).toEqual(["lower", "upper"]);
  expect(missing[1]!.meshes).toEqual([]); // Missing floors remain navigable, never inherit a different page's scale.
});

test("3D isolates the selected plan set even when uploads created separate storey identities", () => {
  const rows = [
    { id: "a-ground", version: "a", page: 1 },
    { id: "b-ground", version: "b", page: 1 },
    { id: "a-upper", version: "a", page: 2 },
    { id: "b-upper", version: "b", page: 2 },
    { id: "b-roof", version: "b", page: 3 },
  ];
  const model = adaptBuildingModel({
    storeys: rows.map(row => ({ id: row.id, buildingId: "building", levelIndex: null })),
    planSources: rows.map(row => ({ id: `source-${row.id}`, storeyId: row.id, page: row.page, source: { versionId: row.version } })),
    extractions: rows.map(row => ({ id: `job-${row.id}`, storeyId: row.id, sourceVersionId: row.version, page: row.page,
      status: "complete", result: { pageScale: { pageAspectRatio: 1, metresPerPageHeight: 10 } } })),
    extractionCandidates: rows.map(row => ({ id: `wall-${row.id}`, storeyId: row.id, sourceVersionId: row.version, page: row.page,
      entityType: "element", status: "unreviewed", geometry: { quality: "draft_wall",
        polygon: [{ x: .1, y: .1 }, { x: .7, y: .1 }, { x: .7, y: .13 }, { x: .1, y: .13 }] } })),
  });
  const before = JSON.stringify(model);
  for (const hideEmpty of [false, true]) {
    const a = buildingVolumeGeometry(model, model.extractionCandidates, "source-a-upper", hideEmpty);
    expect(a.map(floor => floor.storey.id)).toEqual(["a-ground", "a-upper"]);
    expect(a.map(floor => floor.base)).toEqual([0, 2.9]);
    const b = buildingVolumeGeometry(model, model.extractionCandidates, "source-b-ground", hideEmpty);
    expect(b.map(floor => floor.storey.id)).toEqual(["b-ground", "b-upper", "b-roof"]);
    expect(b.map(floor => floor.base)).toEqual([0, 2.9, 5.8]);
  }
  expect(buildingVolumeGeometry(model, model.extractionCandidates).map(floor => floor.storey.id)).toEqual(["a-ground", "a-upper"]);
  expect(JSON.stringify(model)).toBe(before);
});

test("building presentation preserves holes, uses canonical openings before traced infill and never writes illustrative facts", () => {
  const box = (x: number, y: number, width: number, height: number) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
  const geometry = { polygon: box(.1, .1, .6, .6), holes: [box(.3, .3, .2, .2)], source: { sourceVersionId: "version", storeyId: "floor", page: 1 } };
  const opening = { sourceKey: "gap", kind: "jamb_pair", wallAxis: "horizontal", sourceKeys: ["jamb"], closure: { x: .3, y: .08, width: .15, height: .02 } };
  const model = adaptBuildingModel({ storeys: [{ id: "floor", levelIndex: 0 }],
    planSources: [{ id: "plan", storeyId: "floor", page: 1, source: { versionId: "version" } }],
    extractions: [{ id: "job", storeyId: "floor", page: 1, sourceVersionId: "version", result: {
      pageScale: { pageAspectRatio: 1, metresPerPageHeight: 10 }, topologyCoverage: { openingEvidence: [opening, { ...opening, sourceKey: "wrong-phase", sourceKeys: ["demolished-jamb"] }] },
    } }],
    rooms: [{ id: "bedroom", name: "Schlafen", geometry }],
    elements: [{ id: "wall", kind: "wall", geometry: { ...geometry, polygon: box(.1, .08, .2, .02), holes: [], sourceFootprintKeys: ["jamb"] } },
      { id: "window", kind: "window", geometry: { ...geometry, polygon: box(.3, .08, .15, .02), holes: [] } }],
  });
  const before = JSON.stringify(model);
  const floors = buildingVolumeGeometry(model, model.states.existing, "plan");
  const result = buildingPresentation(floors);
  expect(result.placedOpenings).toBe(1);
  expect(result.provisionalOpenings).toBe(0); // No duplicate infill, no gap from a wall outside this construction state.
  expect(result.furnishedRooms).toBe(0); // A bed at the bounding-box centre would sit in a shaft.
  const slab = result.meshes.find(mesh => mesh.id === "floor" && !mesh.roof)!;
  expect(geometryArea(slab.polygons)).toBeCloseTo(32.7); // 6×6 room minus 2×2 hole + (2+1.5)×0.2 wall/opening.
  const glazed = result.meshes.find(mesh => mesh.id === "window" && mesh.opacity! < 1)!;
  expect(glazed.base).toBeCloseTo(.97);
  expect(glazed.height).toBeCloseTo(1.26);
  const previewOnly = buildingPresentation(buildingVolumeGeometry(model, model.states.existing.filter(object => object.id !== "window"), "plan"));
  expect(previewOnly.placedOpenings).toBe(0);
  expect(previewOnly.provisionalOpenings).toBe(1);
  expect(previewOnly.meshes.some(mesh => mesh.id === "wall" && mesh.opacity! < 1)).toBe(true); // Clickable source jamb, not a fabricated canonical window ID.
  expect(JSON.stringify(model)).toBe(before);
});

test("3D anchors known basement levels below ground without inventing ground from page order", () => {
  const levels = [-2, -1, 0, 1, 3];
  const model = adaptBuildingModel({
    storeys: levels.map(level => ({ id: `floor${level}`, name: `Floor ${level}`, levelIndex: level, buildingId: "building" })),
    planSources: levels.map((level, index) => ({ id: `plan${level}`, storeyId: `floor${level}`, page: index + 1, source: { versionId: "version" } })),
    extractions: levels.map((level, index) => ({ id: `job${level}`, storeyId: `floor${level}`, page: index + 1, sourceVersionId: "version", status: "complete",
      result: { pageScale: { pageAspectRatio: 1, metresPerPageHeight: 10 } } })),
    extractionCandidates: levels.map((level, index) => ({ id: `room${level}`, name: `Room ${level}`, entityType: "room", storeyId: `floor${level}`,
      page: index + 1, sourceVersionId: "version", status: "unreviewed", geometry: { quality: "enclosed_region", polygon: [{ x: .1, y: .1 }, { x: .4, y: .1 }, { x: .4, y: .5 }] } })),
  });
  model.storeys[0]!.componentProperties = { clearRoomHeight: { propertyId: "height", version: 1, value: 3.2, unit: "m", provenance: "inferred", reviewStatus: "unreviewed", reviewRevision: 0 } };
  const before = JSON.stringify(model);
  const floors = buildingVolumeGeometry(model, model.extractionCandidates, "plan0");
  expect(floors.map(floor => Number(floor.base.toFixed(2)))).toEqual([-6.4, -2.9, 0, 2.9, 8.7]);
  expect(floors.map(floor => Number(floor.meshes[0]!.base.toFixed(2)))).toEqual([-6.4, -2.9, 0, 2.9, 8.7]);
  expect(JSON.stringify(model)).toBe(before);
  // Unknown ordering must not claim a ground datum, even when another floor is level zero.
  model.storeys[0]!.levelIndex = null;
  expect(buildingVolumeGeometry(model, [], "plan0").every(floor => floor.base >= 0)).toBe(true);
});

test("3D can hide empty stack slots without changing records or erasing unexplained level gaps", () => {
  const levels = [0, 1, 2, 4, null];
  const model = adaptBuildingModel({
    storeys: levels.map((levelIndex, i) => ({ id: `floor${i}`, levelIndex, buildingId: "building" })),
    planSources: levels.map((_, i) => ({ id: `plan${i}`, storeyId: `floor${i}`, page: i + 1, source: { versionId: "version" } })),
    extractions: levels.map((_, i) => ({ id: `job${i}`, storeyId: `floor${i}`, page: i + 1, sourceVersionId: "version", status: "complete",
      result: { pageScale: { pageAspectRatio: 1, metresPerPageHeight: 10 } } })),
    extractionCandidates: [0, 2, 3].map(i => ({ id: `room${i}`, entityType: "room", storeyId: `floor${i}`, page: i + 1,
      sourceVersionId: "version", status: "unreviewed", geometry: { quality: "enclosed_region",
        polygon: [{ x: .1, y: .1 }, { x: .6, y: .1 }, { x: .6, y: .3 }, { x: .1, y: .3 }] } })),
  });
  const before = JSON.stringify(model);
  const all = buildingVolumeGeometry(model, model.extractionCandidates, "plan0");
  const hidden = buildingVolumeGeometry(model, model.extractionCandidates, "plan0", true);
  expect(all).toHaveLength(5);
  expect(hidden.map(floor => floor.storey.id)).toEqual(["floor0", "floor2", "floor3"]);
  expect(hidden.map(floor => Number(floor.base.toFixed(2)))).toEqual([0, 2.9, 8.7]); // Empty level 1 removed; unknown level 3 is not fabricated away.
  expect(hidden.map(floor => floor.level)).toEqual([0, 2, 4]);
  model.storeys.forEach(storey => { storey.levelIndex = null; });
  expect(buildingVolumeGeometry(model, model.extractionCandidates, "plan0", true).map(floor => Number(floor.base.toFixed(2)))).toEqual([0, 2.9, 5.8]);
  model.storeys.forEach((storey, i) => { storey.levelIndex = levels[i]!; });
  expect(JSON.stringify(model)).toBe(before);
  expect(buildingVolumeGeometry(model, [], "plan0", true)).toEqual([]);
});

test("PDF evidence stays on the authenticated app origin for inline rendering", () => {
  expect(inlinePdfSource(`/api/projects/${projectId}/files/file/versions/1/download`)).toBe(`/api/projects/${projectId}/files/file/versions/1/download?inline=1`);
  expect(inlinePdfSource(`/api/projects/${projectId}/files/file/versions/1/download?token=local#page=2`)).toBe(`/api/projects/${projectId}/files/file/versions/1/download?token=local&inline=1#page=2`);
  expect(inlinePdfSource("https://example.com/plan.pdf")).toBe("https://example.com/plan.pdf");
});

const wallReviewFixture = {
  revision: 1,
  states: { existing: [], demolition: [], proposed: [{ id: "approved-proposed", kind: "element", label: "Canonical proposed wall", page: 3 }] },
  planSources: [{ id: "plan", storeyId: "storey-1", page: 3, source: { versionId: "version-1", fileName: "Plan.pdf" } }],
  extractionCandidates: [
    { id: "visible-source", page: 3, sourceVersionId: "version-1", storeyId: "storey-1" },
    { id: "other-page", page: 2, sourceVersionId: "version-1", storeyId: "storey-1" },
    { id: "other-version", page: 3, sourceVersionId: "version-2", storeyId: "storey-1" },
    { id: "other-storey", page: 3, sourceVersionId: "version-1", storeyId: "storey-2" },
  ].map((source) => ({ ...source, entityType: "element", name: `Wall hypothesis ${source.id}`, status: "unreviewed", constructionState: "proposed", geometry: { quality: "draft_wall", semanticKind: "draft_wall", planRegion: { x: .2, y: .2, width: .01, height: .3 }, classification: { pageRelativeMinorDimension: .01, evidenceTier: "medium" } } })),
};

test("hidden wall review link preserves exact source context without leaking proposed canonical objects", () => {
  for (const state of ["existing", "demolition"]) {
    const html = render(wallReviewFixture, `?view=building-model&page=3&sourceVersion=version-1&storey=storey-1&modelState=${state}&context=keep`);
    expect(html).toContain("1 wall hypotheses hidden by this model state");
    expect(html).toContain("unreviewed source-layer phase hypotheses");
    expect(html).toContain(`href="/projects/${projectId}?view=building-model&amp;page=3&amp;sourceVersion=version-1&amp;storey=storey-1&amp;modelState=proposed&amp;context=keep"`);
    expect(html).toContain("Review wall hypotheses");
    expect(html).not.toContain("Canonical proposed wall");
    expect(html).not.toContain("Wall hypothesis visible-source");
  }
});

test("building model is one workbench: toolbar, outliner, tool rail, properties and status bar", () => {
  const html = render({
    ...wallReviewFixture,
    reviewStatus: "reviewed",
    evidence: { fileName: "Plan.pdf", pageCount: 3 },
    extractions: [{ id: "job-1", sourceVersionId: "version-1", storeyId: "storey-1", page: 3, status: "complete" }],
  }, "?view=building-model&page=3&sourceVersion=version-1&storey=storey-1");
  expect(html).toContain('class="building-model is-workbench"');
  expect(html).toContain('<strong title="Plan.pdf">Plan.pdf</strong>');
  expect(html).toContain('aria-label="Page 3 · Unresolved page" title="Unresolved page" aria-pressed="true"');
  expect(html).toContain('aria-label="Plan context: Extraction complete"');
  expect(html).toContain('<aside class="building-model-outliner" aria-label="Outliner">');
  expect(html).toContain('aria-label="Add plan region"');
  expect(html).toContain('role="toolbar" aria-orientation="vertical" aria-label="Plan tools"');
  for (const key of ["V", "W", "E", "H", "M"]) expect(html).toContain(`<kbd>${key}</kbd>`);
  expect(html).toContain('aria-label="Fit plan to view"');
  expect(html).toContain('class="building-model-statusbar"');
});

test("projects with several PDFs expose an exact source selector", () => {
  const model = {
    ...wallReviewFixture,
    states: { ...wallReviewFixture.states, existing: [{ id: "report-room", kind: "room", label: "Report-linked room", page: 1, sourceVersionId: "version-2", storeyId: "report-storey", box: { x: .1, y: .1, width: .2, height: .2 } }] },
    planSources: [
      { id: "plan", storeyId: "storey-1", page: 3, source: { versionId: "version-1", fileId: "plan", fileName: "Architecture plan.pdf", version: 1 } },
      { id: "report", storeyId: "report-storey", page: 1, source: { versionId: "version-2", fileId: "report", fileName: "Acoustic calculation.pdf", version: 1 } },
    ],
    automaticPlanProcessing: [
      { fileId: "plan", fileName: "Architecture plan.pdf", sourceVersionId: "version-1", status: "complete", floorPlanPages: [3], nonFloorPlanPages: [], unresolvedPages: [] },
      { fileId: "report", fileName: "Acoustic calculation.pdf", sourceVersionId: "version-2", status: "partial", floorPlanPages: [], nonFloorPlanPages: [{ page: 1 }], unresolvedPages: [] },
    ],
  };
  const html = render(model, "?view=building-model&page=3&sourceVersion=version-1&storey=storey-1");
  expect(html).toContain('aria-label="Source PDF"');
  expect(html).toContain("Architecture plan.pdf");
  expect(html).toContain("Acoustic calculation.pdf");

  const legacyAutomatic = render(model, "?view=building-model&page=1&sourceVersion=version-2");
  expect(legacyAutomatic).toContain('<option value="version-1" selected="">Architecture plan.pdf</option>');
  const deliberatelyPinned = render(model, "?view=building-model&page=1&sourceVersion=version-2&sourceSelection=manual");
  expect(deliberatelyPinned).toContain('<option value="version-2" selected="">Acoustic calculation.pdf</option>');
});

test("Proposed review count excludes demolished wall hypotheses that its destination cannot reveal", () => {
  const demolished = { ...wallReviewFixture.extractionCandidates[0]!, id: "demolished-wall", name: "Demolished wall hypothesis", constructionState: "demolished" };
  const mixed = { ...wallReviewFixture, extractionCandidates: [...wallReviewFixture.extractionCandidates, demolished] };
  const search = "?view=building-model&page=3&sourceVersion=version-1&storey=storey-1&modelState=";
  const html = render(mixed, `${search}existing`);
  expect(html).toContain("1 wall hypotheses hidden by this model state");
  expect(html).not.toContain("2 wall hypotheses hidden by this model state");
  expect(html).not.toContain("demolished-wall");
  expect(render(mixed, `${search}proposed`)).not.toContain("Demolished wall hypothesis");
  const onlyDemolished = render({ ...wallReviewFixture, extractionCandidates: [demolished] }, `${search}existing`);
  expect(onlyDemolished).not.toContain("wall hypotheses hidden by this model state");
  expect(onlyDemolished).not.toContain("Review wall hypotheses");
});

test("Proposed exposes a dedicated wall hypothesis toggle and scoped toggleable overlays", () => {
  const html = render(wallReviewFixture, "?view=building-model&page=3&sourceVersion=version-1&storey=storey-1&modelState=proposed");
  // Overlay categories are outliner rows with an eye toggle; wall hypotheses are shown by default.
  expect(html).toContain('aria-pressed="true" aria-label="Hide: Wall hypotheses"');
  expect(html).toContain("Wall hypothesis visible-source");
  expect(html).not.toContain("Wall hypothesis other-");
  expect(html).not.toContain("wall hypotheses hidden by this model state");
  const candidates = candidatesForModelState(adaptBuildingModel(wallReviewFixture).extractionCandidates, "proposed");
  expect(candidateOverlaysForSource(candidates, 3, "version-1", "storey-1", { draftWalls: true }).map((candidate) => candidate.candidateId)).toEqual(["visible-source"]);
  expect(candidateOverlaysForSource(candidates, 3, "version-1", "storey-1", { draftWalls: false })).toEqual([]);
  expect(candidatesForModelState(candidates.map((candidate) => ({ ...candidate, constructionState: "demolished" })), "existing")).toEqual([]);
});

test("wall and assembly inspectors distinguish inferred phase and source geometry from physical properties", () => {
  const wall = adaptBuildingModel(wallReviewFixture).extractionCandidates[0]!;
  for (const candidateRole of ["draft-wall", "construction-assembly"] as const) {
    const html = renderToStaticMarkup(<CandidateInspector candidate={{ ...wall, candidateRole, wallThickness: 0.42, material: "Unverified concrete" }} regions={[]} t={(key) => en[key]} pending={false} onPage={() => undefined} onReview={() => undefined} />);
    expect(html).toContain('Wall thickness</dt><dd class="building-model-unknown">Unknown');
    expect(html).toContain('Material</dt><dd class="building-model-unknown">Unknown');
    expect(html).not.toContain("Unverified concrete");
    expect(html).toContain("Unreviewed source-layer inference");
    expect(html).toContain("Source-relative minor dimension ratio (not physical thickness)");
    expect(html).toContain("1.000%");
    expect(html).toContain("Geometry evidence tier (unreviewed)");
    expect(html).toContain("medium");
  }
});

/** The Plan context popover content (extraction status and PDF page coverage) for one page. */
function renderPlanContext(raw: unknown, page: number) {
  const model = adaptBuildingModel(raw);
  const t = (key: keyof typeof en) => en[key];
  const job = model.extractions.find((item) => item.page === page);
  return renderToStaticMarkup(<MemoryRouter>
    <ExtractionPanel job={job} coverage={job?.result?.coverage ? { note: job.result.coverage } : model.extractionCoverage} source={model.planSources.find((source) => source.page === page)} storeys={model.storeys} selectedStoreyId="" onStorey={() => undefined} canStart pending={false} onStart={() => undefined} t={t} />
    {model.automaticPlanProcessing.length > 0 && <AutomaticPlanCoverage processing={model.automaticPlanProcessing} sources={model.planSources} storeys={model.storeys} selectedPage={page} onPage={() => undefined} superseded={model.supersededSources} onSupersede={() => undefined} onRestore={() => undefined} t={t} />}
  </MemoryRouter>);
}

function render(model: unknown, search = "?view=building-model") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData([`/projects/${projectId}/building-model`], model);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/projects/${projectId}${search}`]}>
        <BuildingModelMode projectId={projectId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("building model keeps source evidence distinct from stable model object identity", () => {
  const html = render({
    revision: 4,
    reviewStatus: "needs-review",
    evidence: {
      fileName: "Grundriss Bestand.pdf",
      fileId: "source-file",
      version: 2,
      pageCount: 3,
      layers: [{ id: "92", label: "Räume", visible: true }],
    },
    states: {
      existing: [{
        id: "room-101",
        kind: "room",
        label: "Wohnzimmer",
        page: 3,
        evidence: [{ label: "Use", value: "Living room", page: 3, layerId: "92", source: "source-stated" }],
        measurements: [{ key: "width", label: "Width", sourceValue: 4.2, calibratedValue: 4.25, unit: "m", uncertainty: { plusMinus: 0.05, unit: "m" }, sourcePage: 3 }],
      }, { id: "unknown-1", kind: "unknown-room", label: "Unresolved room", page: 3 }],
      demolition: [],
      proposed: [],
    },
    planSources: [{ id: "plan-3", page: 3, layers: [{ id: "92", name: "Räume", defaultVisible: true }], source: { fileId: "source-file", fileName: "Grundriss Bestand.pdf", versionId: "source-version", version: 2, downloadUrl: "/api/projects/p/files/source-file/versions/2/download" } }],
  });
  expect(html).toContain("Grundriss Bestand.pdf");
  expect(html).toContain("Wohnzimmer");
  expect(html).toContain("Unresolved room");
  expect(html).toContain("Source-stated");
  expect(html).toContain("Calibrated");
  expect(html).toContain("± 0.05 m");
  expect(html).toContain("Räume");
  expect(html).toContain("room-101");
  expect(html).not.toContain("<small>room-101</small>");
  expect(html).toContain("Review proposals in the project workspace");
  expect(html).toContain('aria-label="Hide: Räume"');
});
test("plan viewer exposes fit, zoom and pan affordances while keeping one transformed overlay surface", () => {
  const html = renderToStaticMarkup(<PdfEvidenceRenderer
    projectId={projectId}
    evidence={{ fileName: "Plan.pdf", pageCount: 3 }}
    page={3}
    regions={[{ id: "room-1", kind: "room", label: "Room", page: 3, box: { x: .1, y: .2, width: .3, height: .2 } }]}
    layerVisibility={{}}
    selectedId="room-1"
    onLayers={() => undefined}
    onSelect={() => undefined}
    labels={{ empty: "No PDF", loading: "Loading", region: "Regions", zoom: "Plan view controls", zoomIn: "Zoom in", zoomOut: "Zoom out", fit: "Fit plan to view" }}
  />);
  expect(html).toContain("Plan view controls");
  expect(html).toContain("Zoom in");
  expect(html).toContain("Fit plan to view");
  expect(html).toContain("building-model-plan-surface");
  expect(html).toContain("building-model-region-layer");
  expect(html).toContain("building-model-region-hit-area");
  expect(html).toContain("building-model-region-layer has-selection");
});

test("plan overlays counter-scale interaction affordances without changing source geometry", () => {
  expect(overlayInteractionStyle(1)).toMatchObject({
    "--building-model-overlay-inverse-scale": 1,
    "--building-model-overlay-hit-size": "16px",
    "--building-model-overlay-label-gap": "3px",
  });
  expect(overlayInteractionStyle(4)).toMatchObject({
    "--building-model-overlay-inverse-scale": .25,
    "--building-model-overlay-hit-size": "4px",
    "--building-model-overlay-label-gap": "0.75px",
    "--building-model-overlay-stroke": "0.25px",
  });
  expect(overlayInteractionStyle(Number.NaN)["--building-model-overlay-inverse-scale"]).toBe(1);
});

test("overlapping overlay hit areas resolve to the exact wall geometry instead of DOM order", () => {
  const wall31 = {
    id: "wall-31", kind: "element" as const, label: "Draft wall 31", page: 2,
    box: { x: .355, y: .411, width: .052, height: .002 },
    polygon: [{ x: .355, y: .411 }, { x: .407, y: .411 }, { x: .407, y: .413 }, { x: .355, y: .413 }],
  };
  const wall112 = {
    id: "wall-112", kind: "element" as const, label: "Draft wall 112", page: 2,
    box: { x: .38, y: .417, width: .003, height: .03 },
    polygon: [{ x: .38, y: .417 }, { x: .383, y: .417 }, { x: .383, y: .447 }, { x: .38, y: .447 }],
  };
  const wall31Center = { x: wall31.box.x + wall31.box.width / 2, y: wall31.box.y + wall31.box.height / 2 };
  expect(overlayRegionAtPoint([wall31, wall112], wall31Center, { width: 640, height: 420 })?.id).toBe("wall-31");
  expect(overlayRegionAtPoint([wall112, wall31], wall31Center, { width: 1440, height: 945 })?.id).toBe("wall-31");
});

test("overlay hit arbitration uses nearest screen geometry and a stable smaller-area tie break", () => {
  const large = { id: "large", kind: "element" as const, label: "Large", page: 1, box: { x: .2, y: .2, width: .08, height: .04 } };
  const small = { id: "small", kind: "element" as const, label: "Small", page: 1, box: { x: .2, y: .2, width: .02, height: .01 } };
  expect(overlayRegionAtPoint([large, small], { x: .205, y: .205 }, { width: 1000, height: 1000 })?.id).toBe("small");
  expect(overlayRegionAtPoint([large], { x: .285, y: .22 }, { width: 1000, height: 1000 })?.id).toBe("large");
  expect(overlayRegionAtPoint([large], { x: .30, y: .22 }, { width: 1000, height: 1000 })).toBeUndefined();
});

test("an off-page or stale selection does not dim the visible plan overlays", () => {
  const html = renderToStaticMarkup(<PdfEvidenceRenderer
    projectId={projectId}
    evidence={{ fileName: "Plan.pdf", pageCount: 3 }}
    page={3}
    selectedId="region-on-another-page"
    regions={[{ id: "room-1", kind: "room", label: "Room", page: 3, box: { x: .1, y: .2, width: .3, height: .2 } }]}
    layerVisibility={{}}
    onLayers={() => undefined}
    onSelect={() => undefined}
    labels={{ empty: "No PDF", loading: "Loading", region: "Regions", zoom: "Controls", zoomIn: "In", zoomOut: "Out", fit: "Fit" }}
  />);
  expect(html).toContain('class="building-model-region-layer"');
  expect(html).not.toContain("building-model-region-layer has-selection");
});

test("clipboard denial resolves calmly without an unhandled rejection", async () => {
  const copied = await copyStableObjectId("room-1", { writeText: async () => { throw new Error("permission denied"); } });
  expect(copied).toBe(false);
});

test("empty backend payload remains an explicit empty model instead of crashing the project view", () => {
  const html = render(undefined);
  expect(html).toContain("Preparing the building model");
  expect(html).toContain("Checking project PDF uploads");
  expect(html).not.toContain("Manual source setup");
});

test("automatic upload processing replaces setup as the primary durable state", () => {
  const html = render({
    model: { id: "model-automatic", revision: 1 }, rooms: [], elements: [], storeys: [], planSources: [],
    properties: [], measurements: [], proposals: [], conflicts: [], revisions: [], extractions: [], extractionCandidates: [],
    automaticPlanProcessing: [{ fileId: "file-1", fileName: "Uploaded plan.pdf", sourceVersionId: "version-1", status: "classifying_pages", currentPhase: "identifying_floors", inference: { provider: "typesafe", active: false, configured: null }, renderableSource: { downloadUrl: "/api/projects/p/files/file-1/versions/1/download", mimeType: "application/pdf" }, pageCount: 9, registeredPageCount: 0, floorPlanPages: [], nonFloorPlanPages: [], unresolvedPages: [], reason: "Page classification is running." }],
  });
  expect(html).toContain("Preparing the building model");
  expect(html).toContain("Identifying floor-plan pages");
  expect(html).toContain("Processing continues as a saved job after navigation or reload.");
  expect(html).not.toContain("Manual source setup");
  expect(automaticProcessingActive("extracting")).toBe(true);
  expect(automaticProcessingActive("complete")).toBe(false);
});

test("automatic preparation previews a detected floor plan instead of the first report", () => {
  const report = { fileId: "report", fileName: "DIN 4109 Calculation.pdf", sourceVersionId: "report-version", status: "partial", floorPlanPages: [], nonFloorPlanPages: [{ page: 1 }], unresolvedPages: [2] };
  const plan = { fileId: "plan", fileName: "Architecture plan.pdf", sourceVersionId: "plan-version", status: "extracting", floorPlanPages: [3], nonFloorPlanPages: [], unresolvedPages: [] };
  expect(preferredAutomaticProcessing([report, plan])?.sourceVersionId).toBe("plan-version");
});

test("provider wording appears only for an actually active configured inference stage", () => {
  const base = { model: { id: "model-automatic", revision: 1 }, rooms: [], elements: [], storeys: [], planSources: [], properties: [], measurements: [], proposals: [], conflicts: [], revisions: [], extractions: [], extractionCandidates: [] };
  const deterministic = render({ ...base, automaticPlanProcessing: [{ fileName: "Plan.pdf", sourceVersionId: "v", status: "extracting", currentPhase: "extracting_geometry", inference: { provider: "typesafe", active: false, configured: true }, floorPlanPages: [1], nonFloorPlanPages: [], unresolvedPages: [] }] });
  expect(deterministic).toContain("Extracting rooms and construction geometry");
  expect(deterministic).not.toContain("configured TypeSafe inference");
  const inferred = render({ ...base, automaticPlanProcessing: [{ fileName: "Plan.pdf", sourceVersionId: "v", status: "extracting", currentPhase: "preparing_draft", inference: { provider: "typesafe", active: true, configured: true }, floorPlanPages: [1], nonFloorPlanPages: [], unresolvedPages: [] }] });
  expect(inferred).toContain("Classifying room labels with configured TypeSafe inference");
});

test("automatic page coverage distinguishes floor, non-plan, and unresolved pages without claiming walls", () => {
  const automatic = { fileId: "file-1", fileName: "Plan packet.pdf", sourceVersionId: "version-1", status: "complete", pageCount: 3, registeredPageCount: 3, floorPlanPages: [1], nonFloorPlanPages: [{ page: 2, pageType: "elevation", confidence: .94 }], unresolvedPages: [3], reason: "One floor-plan page produced unreviewed draft geometry.", jobStatuses: { complete: 1 } };
  const coverageModel = {
    model: { id: "model-1", revision: 2 }, rooms: [], elements: [], properties: [], measurements: [], proposals: [], conflicts: [], revisions: [],
    storeys: [{ id: "storey-1", name: "Plan page 1 (draft)" }],
    planSources: [1, 2, 3].map((page) => ({ id: `plan-${page}`, storeyId: page === 1 ? "storey-1" : null, page, pageCount: 3, source: { fileId: "file-1", fileName: "Plan packet.pdf", versionId: "version-1", version: 1, downloadUrl: "/api/projects/p/files/file-1/versions/1/download" } })),
    extractions: [{ id: "job-1", sourceVersionId: "version-1", storeyId: "storey-1", page: 1, status: "complete", result: { candidateCount: 2, roomHypothesisCount: 1, constructionAssemblyCount: 1, phase: "complete", geometryExtraction: { limitations: "Observed source construction; not a verified wall." } } }],
    extractionCandidates: [
      { id: "room-1", jobId: "job-1", sourceVersionId: "version-1", storeyId: "storey-1", page: 1, entityType: "room", name: "Room draft", groupLabel: "WE 1", status: "unreviewed", geometry: { quality: "approximate_partition", planRegion: { x: .1, y: .1, width: .3, height: .3 }, polygon: [{ x: .1, y: .1 }, { x: .4, y: .1 }, { x: .4, y: .4 }, { x: .1, y: .4 }] } },
      { id: "assembly-1", jobId: "job-1", sourceVersionId: "version-1", storeyId: "storey-1", page: 1, entityType: "element", name: "Construction assembly", groupLabel: "WE 1", status: "unreviewed", geometry: { quality: "assembly", planRegion: { x: .2, y: .2, width: .1, height: .1 }, polygons: [[{ x: .2, y: .2 }, { x: .3, y: .2 }, { x: .3, y: .3 }, { x: .2, y: .3 }]], limitations: "Observed source construction; not a verified wall." } },
    ],
    automaticPlanProcessing: [automatic],
    supersededSources: [{ sourceVersionId: "version-0", fileName: "Old plans.pdf", supersededByVersionId: "version-1" }],
  };
  const html = render(coverageModel, "?view=building-model&page=1") + renderPlanContext(coverageModel, 1);
  expect(html).toContain("PDF page coverage");
  // A replaced plan set is listed for restore; superseding needs a second active plan set to choose.
  expect(html).toContain("Old plans.pdf");
  expect(html).toContain("Superseded by Plan packet.pdf");
  expect(html).toContain("Restore plan set");
  expect(html).not.toContain("Mark plan set superseded");
  expect(html).toContain("Floor plan detected");
  expect(html).toContain("Non-floor-plan page · elevation");
  expect(html).toContain("Unresolved page");
  expect(html).toContain("Construction assemblies");
  expect(html).not.toContain("building-model-region element candidate assembly");
  expect(html).toContain("not a verified wall");
  expect(html).not.toContain("Walls detected");
  expect(automaticPageDisposition(automatic, 1)).toBe("floor_plan");
  expect(automaticPageDisposition(automatic, 2)).toBe("non_floor_plan");
  expect(automaticPageDisposition(automatic, 3)).toBe("unresolved");
});

test("source group filtering constrains the rendered overlay candidates", () => {
  const candidates = [
    { id: "candidate:a", isCandidate: true as const, status: "unreviewed" as const, kind: "room" as const, entityType: "room" as const, label: "A", groupLabel: "WE 1", page: 1, storeyId: "storey-1", sourceVersionId: "version-1" },
    { id: "candidate:b", isCandidate: true as const, status: "unreviewed" as const, kind: "room" as const, entityType: "room" as const, label: "B", groupLabel: "WE 2", page: 1, storeyId: "storey-1", sourceVersionId: "version-1" },
  ];
  const filtered = candidatesForGroup(candidates, "WE 2");
  expect(filtered.map((candidate) => candidate.label)).toEqual(["B"]);
  expect(candidateOverlaysForSource(filtered, 1, "version-1", "storey-1", { roomHypotheses: true })).toHaveLength(1);
});

test("bootstrap exposes real uploaded revision and exact source page workflow", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><BuildingModelBootstrap
    projectId={projectId}
    modelRevision={0}
    files={[{ id: "file-1", name: "Plan.pdf", mimeType: "application/pdf" }]}
    fileId="file-1"
    onFileId={() => undefined}
    versions={[{ id: "version-1", version: 2, status: "ready" }]}
    filesLoading={false}
    onComplete={async () => undefined}
    t={(key) => ({
      buildingModelSection: "Building model",
      buildingModelBootstrapTitle: "Set up the first plan source",
      buildingModelBootstrapDescription: "Choose an uploaded PDF revision",
      buildingModelBootstrapStatus: "Needs setup",
      buildingModelBootstrapPdf: "Uploaded PDF",
      buildingModelBootstrapPdfHint: "Only project files already uploaded are listed.",
      buildingModelBootstrapRevision: "PDF revision",
      buildingModelBootstrapRevisionHint: "ready revision",
      buildingModelBootstrapPage: "Source page",
      buildingModelBootstrapPageHint: "exact PDF",
      buildingModelBootstrapBuilding: "Building name",
      buildingModelBootstrapBuildingKey: "Building stable key",
      buildingModelBootstrapStorey: "Storey name",
      buildingModelBootstrapStoreyKey: "Storey stable key",
      buildingModelBootstrapKeyHint: "generated",
      buildingModelBootstrapLevel: "Level index",
      buildingModelBootstrapLevelHint: "ground",
      buildingModelLoadingSources: "Loading",
      buildingModelChoosePdf: "Choose a project PDF",
      buildingModelChooseRevision: "Choose a ready revision",
      buildingModelVersion: "Revision",
      buildingModelBootstrapEvidenceNote: "The PDF revision and page stay attached as source evidence.",
      buildingModelBootstrapCreate: "Create building workspace",
      buildingModelBootstrapCreateAndExtract: "Create model and extract plan",
      buildingModelBootstrapCreating: "Creating workspace",
      buildingModelBootstrapBuildingError: "building error",
      buildingModelBootstrapStoreyError: "storey error",
    } as Record<string, string>)[String(key)] || String(key)}
  /></QueryClientProvider>);
  expect(html).toContain("Plan.pdf");
  expect(html).toContain("Revision 2");
  expect(html).toContain("Source page");
  expect(html).toContain("Create model and extract plan");
  expect(html).toContain('value="1"');
  expect(html).not.toContain('value="3"');
});

test("adapter renders the projects app model contract and derives demolition and proposed states", () => {
  const html = render({
    model: { id: "model-1", revision: 6 },
    buildings: [],
    storeys: [],
    rooms: [
      { id: "room-existing", name: "Existing room", constructionState: "retained", roomUse: "Office" },
      { id: "room-demolished", name: "Removed room", constructionState: "demolished" },
      { id: "room-proposed", name: "New room", constructionState: "proposed", roomUse: "Kitchen" },
    ],
    elements: [{ id: "wall-1", name: "Wall", constructionState: "retained" }],
    properties: [], measurements: [], proposals: [{ status: "pending" }], conflicts: [], revisions: [],
    planSources: [{ id: "plan-1", page: 1, source: { fileId: "f", fileName: "Plan.pdf", versionId: "v", version: 1, downloadUrl: "/api/projects/p/files/f/versions/1/download" } }],
  });
  expect(html).toContain("Existing room");
  expect(html).toContain("room-existing");
  expect(html).toContain("Needs review");
  expect(html).not.toContain("Removed room");
});

test("final response keeps linked plan page 3 exact and retained identity across state views", () => {
  const response = { model: { id: "model-1", revision: 7 }, rooms: [{ id: "room-retained", name: "Retained room", storeyId: "storey-1", constructionState: "retained", roomUse: "Office", planRegion: { x: .1, y: .2, width: .3, height: .2 } }], elements: [], properties: [], measurements: [], proposals: [], conflicts: [], revisions: [], planSources: [{ id: "plan-3", storeyId: "storey-1", page: 3, pageCount: 3, layers: [{ id: "ocg-92", name: "Räume" }], source: { fileId: "f", fileName: "Plan.pdf", versionId: "v", version: 2, downloadUrl: "/api/projects/p/files/f/versions/2/download" } }] };
  const existing = render(response);
  const demolition = render(response, "?view=building-model&modelState=demolition");
  const proposed = render(response, "?view=building-model&modelState=proposed");
  for (const html of [existing, demolition, proposed]) { expect(html).toContain("room-retained"); expect(html).toContain("Räume"); expect(html).toContain("Plan.pdf"); }
  const adapted = adaptBuildingModel(response);
  expect(adapted.planSources[0]?.source?.fileName).toBe("Plan.pdf");
  expect(adapted.states.existing[0]?.page).toBe(3);
});

test("new geometry keeps normalized plan region and exact source page metadata", () => {
  const adapted = adaptBuildingModel({
    model: { id: "model-1", revision: 2 },
    buildings: [],
    storeys: [{ id: "storey-1", name: "Ground" }],
    rooms: [{ id: "room-new", name: "New room", storeyId: "storey-1", planRegion: { x: .1, y: .2, width: .3, height: .4 }, geometry: { planRegion: { x: .1, y: .2, width: .3, height: .4 }, source: { sourceVersionId: "version-1", page: 3 } } }],
    elements: [], properties: [], measurements: [], planSources: [], proposals: [], conflicts: [], revisions: [],
  });
  expect(adapted.states.existing[0]?.box).toEqual({ x: .1, y: .2, width: .3, height: .4 });
  expect(adapted.states.existing[0]?.page).toBe(3);
  expect(adapted.states.existing[0]?.evidence?.[0]?.value).toBe("version-1");
});

test("extraction candidates stay spatially unreviewed and distinguish anchor geometry", () => {
  const raw = {
    model: { id: "model-1", revision: 8 },
    storeys: [{ id: "storey-1", name: "Ground" }],
    rooms: [], elements: [], properties: [], measurements: [], proposals: [], conflicts: [], revisions: [],
    planSources: [{ id: "plan-1", storeyId: "storey-1", page: 3, source: { fileId: "f", fileName: "Plan.pdf", versionId: "v", version: 2, downloadUrl: "/api/projects/p/files/f/versions/2/download" } }],
    extractions: [{ id: "job-1", sourceVersionId: "v", storeyId: "storey-1", page: 3, status: "complete", result: { method: "native_text", coverage: "selected_page_labels_and_construction_footprints", geometryQuality: "mixed", candidateCount: 326, roomAnchorCount: 91, elementFootprintCount: 235, geometryExtraction: { status: "complete", retainedFootprints: 235, limitations: "Observed construction-layer paths are not verified walls or room boundaries." }, reason: "Room boundaries, materials, construction state and completeness are not established." } }],
    extractionCandidates: [{ id: "candidate-1", jobId: "job-1", sourceKey: "room-a", entityType: "room", name: "Room A", geometry: { quality: "anchor", coordinateSpace: "normalized-page", planRegion: { x: .1, y: .2, width: .02, height: .02 } }, evidence: [{ kind: "page", sourceVersionId: "v", page: 3, region: { x: .1, y: .2, width: .02, height: .02 }, quote: "Room A" }], status: "unreviewed", targetEntityId: null }],
  };
  const workbench = render(raw, "?view=building-model&page=3");
  const html = renderPlanContext(raw, 3);
  expect(html).toContain("Plan extraction");
  expect(html).toContain("Extraction complete");
  expect(html).toContain("<strong>1</strong><small>Pages covered</small>");
  expect(html).toContain("<strong>91</strong><small>Room anchors</small>");
  expect(html).toContain("<strong>235</strong><small>Construction footprints</small>");
  expect(html).toContain("<strong>326</strong><small>Total candidates</small>");
  expect(html).toContain("Observed construction-layer paths are not verified walls or room boundaries.");
  expect(html).toContain("Room boundaries, materials, construction state and completeness are not established.");
  expect(html).not.toContain("Objects identified");
  expect(html).not.toContain("<small>Unresolved</small>");
  expect(html).toContain("Construction footprints");
  // The label-only anchor is listed for review but its overlay category starts hidden.
  expect(workbench).toContain("Room A");
  expect(workbench).toContain('aria-pressed="false" aria-label="Show: Room A"');
  expect(workbench).toContain("Plan context: Extraction complete");
  expect(workbench).not.toContain("This is an extraction candidate, not an approved model object");
  const adapted = adaptBuildingModel({
    extractions: [{ id: "job-1", sourceVersionId: "v", storeyId: "storey-1", page: 3, status: "complete", result: { geometryQuality: "anchor" } }],
    extractionCandidates: [{ id: "candidate-1", jobId: "job-1", name: "Room A", entityType: "room", geometry: { quality: "anchor", planRegion: { x: .1, y: .2, width: .02, height: .02 } }, status: "unreviewed" }],
  });
  expect(adapted.extractionCandidates[0]?.geometryQuality).toBe("anchor");
});

test("footprint candidates retain exact polygon, layer evidence, and independent overlay visibility", () => {
  const adapted = adaptBuildingModel({
    extractions: [{ id: "job-1", sourceVersionId: "version-1", storeyId: "storey-1", page: 3, status: "complete" }],
    extractionCandidates: [{
      id: "candidate-footprint", jobId: "job-1", sourceVersionId: "version-1", storeyId: "storey-1", page: 3, entityType: "element", name: "Construction footprint 212", status: "unreviewed",
      geometry: {
        quality: "footprint", coordinateSpace: "normalized-page", planRegion: { x: .35152, y: .24457, width: .00438, height: .05969 },
        polygon: [{ x: .35152, y: .24457 }, { x: .3559, y: .24457 }, { x: .3542, y: .275 }, { x: .352, y: .30426 }],
        parts: [
          { planRegion: { x: .35152, y: .24457, width: .00438, height: .025 }, polygon: [{ x: .35152, y: .24457 }, { x: .3559, y: .24457 }, { x: .3542, y: .26957 }, { x: .352, y: .26957 }] },
          { planRegion: { x: .352, y: .275, width: .0039, height: .02926 }, polygon: [{ x: .352, y: .275 }, { x: .3559, y: .275 }, { x: .354, y: .30426 }, { x: .352, y: .30426 }] },
        ],
        layerId: "ocg-konstruktion", layerName: "Konstruktion", limitations: "Observed closed filled source path; not a verified wall or room boundary.",
      },
      evidence: [{ kind: "page", sourceVersionId: "version-1", page: 3, region: { x: .35152, y: .24457, width: .00438, height: .05969 }, quote: "Closed filled source path", layerId: "ocg-konstruktion", layerName: "Konstruktion" }],
    }],
  });
  const candidate = adapted.extractionCandidates[0];
  expect(candidate?.geometryQuality).toBe("footprint");
  expect(candidate?.polygon).toHaveLength(4);
  expect(candidate?.parts).toHaveLength(2);
  expect(partOverlayStyle(candidate!.parts![0]!, candidate!.box)).toMatchObject({ left: "0%", top: "0%" });
  expect(candidate?.layerId).toBe("ocg-konstruktion");
  expect(candidate?.layerName).toBe("Konstruktion");
  expect(candidate?.geometryLimitations).toContain("not a verified wall");
  expect(polygonClipPath(candidate!)).toBe("polygon(0.00% 0.00%, 100.00% 0.00%, 61.19% 50.98%, 10.96% 100.00%)");
  const all = adapted.extractionCandidates;
  expect(candidateOverlaysForSource(all, 3, "version-1", "storey-1", { roomAnchors: true, footprints: false })).toHaveLength(0);
  expect(candidateOverlaysForSource(all, 3, "version-1", "storey-1", { roomAnchors: true, footprints: true })).toHaveLength(1);
});

test("draft walls require explicit semantics and remain distinct from construction fragments and partition seams", () => {
  const adapted = adaptBuildingModel({
    extractions: [{ id: "job-1", sourceVersionId: "version-1", storeyId: "storey-1", page: 3, status: "complete" }],
    extractionCandidates: [
      { id: "wall-1", jobId: "job-1", entityType: "element", name: "Draft wall 1", status: "unreviewed", geometry: { quality: "draft_wall", semanticKind: "draft_wall", planRegion: { x: .2, y: .2, width: .01, height: .3 }, polygon: [{ x: .2, y: .2 }, { x: .21, y: .2 }, { x: .21, y: .5 }, { x: .2, y: .5 }], sourceFootprintKeys: ["footprint:42"], classification: { method: "elongated_rectangular_construction_fill", sourcePolygonExact: true }, limitations: "Wall identity is unreviewed." }, evidence: [{ kind: "page", sourceVersionId: "version-1", page: 3, layerId: "ocg-wall", layerName: "Construction" }] },
      { id: "fragment-1", jobId: "job-1", entityType: "element", name: "Construction fragment", status: "unreviewed", geometry: { quality: "construction_fragment_assembly", semanticKind: "construction_fragment", planRegion: { x: .3, y: .2, width: .1, height: .1 }, polygons: [[{ x: .3, y: .2 }, { x: .4, y: .2 }, { x: .4, y: .3 }, { x: .3, y: .3 }]] } },
      { id: "partition-1", jobId: "job-1", entityType: "room", name: "Room partition", status: "unreviewed", geometry: { quality: "approximate_partition", semanticKind: "partition_seam", planRegion: { x: .4, y: .2, width: .2, height: .2 } } },
    ],
  });
  const [wall, fragment, partition] = adapted.extractionCandidates;
  expect(wall).toMatchObject({ candidateRole: "draft-wall", sourceVersionId: "version-1", page: 3, storeyId: "storey-1", sourceFootprintKeys: ["footprint:42"], wallThickness: null, material: null, sourceScale: null });
  expect(wall?.classification).toMatchObject({ method: "elongated_rectangular_construction_fill", sourcePolygonExact: true });
  expect(fragment?.candidateRole).toBe("construction-assembly");
  expect(partition?.candidateRole).toBe("room-region");
  expect(candidateRole({ entityType: "element", geometryQuality: "assembly", semanticType: "partition_seam" })).not.toBe("draft-wall");
  expect(candidateOverlaysForSource(adapted.extractionCandidates, 3, "version-1", "storey-1", { draftWalls: true, assemblies: false, roomHypotheses: false })).toEqual([wall!]);
});

test("draft wall polygons render with a dedicated overlay class and no semantic claim for fragments", () => {
  const regions = adaptBuildingModel({ extractionCandidates: [
    { id: "wall-1", entityType: "element", name: "Draft wall 1", status: "unreviewed", sourceVersionId: "v", storeyId: "s", page: 3, geometry: { quality: "draft_wall", semanticKind: "draft_wall", planRegion: { x: .2, y: .2, width: .01, height: .3 }, polygon: [{ x: .2, y: .2 }, { x: .21, y: .2 }, { x: .21, y: .5 }, { x: .2, y: .5 }] } },
    { id: "fragment-1", entityType: "element", name: "Construction fragment", status: "unreviewed", sourceVersionId: "v", storeyId: "s", page: 3, geometry: { quality: "construction_fragment_assembly", semanticKind: "construction_fragment", planRegion: { x: .3, y: .2, width: .1, height: .1 }, polygons: [[{ x: .3, y: .2 }, { x: .4, y: .2 }, { x: .4, y: .3 }, { x: .3, y: .3 }]] } },
  ] }).extractionCandidates;
  const html = renderToStaticMarkup(<PdfEvidenceRenderer projectId={projectId} evidence={{ fileName: "Plan.pdf", pageCount: 3 }} page={3} regions={regions} layerVisibility={{}} onLayers={() => undefined} onSelect={() => undefined} labels={{ empty: "No PDF", loading: "Loading", region: "Regions", zoom: "Controls", zoomIn: "In", zoomOut: "Out", fit: "Fit" }} />);
  expect(html).toContain("candidate draft-wall");
  expect(html).toContain("candidate assembly");
  expect(html).toContain("Draft wall 1 · draft-wall");
  expect(html).toContain("Construction fragment · construction-assembly");
});

test("room candidates draw their extracted outline with holes, not their bounding box", () => {
  // L-shaped room in the box (.2,.2)–(.4,.4) with a square hole; the outline path, not the box, carries the color.
  const regions = adaptBuildingModel({ extractionCandidates: [
    { id: "room-1", entityType: "room", name: "Wohnen", status: "unreviewed", sourceVersionId: "v", storeyId: "s", page: 3, geometry: { quality: "enclosed_region", planRegion: { x: .2, y: .2, width: .2, height: .2 },
      polygon: [{ x: .2, y: .2 }, { x: .4, y: .2 }, { x: .4, y: .3 }, { x: .3, y: .3 }, { x: .3, y: .4 }, { x: .2, y: .4 }], holes: [[{ x: .22, y: .22 }, { x: .24, y: .22 }, { x: .24, y: .24 }, { x: .22, y: .24 }]] } },
  ] }).extractionCandidates;
  expect(regions[0]?.holes).toHaveLength(1);
  const html = renderToStaticMarkup(<PdfEvidenceRenderer projectId={projectId} evidence={{ fileName: "Plan.pdf", pageCount: 3 }} page={3} regions={regions} layerVisibility={{}} onLayers={() => undefined} onSelect={() => undefined} labels={{ empty: "No PDF", loading: "Loading", region: "Regions", zoom: "Controls", zoomIn: "In", zoomOut: "Out", fit: "Fit" }} />);
  expect(html).toContain("has-outline");
  expect(html).toContain('d="M0.000 0.000L100.000 0.000L100.000 50.000L50.000 50.000L50.000 100.000L0.000 100.000ZM10.000 10.000L20.000 10.000L20.000 20.000L10.000 20.000Z"');
  expect(html).toContain('fill-rule="evenodd"');
});

test("semantic extraction coverage names hypotheses, unresolved anchors, assemblies, and source-area observations", () => {
  const raw = {
    model: { id: "model-1", revision: 4 }, storeys: [{ id: "storey-1", name: "Ground" }], rooms: [], elements: [], properties: [], measurements: [], proposals: [], conflicts: [], revisions: [],
    planSources: [{ id: "plan-1", storeyId: "storey-1", page: 3, source: { fileId: "f", fileName: "Plan.pdf", versionId: "version-1", version: 1, downloadUrl: "/api/projects/p/files/f/versions/1/download" } }],
    extractions: [{ id: "job-1", sourceVersionId: "version-1", storeyId: "storey-1", page: 3, status: "complete", result: { candidateCount: 163, roomAnchorCount: 15, elementFootprintCount: 235, draftWallCount: 41, constructionFragmentCount: 72, topologyCoverage: { approximateRegionCount: 76, unresolvedRegionCount: 15, wallCount: 41, fragmentAssemblyCount: 72, sourceFootprintCount: 235, printedAreaCount: 90 } } }],
    extractionCandidates: [{ id: "candidate-partition", jobId: "job-1", sourceVersionId: "version-1", storeyId: "storey-1", page: 3, entityType: "room", name: "Living", status: "unreviewed", geometry: { quality: "approximate_partition", planRegion: { x: .1, y: .1, width: .2, height: .2 }, polygon: [{ x: .1, y: .1 }, { x: .3, y: .1 }, { x: .3, y: .3 }, { x: .1, y: .3 }], printedArea: { value: 27.32, unit: "m²", status: "unreviewed" }, roomUseProposal: { roomUse: "living_dining_kitchen", confidence: .82, provider: "typesafe", model: "jev-1.13.0", status: "unreviewed" }, sourceFillEvidence: [{ layerId: "98R", layerName: "01-10 Grundriss Füllflächen" }], topology: { method: "wall_constrained_geodesic_partition", competingSourceKeys: [] } } }],
  };
  const html = render(raw, "?view=building-model&page=3") + renderPlanContext(raw, 3);
  expect(html).toContain("<strong>76</strong><small>Room hypotheses</small>");
  expect(html).toContain("<strong>15</strong><small>Unresolved anchors</small>");
  expect(html).toContain("<strong>41</strong><small>Draft wall candidates</small>");
  expect(html).toContain("<strong>72</strong><small>Construction assemblies</small>");
  expect(html).toContain("<strong>90</strong><small>Source area observations</small>");
  expect(html).toContain("<strong>163</strong><small>Total candidates</small>");
  expect(html).toContain("building-model-region room candidate approximate");
  const partition = adaptBuildingModel(raw).extractionCandidates[0]!;
  expect(renderToStaticMarkup(<CandidateInspector candidate={partition} regions={[]} t={(key) => en[key]} pending={false} onPage={() => undefined} onReview={() => undefined} />)).toContain("Spatial room region");
  const adapted = adaptBuildingModel({ extractionCandidates: [{ id: "candidate-partition", entityType: "room", name: "Living", status: "unreviewed", geometry: { quality: "approximate_partition", planRegion: { x: .1, y: .1, width: .2, height: .2 }, printedArea: { value: 27.32, unit: "m²" }, roomUseProposal: { roomUse: "living_dining_kitchen", confidence: .82, provider: "typesafe", model: "jev-1.13.0" }, sourceFillEvidence: [{ layerId: "98R", layerName: "01-10 Grundriss Füllflächen" }], topology: { method: "wall_constrained_geodesic_partition", competingSourceKeys: [] } } }] });
  expect(adapted.extractionCandidates[0]).toMatchObject({ sourceArea: { value: 27.32, unit: "m²" }, roomUseProposal: { roomUse: "living_dining_kitchen", confidence: .82 }, layerId: "98R", layerName: "01-10 Grundriss Füllflächen", algorithm: "wall_constrained_geodesic_partition" });
});

test("candidate overlays require the rendered page, source revision, and storey", () => {
  const candidates = [
    { id: "candidate:a", isCandidate: true as const, status: "unreviewed" as const, kind: "room" as const, label: "A", page: 3, storeyId: "storey-1", sourceVersionId: "version-1" },
    { id: "candidate:b", isCandidate: true as const, status: "unreviewed" as const, kind: "room" as const, label: "B", page: 3, storeyId: "storey-2", sourceVersionId: "version-1" },
    { id: "candidate:c", isCandidate: true as const, status: "unreviewed" as const, kind: "room" as const, label: "C", page: 3, storeyId: "storey-1", sourceVersionId: "version-2" },
  ];
  expect(candidatesForSource(candidates, 3, "version-1", "storey-1").map((candidate) => candidate.label)).toEqual(["A"]);
  expect(candidatesForSource(candidates, 2, "version-1", "storey-1")).toHaveLength(0);
});

test("canonical geometry keeps its persisted source revision and page", () => {
  const adapted = adaptBuildingModel({
    model: { id: "model-1", revision: 3 },
    storeys: [{ id: "storey-1", name: "Ground" }],
    rooms: [{ id: "room-1", name: "Persisted room", storeyId: "storey-1", planRegion: { x: .1, y: .1, width: .2, height: .2 }, geometry: { planRegion: { x: .1, y: .1, width: .2, height: .2 }, source: { sourceVersionId: "version-2", page: 7 } } }],
    elements: [], properties: [], measurements: [], proposals: [], conflicts: [], revisions: [],
    planSources: [{ id: "plan-1", storeyId: "storey-1", page: 3, source: { fileId: "f", fileName: "Plan.pdf", versionId: "version-1", version: 1, downloadUrl: "/api/projects/p/files/f/versions/1/download" } }],
  });
  const room = adapted.states.existing[0];
  expect(room?.sourceVersionId).toBe("version-2");
  expect(room?.page).toBe(7);
  expect(regionsForSource(adapted.states.existing, 7, "version-2", "storey-1")).toHaveLength(1);
  expect(regionsForSource(adapted.states.existing, 3, "version-1", "storey-1")).toHaveLength(0);
});

test("assembly polygon arrays and accepted source polygons survive API adaptation", () => {
  const adapted = adaptBuildingModel({
    model: { id: "model-1", revision: 3 }, storeys: [{ id: "storey-1", name: "Ground" }],
    rooms: [{ id: "room-1", name: "Accepted room", storeyId: "storey-1", geometry: { planRegion: { x: .1, y: .1, width: .2, height: .2 }, polygon: [{ x: .1, y: .1 }, { x: .3, y: .1 }, { x: .3, y: .3 }, { x: .1, y: .3 }], source: { sourceVersionId: "version-1", page: 3 } } }],
    elements: [], properties: [], measurements: [], proposals: [], conflicts: [], revisions: [],
    extractionCandidates: [{ id: "assembly-1", entityType: "element", name: "Assembly", status: "unreviewed", geometry: { quality: "assembly", planRegion: { x: .4, y: .4, width: .2, height: .1 }, polygons: [
      [{ x: .4, y: .4 }, { x: .45, y: .4 }, { x: .45, y: .45 }, { x: .4, y: .45 }],
      [{ x: .5, y: .45 }, { x: .6, y: .45 }, { x: .6, y: .5 }, { x: .5, y: .5 }],
    ] } }],
  });
  expect(adapted.states.existing[0]?.polygon).toHaveLength(4);
  expect(adapted.extractionCandidates[0]?.parts).toHaveLength(2);
  const secondBox = adapted.extractionCandidates[0]?.parts?.[1]?.box;
  expect(secondBox?.x).toBeCloseTo(.5);
  expect(secondBox?.y).toBeCloseTo(.45);
  expect(secondBox?.width).toBeCloseTo(.1);
  expect(secondBox?.height).toBeCloseTo(.05);
});

test("deep-linked entity source wins over another storey on the same page", () => {
  const sources = [
    { id: "source-a", storeyId: "storey-a", page: 3, source: { fileId: "f-a", fileName: "A.pdf", versionId: "version-a", version: 1, downloadUrl: "/a" } },
    { id: "source-b", storeyId: "storey-b", page: 3, source: { fileId: "f-b", fileName: "B.pdf", versionId: "version-b", version: 1, downloadUrl: "/b" } },
  ];
  const selected = { storeyId: "storey-b", sourceVersionId: "version-b", page: 3 };
  expect(planSourceForView(sources, 3, "", selected)?.id).toBe("source-b");
  expect(planSourceForView(sources, 3, "storey-a", selected)?.id).toBe("source-a");
  expect(planSourceForView(sources, 3, "storey-a", selected, "version-b")?.id).toBe("source-b");
});

test("explicit page navigation can leave the selected storey for a non-plan or unresolved source page", () => {
  const sources = [
    { id: "source-floor", storeyId: "storey-a", page: 1, source: { fileId: "f", fileName: "Plan.pdf", versionId: "version-a", version: 1, downloadUrl: "/a" } },
    { id: "source-elevation", storeyId: null, page: 2, source: { fileId: "f", fileName: "Plan.pdf", versionId: "version-a", version: 1, downloadUrl: "/a" } },
  ];
  const selected = { storeyId: "storey-a", sourceVersionId: "version-a", page: 1 };
  expect(planSourceForView(sources, 2, "storey-a", selected)?.id).toBe("source-elevation");
});

test("PDF selection keeps an unregistered page in its document and coverage does not invent contiguous registrations", () => {
  const source = (versionId: string, page: number) => ({ id: `${versionId}-${page}`, page, pageCount: 72, storeyId: null,
    source: { fileId: versionId, fileName: `${versionId}.pdf`, versionId, version: 1, downloadUrl: `/${versionId}` } });
  const sources = [source("other", 72), source("plans", 3), source("plans", 22)];
  expect(planSourceForView(sources, 72, "", undefined, "plans")).toBeUndefined();
  expect(planSourceForView(sources, 22, "", undefined, "plans")?.id).toBe("plans-22");
  const raw = { model: { id: "model", revision: 1 }, planSources: sources, rooms: [], elements: [] };
  const html = render(raw, "?view=building-model&page=72&sourceVersion=plans&sourceSelection=manual");
  expect(html).toContain('value="72" selected=""');
  expect(html).toContain("PDF page 72 of 72");
  expect(html).toContain('<option value="plans" selected="">plans.pdf</option>');
  expect(html).not.toContain('<option value="other" selected="">');
  const unknownCount = render({ ...raw, planSources: Array.from({ length: 13 }, (_, index) => ({ ...source("plans", index + 20), pageCount: null })) },
    "?view=building-model&page=22&sourceVersion=plans&sourceSelection=manual");
  expect(unknownCount).toContain("Page 22 · Unresolved page");
  expect(unknownCount).not.toContain("of 13");
  expect(unknownCount).not.toContain('<option value="1">');
  const coverage = renderToStaticMarkup(<AutomaticPlanCoverage processing={[{ fileName: "Report.pdf", sourceVersionId: "plans", status: "unresolved", registeredPageCount: 2,
    floorPlanPages: [], nonFloorPlanPages: [{ page: 22, pageType: "section" }], unresolvedPages: [3],
    reason: "No page met the automatic floor-plan threshold; no geometry was guessed. Page coverage remains available for review." }]}
    sources={sources} storeys={[]} selectedPage={22} selectedSourceVersionId="plans" onPage={() => {}} t={key => de[key]} />);
  expect(coverage).toContain("<span>3</span>");
  expect(coverage).toContain("<span>22</span>");
  expect(coverage).not.toContain("<span>1</span>");
  expect(coverage).not.toContain("<span>72</span>");
  expect(coverage).toContain("Keine Grundrissseite · Schnitt");
  expect(coverage).toContain(de.buildingModelCoverageNoPlan);
  expect(coverage).not.toContain("No page met");
});

test("every unknown component input offers a source route, while explicit zero and false are not missing", () => {
  const render = (key: string, state?: any) => renderToStaticMarkup(<PropertyRow propertyKey={key} state={state} t={key => en[key]} pending={false}
    onSave={() => { throw Error("must not save while looking for sources"); }} onReview={() => { throw Error("must not approve"); }} />);
  for (const key of new Set(Object.values(buildingComponentProperties).flatMap(Object.keys)))
    expect(render(key)).toContain('aria-label="Find source / missing evidence:');
  for (const [key, value] of [["fireOtherUnits", 0], ["loadBearing", false]])
    expect(render(String(key), { value, reviewStatus: "unreviewed", provenance: "manual" })).not.toContain('aria-label="Find source / missing evidence:');
});

test("detected apartments do not establish a complete unit schedule or zero other units for fire classification", () => {
  const state = (value: unknown) => ({ propertyId: "p", version: 1, value, unit: null, provenance: "manual", reviewStatus: "unreviewed", reviewRevision: 0, reviewedValue: null });
  const model = adaptBuildingModel({ buildings: [{ id: "b", name: "Building" }], storeys: [{ id: "s", buildingId: "b", levelIndex: 0 }], rooms: [{ id: "r", name: "Living room", storeyId: "s" }] });
  model.buildings[0]!.componentProperties = { federalState: state("RP"), fireHeight: state(6), fireDetached: state(true), fireSpecialUse: state("none"), garageArea: state(0) };
  model.states.existing[0]!.componentProperties = { apartmentUnit: state("WE 1"), spaceType: state("apartment") };
  expect(assessFireProtection(model).derived.dwellings).toBe(1);
  expect(assessFireProtection(model).classification.buildingClass).toBeNull();
  expect(assessFireProtection(model).classification.gaps).toContain("otherUnits");
  model.buildings[0]!.componentProperties.fireDwellings = state(1);
  expect(assessFireProtection(model).classification.buildingClass).toBeNull();
  model.buildings[0]!.componentProperties.fireOtherUnits = state(0);
  expect(assessFireProtection(model).classification.buildingClass).toBe(1);
});

test("regulatory suggestions preserve custom source wording and never populate or approve unknown values", () => {
  const state = (value: string) => ({ propertyId: value, version: 1, value, unit: null, provenance: "manual", reviewStatus: "unreviewed", reviewRevision: 0 });
  const renderBasis = (properties: Record<string, ReturnType<typeof state>>, addressState?: import("@richtfest/shared").BuildingAddressStateSuggestion) => renderToStaticMarkup(<RegulatoryBasis properties={properties} addressState={addressState} t={key => en[key]} pending={false}
    onSave={() => { throw new Error("render must not save a suggestion"); }} onReview={() => { throw new Error("render must not approve a suggestion"); }} />);
  const html = renderBasis({ federalState: state("RP"), bebauungsplan: state("applies"), bebauungsplanAreaType: state("WA 1 / WA 2"), din4109Edition: state("Project-specific edition") });
  expect(html).toContain('value="WA 1 / WA 2"');
  expect(html).toContain('value="Project-specific edition"');
  expect(html).toContain('<option value="WA">General residential area</option>');
  expect(html).toContain('<option value="VV TB RP vom 02.10.2025">');
  expect(html).toContain('placeholder="Unknown" value=""');
  expect(html).toContain("Selection does not approve a value");
  expect(html).not.toContain(">Reviewed<");
  const unknown = renderBasis({});
  expect(unknown).not.toContain("VV TB RP vom");
  expect(unknown).not.toContain("LBO BW ·");
  const address = { value: "RP" as const, evidence: { kind: "project_address" as const, quote: "Teststraße 1, Mainz · RP · BKG VG250" } };
  const suggested = renderBasis({}, address);
  expect(suggested).toContain("Rhineland-Palatinate · from address");
  expect(suggested).toContain("Use address value");
  expect(suggested).toContain("Teststraße 1, Mainz");
  expect(suggested).toContain("VV TB RP vom");
  expect(suggested).not.toContain('<option value="RP" selected="">');
  const entered = renderBasis({ federalState: state("BE") }, address);
  expect(entered).toContain('<option value="BE" selected="">');
  expect(entered).toContain("VV TB Bln vom");
  expect(entered).not.toContain("VV TB RP vom");
  expect(entered).not.toContain("Use address value");
  for (const code of Object.values(BUILDING_CODES)) if (code.stand) expect(`${code.abbreviation} · ${code.stand}`.length).toBeLessThanOrEqual(120);
});

test("planning context links the saved basis and offers only source-backed B-Plan facts into empty fields", () => {
  const assessment = { ...createEmptySiteAssessmentInput(), revision: 3 };
  assessment.planningBasis = "b_plan";
  assessment.checks.planningBasis = { status: "confirmed", source: "Plan register 7-42", note: "Parcel inside adopted plan" };
  assessment.constraints.grz = { value: .4, source: "Plan 7-42 §2", sourceDate: "2026-01-03", kind: "official", reviewed: true };
  assessment.constraints.gfz = { value: 1.7, source: "Neighbour comparison", sourceDate: "2026-01-03", kind: "calculated", reviewed: true };
  assessment.planningFacts = { landUse: { value: "WA 2", source: "Plan 7-42", sourceDate: "2026-01-03", kind: "official", reviewed: false } };
  const renderContext = (basis: typeof assessment.planningBasis, revision = 3) => {
    const client = new QueryClient();
    client.setQueryData([`/feasibility/projects/${projectId}/site-assessment`], { assessment: { ...assessment, planningBasis: basis, revision } });
    return renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter><RegulatoryBasis projectId={projectId}
      properties={{ bebauungsplanAreaType: { propertyId: "area", version: 1, value: "MI", unit: null, provenance: "manual", reviewStatus: "approved", reviewRevision: 1 } }}
      t={key => en[key]} pending={false} onSave={() => { throw Error("must not auto-copy"); }} onReview={() => { throw Error("must not auto-approve"); }} /></MemoryRouter></QueryClientProvider>);
  };
  const html = renderContext("b_plan");
  expect(html).toContain("view=feasibility&amp;study=site&amp;step=limits");
  expect(html).toContain('aria-label="Use value: GRZ"');
  expect(html).toContain('aria-label="Use value: Bebauungsplan"');
  expect(html).toContain("WA 2");
  expect(html).toContain('title="MI">Differs');
  expect(html).not.toContain('aria-label="Use value: Area type');
  expect(html).not.toContain('aria-label="Use value: GFZ"');
  for (const basis of ["section34", "section35", "unresolved"] as const) {
    const other = renderContext(basis);
    expect(other).not.toContain('aria-label="Use value:');
    expect(other).toContain(en[basis === "section34" ? "buildingPlanningSection34" : basis === "section35" ? "buildingPlanningSection35" : "buildingPlanningUnresolved"]);
  }
  expect(renderContext("b_plan", 0)).not.toContain('aria-label="Use value:');
  assessment.constraints.parcelArea = { value: 987.5, source: "Cadastral extract parcel 42", sourceDate: "2026-01-03", kind: "official", reviewed: true };
  for (const basis of ["b_plan", "section34", "section35", "unresolved"] as const) {
    const parcel = renderContext(basis);
    expect(parcel).toContain('aria-label="Use value: Parcel area"');
    expect(parcel).toContain("987.5 m²");
  }
  for (const kind of ["estimated", "calculated", "assessment"] as const) {
    assessment.constraints.parcelArea.kind = kind;
    expect(renderContext("b_plan")).not.toContain('aria-label="Use value: Parcel area"');
  }
});

test("default source selection opens a detected plan page instead of a report cover", () => {
  const sources = [
    { id: "report-cover", storeyId: null, page: 1, source: { fileId: "report", fileName: "DIN 4109 Calculation.pdf", versionId: "report-version", version: 1, downloadUrl: "/report" } },
    { id: "report-plan", storeyId: "report-storey", page: 3, source: { fileId: "report", fileName: "DIN 4109 Calculation.pdf", versionId: "report-version", version: 1, downloadUrl: "/report" } },
    { id: "architecture", storeyId: null, page: 2, source: { fileId: "plan", fileName: "Final Approval Planning.pdf", versionId: "plan-version", version: 1, downloadUrl: "/plan" } },
  ];
  const processing = [
    { fileId: "report", fileName: "DIN 4109 Calculation.pdf", sourceVersionId: "report-version", status: "partial", floorPlanPages: [3], nonFloorPlanPages: [{ page: 1 }], unresolvedPages: [] },
    { fileId: "plan", fileName: "Final Approval Planning.pdf", sourceVersionId: "plan-version", status: "unresolved", floorPlanPages: [], nonFloorPlanPages: [], unresolvedPages: [2] },
  ];
  expect(preferredPlanSource(sources, processing)?.id).toBe("report-plan");
  expect(planSourceForView(sources, 1, "", undefined, "", processing)?.id).toBe("report-plan");
  expect(planSourceForView(sources, 1, "", undefined, "report-version", processing)?.id).toBe("report-cover");
  expect(planSourceForView(sources, 2, "", undefined, "plan-version", processing)?.id).toBe("architecture");
});

test("an agent entity deep link pins the room's own PDF page instead of the preferred plan", () => {
  const sources = [
    { id: "preferred-plan", storeyId: "storey-a", page: 1, source: { fileId: "plan", fileName: "Genehmigungsplanung.pdf", versionId: "plan-version", version: 1, downloadUrl: "/plan" } },
    { id: "room-source", storeyId: "storey-b", page: 4, source: { fileId: "other", fileName: "Bestand.pdf", versionId: "other-version", version: 1, downloadUrl: "/other" } },
  ];
  const processing = [{ fileId: "plan", fileName: "Genehmigungsplanung.pdf", sourceVersionId: "plan-version", status: "complete", floorPlanPages: [1], nonFloorPlanPages: [], unresolvedPages: [] }];
  const room = { storeyId: "storey-b", sourceVersionId: "other-version", page: 4 };
  const deepLink = new URLSearchParams("view=building-model&entity=room:room-1");
  expect(isEntityDeepLink(deepLink)).toBe(true);
  expect(isEntityDeepLink(new URLSearchParams("view=building-model&entity=room:room-1&page=1"))).toBe(false);
  expect(isEntityDeepLink(new URLSearchParams("view=building-model"))).toBe(false);
  // Initial deep-link render: state page is still 1 with no storey/source.
  expect(planSourceForSelection(sources, { page: 1, storeyId: "", sourceVersionId: "", pinned: true, selected: room, deepLinked: room }, processing)?.id).toBe("room-source");
  // After the view state follows the entity, the pinned selection stays on that source.
  expect(planSourceForSelection(sources, { page: 4, storeyId: "storey-b", sourceVersionId: "other-version", pinned: true, selected: room }, processing)?.id).toBe("room-source");
  // Links without entity/page/source keep the automatic best-plan choice.
  expect(planSourceForSelection(sources, { page: 1, pinned: false, selected: room }, processing)?.id).toBe("preferred-plan");
});

test("an unresolved architectural PDF outranks an unresolved calculation report", () => {
  const sources = [
    { id: "report", storeyId: null, page: 1, source: { fileId: "report", fileName: "Schallschutznachweis.pdf", versionId: "report-version", version: 1, downloadUrl: "/report" } },
    { id: "architecture", storeyId: null, page: 2, source: { fileId: "plan", fileName: "Final Approval Planning.pdf", versionId: "plan-version", version: 1, downloadUrl: "/plan" } },
  ];
  expect(planSourceForView(sources, 1)?.id).toBe("architecture");
});

test("canonical inspector remains the default when candidates exist", () => {
  const html = render({
    model: { id: "model-1", revision: 9 },
    rooms: [{ id: "room-1", name: "Canonical room", storeyId: "storey-1", constructionState: "retained", roomUse: "Office" }],
    elements: [], storeys: [{ id: "storey-1", name: "Ground" }], properties: [], measurements: [], proposals: [], conflicts: [], revisions: [],
    planSources: [{ id: "plan-1", storeyId: "storey-1", page: 3, source: { fileId: "f", fileName: "Plan.pdf", versionId: "version-1", version: 1, downloadUrl: "/api/projects/p/files/f/versions/1/download" } }],
    extractions: [{ id: "job-1", sourceVersionId: "version-1", storeyId: "storey-1", page: 3, status: "complete" }],
    extractionCandidates: [{ id: "candidate-1", jobId: "job-1", name: "Unreviewed room", entityType: "room", geometry: { quality: "anchor", planRegion: { x: .1, y: .1, width: .01, height: .01 } }, evidence: [{ kind: "page", sourceVersionId: "version-1", page: 3, quote: "Unreviewed room" }], status: "unreviewed" }],
  });
  expect(html).toContain("Canonical room");
  expect(html).not.toContain("This is an extraction candidate, not an approved model object");
});

test("review status stays needs-review while any extraction candidate remains unreviewed", () => {
  const partial = adaptBuildingModel({
    model: { id: "model-1", revision: 10, reviewStatus: "reviewed" },
    revisions: [{ status: "approved" }],
    extractionCandidates: [
      { id: "accepted", entityType: "room", name: "Accepted", status: "accepted" },
      { id: "remaining", entityType: "room", name: "Still unreviewed", status: "unreviewed" },
    ],
  });
  expect(partial.reviewStatus).toBe("needs-review");
  const complete = adaptBuildingModel({ model: { id: "model-1", revision: 11 }, revisions: [{ status: "approved" }], extractionCandidates: [{ id: "accepted", entityType: "room", name: "Accepted", status: "accepted" }] });
  expect(complete.reviewStatus).toBe("reviewed");
});

test("candidate sidebar and inspector stay scoped to the explicit source page, revision, and storey", () => {
  const html = render({
    model: { id: "model-1", revision: 4 },
    rooms: [{ id: "room-page-3", name: "Canonical page three", storeyId: "storey-3", geometry: { source: { sourceVersionId: "version-1", page: 3 } } }],
    elements: [], properties: [], measurements: [], proposals: [], conflicts: [], revisions: [],
    storeys: [{ id: "storey-1", name: "Page one" }, { id: "storey-3", name: "Page three" }],
    planSources: [
      { id: "source-1", storeyId: "storey-1", page: 1, source: { fileId: "f", fileName: "Plan.pdf", versionId: "version-1", version: 1, downloadUrl: "/plan" } },
      { id: "source-3", storeyId: "storey-3", page: 3, source: { fileId: "f", fileName: "Plan.pdf", versionId: "version-1", version: 1, downloadUrl: "/plan" } },
    ],
    extractions: [
      { id: "job-1", sourceVersionId: "version-1", storeyId: "storey-1", page: 1, status: "complete" },
      { id: "job-3", sourceVersionId: "version-1", storeyId: "storey-3", page: 3, status: "complete" },
    ],
    extractionCandidates: [
      { id: "candidate-page-1", jobId: "job-1", entityType: "room", name: "Page one candidate", status: "unreviewed", geometry: { quality: "enclosed_region", planRegion: { x: .1, y: .1, width: .2, height: .2 } } },
      { id: "candidate-page-3", jobId: "job-3", entityType: "room", name: "Page three candidate", status: "unreviewed", geometry: { quality: "enclosed_region", planRegion: { x: .3, y: .3, width: .2, height: .2 } } },
    ],
  }, "?view=building-model&page=1&sourceVersion=version-1&storey=storey-1&entity=room%3Aroom-page-3");
  expect(html).toContain("Page one candidate");
  expect(html).not.toContain("Page three candidate");
  expect(html).toContain("Select a room or element");
  expect(html).not.toContain("<h2>Canonical page three</h2>");
});

test("magic selection targets the room under the click, then label-only candidates inside the detected outline, selected first", () => {
  const square = (x: number, y: number, size: number) => [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }];
  const regions = [
    { id: "room-big", kind: "room" as const, entityType: "room" as const, label: "Wohnen", page: 1, polygon: square(0, 0, .5), box: { x: 0, y: 0, width: .5, height: .5 } },
    { id: "candidate:small", candidateId: "small", isCandidate: true, kind: "room" as const, entityType: "room" as const, label: "Diele", page: 1, polygon: square(.1, .1, .2), box: { x: .1, y: .1, width: .2, height: .2 } },
    { id: "candidate:anchor", candidateId: "anchor", isCandidate: true, kind: "room" as const, entityType: "room" as const, label: "Abst.", page: 1, box: { x: .35, y: .35, width: .02, height: .01 } },
    { id: "candidate:far-anchor", candidateId: "far", isCandidate: true, kind: "room" as const, entityType: "room" as const, label: "Bad", page: 1, box: { x: .8, y: .8, width: .02, height: .01 } },
    { id: "wall", kind: "element" as const, entityType: "element" as const, label: "Wall", page: 1, polygon: square(.15, .15, .05) },
  ];
  const detected = square(.05, .05, .4);
  // Smallest containing outline first, then the anchor whose label is inside the detection; walls and outside anchors are ignored.
  expect(outlineTargetsAt(regions, { x: .2, y: .2 }, detected).map((target) => target.type === "new_room" ? "new" : `${target.type}:${target.id}`))
    .toEqual(["candidate:small", "room:room-big", "candidate:anchor", "new"]);
  expect(outlineTargetsAt(regions, { x: .2, y: .2 }, detected, "room-big")[0]).toMatchObject({ type: "room", id: "room-big" });
  expect(outlineTargetsAt(regions, { x: .9, y: .1 }, square(.85, .05, .1))).toEqual([{ type: "new_room" }]);
});

test("plan points convert to metres with the page aspect for measuring and vertex editing", () => {
  // A landscape page 1.5× as wide as tall, 40 m per page height: page width is 60 m.
  const scale = { pageAspectRatio: 1.5, metresPerPageHeight: 40 };
  expect(pointToMetres({ x: .5, y: .25 }, scale)).toEqual({ x: 30, y: 10 });
  expect(metresToPoint({ x: 30, y: 10 }, scale)).toEqual({ x: .5, y: .25 });
  expect(planDistanceM({ x: 0, y: 0 }, { x: .1, y: 0 }, scale)).toBeCloseTo(6);
  expect(planDistanceM({ x: 0, y: 0 }, { x: 0, y: .1 }, scale)).toBeCloseTo(4);
  expect(planDistanceM({ x: 0, y: 0 }, { x: .1, y: 0 }, { pageAspectRatio: 1.5, metresPerPageHeight: null })).toBeNull();
});

test("wall type review groups values by value and unit, and only offers unreviewed versions", async () => {
  const { wallTypeGroups } = await import("../src/components/building-model/component-properties");
  const state = (value: unknown, unit: string | null, reviewStatus: string, n: number) => ({ propertyId: `p${n}`, version: 2, value, unit, provenance: "manual", reviewStatus, reviewRevision: 0, reviewedValue: null });
  const wall = (n: number, thickness?: ReturnType<typeof state>) => ({ id: `w${n}`, kind: "element" as const, entityType: "element" as const, label: `Wall ${n}`, page: 1, componentProperties: thickness ? { thickness } : {} });
  const { groups, missing } = wallTypeGroups([wall(1, state(24, "cm", "unreviewed", 1)), wall(2, state(24, "cm", "approved", 2)), wall(3, state(24, "cm", "unreviewed", 3)),
    wall(4, state(25, "cm", "unreviewed", 4)), wall(5, state(24, "cm", "rejected", 5)), wall(6)] as any, "thickness");
  expect(groups.map((group) => [group.value, group.walls, group.approved, group.pending.map((item) => item.propertyId)])).toEqual([[24, 3, 1, ["p1", "p3"]], [25, 1, 0, ["p4"]]]);
  expect(missing).toBe(2);
});

test("the data request reads like an email to the architect, grouped by wall type", async () => {
  const { dataRequestText } = await import("../src/components/building-model/sound-insulation");
  const t = ((key: keyof typeof en) => en[key] ?? key) as any;
  const text = dataRequestText([
    { componentType: "wall", wallRole: "apartment_partition", count: 3, componentIds: [], fields: [
      { field: "construction", missing: 3, unconfirmed: [] },
      { field: "thickness", missing: 1, unconfirmed: [{ value: 24, unit: "cm", origin: "plan", count: 2 }] },
    ] },
    { componentType: "ceiling", wallRole: null, count: 1, componentIds: [], fields: [{ field: "bulkDensity", missing: 1, unconfirmed: [] }] },
  ], t);
  expect(text).toBe(`${en.buildingSoundRequestIntro}

Apartment partition wall (3 walls)
- Please provide: Construction, Thickness (1/3)
- Please confirm: Thickness 24 cm (from plan, 2 walls)

Ceilings (1 ceiling)
- Please provide: Bulk density`);
});

test("model adapter exposes ceilings' rooms and the building's requirement level", () => {
  const model = adaptBuildingModel({ buildings: [{ id: "b1", name: "Haus" }], elements: [{ id: "c1", kind: "draft_ceiling", name: "Ceiling above EG", constructionState: "unknown", geometry: { source: { sourceVersionId: "v", page: 1 } } }],
    properties: [{ id: "p1", entityType: "building", entityId: "b1", propertyKey: "soundInsulationLevel", current: { version: 1, value: "elevated", reviewStatus: "unreviewed", provenance: "manual" } }],
    relationships: [{ relationshipType: "covers", fromEntityType: "element", fromEntityId: "c1", toEntityType: "room", toEntityId: "r1" }] });
  expect(model.buildings[0].componentProperties.soundInsulationLevel).toMatchObject({ value: "elevated", reviewStatus: "unreviewed" });
  expect(model.states.existing.find((region) => region.id === "c1")).toMatchObject({ elementKind: "draft_ceiling", covers: ["r1"] });
});

test("an IFC entity link opens its own source revision and metre-based storey, not a PDF canvas", () => {
  const source = (version: string, expressId: number) => ({ kind: "ifc", sourceVersionId: version, expressId, globalId: `global-${expressId}`, ifcType: "IFCSPACE" });
  const html = render({ model: { revision: 2 },
    buildings: ["v1", "v2"].map(v => ({ id: v, geometry: { ifcImport: { sourceVersionId: v, fileName: `${v}.ifc`, warnings: [] } } })),
    storeys: ["v1", "v2"].map((v, i) => ({ id: `s${i}`, name: `Floor ${i}`, geometry: { source: source(v, i + 1) } })),
    rooms: ["v1", "v2"].map((v, i) => ({ id: `r${i}`, storeyId: `s${i}`, name: `Room ${i}`, geometry: { source: source(v, i + 10), coordinateSpace: "ifc-metre", elevationRange: [3, 5.8], footprint: [[[[6.4, 19.5], [8.4, 19.5], [8.4, 23.5], [6.4, 19.5]]]] } })),
  }, "?view=building-model&entity=room:r1");
  expect(html).toContain('value="s1" selected=""');
  expect(html).toContain('aria-label="Room 1 · IFCSPACE #11" aria-pressed="true"');
  expect(html).toContain('d="M6.4,-19.5 L8.4,-19.5 L8.4,-23.5 L6.4,-19.5Z"');
  expect(html).toContain("global-11");
  expect(html).not.toContain("<canvas");
  expect(html).not.toContain('aria-label="Room 0 · IFCSPACE #10"');
});

test("IFC review keeps confirmed values separate from proposals and warning notes scoped to their import", () => {
  const source = (version: string, expressId: number) => ({ kind: "ifc", sourceVersionId: version, expressId, ifcType: "IFCSPACE" });
  const html = render({ model: { revision: 5 },
    buildings: ["v1", "v2"].map(v => ({ id: v, geometry: { source: source(v, 10), ifcImport: { sourceVersionId: v, warnings: [{ code: "identicalUnits", count: 234 }] } } })),
    storeys: [{ id: "s2", name: "Floor", geometry: { source: source("v2", 20) } }],
    rooms: [{ id: "r2", storeyId: "s2", name: "Room", geometry: { source: source("v2", 30) } }],
    properties: [
      { entityType: "room", entityId: "r2", propertyKey: "apartmentUnit", current: { version: 2, value: "Proposed B", reviewStatus: "unreviewed", evidence: [{ kind: "page", sourceVersionId: "evidence", page: 4, quote: "Apartment B" }] }, reviewed: { value: "Confirmed A" } },
      { entityType: "building", entityId: "v1", propertyKey: "ifcReview.identicalUnits", current: { value: "Other import reviewed", reviewStatus: "approved" } },
    ],
  }, "?view=building-model&entity=room:r2");
  expect(html).toContain("Last confirmed value</dt><dd");
  expect(html).toContain("Confirmed A</dd>");
  expect(html).toContain("Proposed B ");
  expect(html).toContain("Apartment B");
  expect(html).toContain("1 source warnings without a reviewed note");
  expect(html).not.toContain("Other import reviewed");
  expect(html).toContain("Review decision and reason");
  expect(html).toContain("Save proposal for review");
});
