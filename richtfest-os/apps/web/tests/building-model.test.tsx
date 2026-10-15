import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BuildingModelBootstrap, BuildingModelMode, candidateOverlaysForSource, candidatesForSource, copyStableObjectId, regionsForSource } from "../src/components/building-model";
import { PdfEvidenceRenderer } from "../src/components/building-model/pdf-evidence-renderer";
import { partOverlayStyle, polygonClipPath } from "../src/components/building-model/pdf-evidence-renderer";
import { adaptBuildingModel } from "../src/components/building-model/types";

const projectId = "550e8400-e29b-41d4-a716-446655440000";

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
  expect(html).toContain("Layers change the PDF evidence view");
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
});

test("clipboard denial resolves calmly without an unhandled rejection", async () => {
  const copied = await copyStableObjectId("room-1", { writeText: async () => { throw new Error("permission denied"); } });
  expect(copied).toBe(false);
});

test("empty backend payload remains an explicit empty model instead of crashing the project view", () => {
  const html = render(undefined);
  expect(html).toContain("Set up the first plan source");
  expect(html).toContain("Loading project PDFs…");
  expect(html).toContain("Building name");
  expect(html).toContain("The PDF revision and page stay attached as source evidence.");
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
  const html = render({
    model: { id: "model-1", revision: 8 },
    storeys: [{ id: "storey-1", name: "Ground" }],
    rooms: [], elements: [], properties: [], measurements: [], proposals: [], conflicts: [], revisions: [],
    planSources: [{ id: "plan-1", storeyId: "storey-1", page: 3, source: { fileId: "f", fileName: "Plan.pdf", versionId: "v", version: 2, downloadUrl: "/api/projects/p/files/f/versions/2/download" } }],
    extractions: [{ id: "job-1", sourceVersionId: "v", storeyId: "storey-1", page: 3, status: "complete", result: { method: "native_text", coverage: "selected_page_labels_and_construction_footprints", geometryQuality: "mixed", candidateCount: 326, roomAnchorCount: 91, elementFootprintCount: 235, geometryExtraction: { status: "complete", retainedFootprints: 235, limitations: "Observed construction-layer paths are not verified walls or room boundaries." }, reason: "Room boundaries, materials, construction state and completeness are not established." } }],
    extractionCandidates: [{ id: "candidate-1", jobId: "job-1", sourceKey: "room-a", entityType: "room", name: "Room A", geometry: { quality: "anchor", coordinateSpace: "normalized-page", planRegion: { x: .1, y: .2, width: .02, height: .02 } }, evidence: [{ kind: "page", sourceVersionId: "v", page: 3, region: { x: .1, y: .2, width: .02, height: .02 }, quote: "Room A" }], status: "unreviewed", targetEntityId: null }],
  }, "?view=building-model&page=3");
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
  expect(html).toContain("Room A");
  expect(html).toContain("Candidate overlays");
  expect(html).toContain("Construction footprints");
  expect(html).toContain("Unreviewed candidate");
  expect(html).not.toContain("This is an extraction candidate, not an approved model object");
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

test("semantic extraction coverage names hypotheses, unresolved anchors, assemblies, and source-area observations", () => {
  const html = render({
    model: { id: "model-1", revision: 4 }, storeys: [{ id: "storey-1", name: "Ground" }], rooms: [], elements: [], properties: [], measurements: [], proposals: [], conflicts: [], revisions: [],
    planSources: [{ id: "plan-1", storeyId: "storey-1", page: 3, source: { fileId: "f", fileName: "Plan.pdf", versionId: "version-1", version: 1, downloadUrl: "/api/projects/p/files/f/versions/1/download" } }],
    extractions: [{ id: "job-1", sourceVersionId: "version-1", storeyId: "storey-1", page: 3, status: "complete", result: { candidateCount: 163, roomHypothesisCount: 76, unresolvedAnchorCount: 15, constructionAssemblyCount: 72, sourceAreaObservationCount: 90 } }],
    extractionCandidates: [{ id: "candidate-partition", jobId: "job-1", sourceVersionId: "version-1", storeyId: "storey-1", page: 3, entityType: "room", name: "Living", status: "unreviewed", geometry: { quality: "approximate_partition", planRegion: { x: .1, y: .1, width: .2, height: .2 }, polygon: [{ x: .1, y: .1 }, { x: .3, y: .1 }, { x: .3, y: .3 }, { x: .1, y: .3 }] } }],
  }, "?view=building-model&page=3");
  expect(html).toContain("<strong>76</strong><small>Room hypotheses</small>");
  expect(html).toContain("<strong>15</strong><small>Unresolved anchors</small>");
  expect(html).toContain("<strong>72</strong><small>Construction assemblies</small>");
  expect(html).toContain("<strong>90</strong><small>Source area observations</small>");
  expect(html).toContain("<strong>163</strong><small>Total candidates</small>");
  expect(html).toContain("building-model-region room candidate approximate");
  expect(html).toContain("Room hypothesis");
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
