import { Fragment, lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError, list, type RecordData } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Badge, Callout, Empty, Field, NoticeStack, Segmented } from "../ui/primitives";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { WorkbenchTool } from "../ui/workbench-tool";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { AudioLines, ChevronDown, Palette, ChevronRight, Copy, Eye, EyeOff, FileText, Hand, Link2, LoaderCircle, Maximize, Minus, MousePointer2, PanelLeft, PanelRight, Plus, Redo2, Ruler, ScanLine, Search, Spline, Undo2, WandSparkles } from "lucide-react";
import { adaptBuildingModel, candidateRole, type BuildingAutomaticPlanProcessing, type BuildingWallColour, type BuildingWallColourState, type BuildingPlanScale, type BuildingExtractionCandidate, type BuildingExtractionJob, type BuildingModelState, type BuildingPlanSource, type BuildingSupersededSource, type BuildingRegion, type BuildingComponentPropertyState, type PdfEvidenceLayer } from "./types";
import type { PdfViewerTransform } from "./pdf-evidence-renderer";
import { wallRoleSchema } from "@richtfest/shared";
const wallRoleOptions: string[] = wallRoleSchema.options;
import { ComponentProperties, WallTypeReview, regionComponentType, wallRoleOf, type ComponentPropertySave } from "./component-properties";
import { ZoningCheck } from "./zoning-check";
import { BebauungsplanReader, type BebauungsplanReadResult, componentRecord, DataRequest, DescriptionReader, RegulatoryBasis, ExteriorNoiseBasis, type ComponentSourceDocument, type DescriptionReadResult, SoundInsulationOverview, StoreyLevels, storeyLevelLabel } from "./sound-insulation";
import { soundInsulationChecks } from "@richtfest/shared";
import { metresToPoint, outlineAreaM2, outlineSelfIntersects, planDistanceM, pointInRing, pointToMetres, rectangleAround, type MagicOutline, type OutlineDraft, type PageScale } from "./outline-geometry";
import type { BuildingPlanPoint } from "./types";
import type { InquirySummary } from "../inquiries/types";
import "./building-model.css";

const LazyPdfEvidenceRenderer = lazy(async () => import("./pdf-evidence-renderer").then((module) => ({ default: module.PdfEvidenceRenderer })));
const emptyLayerVisibility: Record<string, boolean> = {};
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export async function copyStableObjectId(value: string, clipboard?: { writeText: (text: string) => Promise<void> }) {
  const target = clipboard ?? (typeof navigator !== "undefined" ? navigator.clipboard : undefined);
  if (!target) return false;
  try {
    await target.writeText(value);
    return true;
  } catch {
    return false;
  }
}
const states: Array<{ value: BuildingModelState; label: string }> = [
  { value: "existing", label: "Existing" },
  { value: "demolition", label: "Demolition" },
  { value: "proposed", label: "Proposed" },
];

function statusLabel(status: string | undefined, t: ReturnType<typeof useT>) {
  if (status === "reviewed") return t("buildingModelReviewed");
  if (status === "needs-review") return t("buildingModelNeedsReview");
  if (status === "conflict") return t("buildingModelConflict");
  return t("buildingModelDraft");
}

function pickRegions(model: ReturnType<typeof adaptBuildingModel>, state: BuildingModelState) {
  return model.states[state];
}

export function candidatesForSource(candidates: BuildingExtractionCandidate[], page: number, sourceVersionId?: string, storeyId?: string | null) {
  return candidates.filter((candidate) => candidate.page === page && (!storeyId || candidate.storeyId === storeyId) && (!sourceVersionId || candidate.sourceVersionId === sourceVersionId));
}

export function candidatesForGroup(candidates: BuildingExtractionCandidate[], group: string) {
  return group === "all" ? candidates : candidates.filter((candidate) => candidate.groupLabel === group);
}

export function candidatesForModelState(candidates: BuildingExtractionCandidate[], state: BuildingModelState) {
  return candidates.filter((candidate) => {
    if (candidate.entityType === "room" || !candidate.constructionState || candidate.constructionState === "unknown") return true;
    if (state === "proposed") return candidate.constructionState === "proposed" || candidate.constructionState === "retained";
    if (state === "demolition") return candidate.constructionState === "demolished" || candidate.constructionState === "retained";
    return candidate.constructionState !== "proposed" && candidate.constructionState !== "demolished";
  });
}

export type CandidateOverlayVisibility = {
  roomAnchors?: boolean;
  footprints?: boolean;
  roomHypotheses?: boolean;
  unresolvedAnchors?: boolean;
  draftWalls?: boolean;
  assemblies?: boolean;
};

export function candidateOverlayBucket(candidate: Pick<BuildingExtractionCandidate, "entityType" | "geometryQuality" | "semanticType">) {
  if (candidateRole(candidate) === "draft-wall") return "draftWalls" as const;
  if (candidate.geometryQuality === "footprint") return "footprints" as const;
  if (candidateRole(candidate) === "construction-assembly") return "assemblies" as const;
  if (candidate.geometryQuality === "anchor") return "unresolvedAnchors" as const;
  if (candidate.geometryQuality === "enclosed_region" || candidate.geometryQuality === "approximate_partition" || candidate.geometryQuality === "approximate_region") return "roomHypotheses" as const;
  return candidate.entityType === "room" ? "roomHypotheses" as const : "assemblies" as const;
}

/** Whether a candidate's overlay category is shown by the display defaults/toggles. */
export function overlayBucketVisible(candidate: Pick<BuildingExtractionCandidate, "entityType" | "geometryQuality" | "semanticType">, visibility: CandidateOverlayVisibility) {
  const bucket = candidateOverlayBucket(candidate);
  if (bucket === "roomHypotheses") return visibility.roomHypotheses ?? visibility.roomAnchors ?? true;
  if (bucket === "unresolvedAnchors") return visibility.unresolvedAnchors ?? visibility.roomAnchors ?? false;
  if (bucket === "draftWalls") return visibility.draftWalls ?? true;
  if (bucket === "assemblies") return visibility.assemblies ?? visibility.footprints ?? false;
  return visibility.footprints ?? false;
}

export function candidateOverlaysForSource(candidates: BuildingExtractionCandidate[], page: number, sourceVersionId: string | undefined, storeyId: string | null | undefined, visibility: CandidateOverlayVisibility) {
  return candidatesForSource(candidates, page, sourceVersionId, storeyId).filter((candidate) => overlayBucketVisible(candidate, visibility));
}

function candidateTypeLabel(candidate: BuildingExtractionCandidate, t: ReturnType<typeof useT>) {
  const role = candidate.candidateRole || candidateRole(candidate);
  if (role === "draft-wall") return t("buildingModelDraftWallCandidate");
  if (role === "construction-assembly") return t("buildingModelConstructionAssembly");
  if (role === "raw-footprint") return t("buildingModelConstructionFootprint");
  if (role === "unresolved-anchor") return t("buildingModelUnresolvedLabelAnchor");
  if (role === "room-region") return t("buildingModelSpatialRoomRegion");
  return t("buildingModelElementCandidate");
}

export function automaticProcessingActive(status: string | undefined) {
  return status === "reading_source" || status === "classifying_pages" || status === "planning" || status === "queued" || status === "extracting" || status === "processing";
}

export function automaticPageDisposition(processing: BuildingAutomaticPlanProcessing | undefined, page: number) {
  if (!processing) return "unresolved" as const;
  if (processing.floorPlanPages.includes(page)) return "floor_plan" as const;
  if (processing.nonFloorPlanPages.some((item) => item.page === page)) return "non_floor_plan" as const;
  return "unresolved" as const;
}

export function regionsForSource(regions: BuildingRegion[], page: number, sourceVersionId?: string, storeyId?: string | null) {
  return regions.filter((region) => region.page === page && (!storeyId || region.storeyId === storeyId) && (!sourceVersionId || region.sourceVersionId === sourceVersionId));
}

function planFileNamePreference(fileName: string) {
  let score = 0;
  if (/\b(plan|planning|grundriss|floor[\s_-]*plan|genehmigungsplanung|ausf(?:ü|ue)hrungsplanung|entwurfsplanung|bauantrag|architect)\b/i.test(fileName)) score += 250;
  if (/\b(din\s*4109|schallschutz|calculation|berechnung|nachweis|report|gutachten)\b/i.test(fileName)) score -= 150;
  return score;
}

function planSourcePreference(source: BuildingPlanSource, processing: BuildingAutomaticPlanProcessing[]) {
  const automatic = processing.find((item) => item.sourceVersionId === source.source?.versionId);
  let score = planFileNamePreference(source.source?.fileName || "");
  if (automatic?.floorPlanPages.includes(source.page)) score += 1_000;
  if (source.storeyId) score += 600;
  if (automatic?.nonFloorPlanPages.some((item) => item.page === source.page)) score -= 300;
  return score;
}

export function preferredPlanSource(sources: BuildingPlanSource[], processing: BuildingAutomaticPlanProcessing[] = []) {
  return sources.map((source, index) => ({ source, index, score: planSourcePreference(source, processing) }))
    .sort((a, b) => b.score - a.score || a.source.page - b.source.page || a.index - b.index)[0]?.source;
}

export function preferredAutomaticProcessing(processing: BuildingAutomaticPlanProcessing[]) {
  return processing.map((item, index) => ({ item, index, score: planFileNamePreference(item.fileName) + (item.floorPlanPages.length ? 1_000 : 0) - (item.nonFloorPlanPages.length && !item.floorPlanPages.length ? 100 : 0) }))
    .sort((a, b) => b.score - a.score || (a.item.floorPlanPages[0] || 1) - (b.item.floorPlanPages[0] || 1) || a.index - b.index)[0]?.item;
}

/** An agent deep link (`buildingDeepLink`: `?entity=type:id` without page or source) is a deliberate selection. */
export function isEntityDeepLink(params: URLSearchParams) {
  return params.has("entity") && !params.has("page") && !params.has("sourceVersion") && !params.has("storey");
}

/** Resolve the shown source page. A deep-linked entity pins its own source/page/storey; otherwise only a
 * pinned (manual) selection overrides the automatic best-plan choice. */
export function planSourceForSelection(sources: BuildingPlanSource[], view: { page: number; storeyId?: string; sourceVersionId?: string; pinned: boolean;
  selected?: Pick<BuildingRegion, "storeyId" | "sourceVersionId" | "page">; deepLinked?: Pick<BuildingRegion, "storeyId" | "sourceVersionId" | "page"> },
  processing: BuildingAutomaticPlanProcessing[] = []) {
  if (view.deepLinked) return planSourceForView(sources, view.deepLinked.page, view.deepLinked.storeyId || "", view.deepLinked,
    view.deepLinked.sourceVersionId || "", processing);
  return planSourceForView(sources, view.page, view.pinned ? view.storeyId : "", view.pinned ? view.selected : undefined,
    view.pinned ? view.sourceVersionId : "", processing);
}

export function planSourceForView(sources: BuildingPlanSource[], page: number, explicitStoreyId?: string | null,
  selected?: Pick<BuildingRegion, "storeyId" | "sourceVersionId" | "page">, explicitSourceVersionId?: string | null,
  processing: BuildingAutomaticPlanProcessing[] = []) {
  const explicitVersionSources = explicitSourceVersionId ? sources.filter((source) => source.source?.versionId === explicitSourceVersionId) : [];
  if (explicitVersionSources.length) return explicitVersionSources.find((source) => source.page === page)
    || preferredPlanSource(explicitVersionSources, processing);
  const explicitPage = explicitStoreyId ? sources.find((source) => source.storeyId === explicitStoreyId && source.page === page) : undefined;
  if (explicitPage) return explicitPage;
  const selectedPageSource = selected?.page === page ? sources.find((source) => source.storeyId === selected.storeyId
    && source.page === selected.page && (!selected.sourceVersionId || source.source?.versionId === selected.sourceVersionId))
    || sources.find((source) => source.storeyId === selected.storeyId && source.page === selected.page) : undefined;
  if (selectedPageSource) return selectedPageSource;
  const contextualPageSource = selected?.sourceVersionId ? sources.find((source) => source.source?.versionId === selected.sourceVersionId && source.page === page) : undefined;
  if (contextualPageSource) return contextualPageSource;
  const preferred = preferredPlanSource(sources, processing);
  if (preferred && planSourcePreference(preferred, processing) > 0) return preferred;
  const pageSource = sources.find((source) => source.page === page);
  if (pageSource) return pageSource;
  const explicit = explicitStoreyId ? sources.find((source) => source.storeyId === explicitStoreyId) : undefined;
  const selectedSource = selected ? sources.find((source) => source.storeyId === selected.storeyId) : undefined;
  return explicit || selectedSource || preferred;
}

type OutlineTarget = { type: "room" | "candidate"; id: string; regionId: string; label: string; sourceArea?: unknown } | { type: "new_room" };
type OutlineSession = {
  target: OutlineTarget;
  targets: OutlineTarget[];
  draft: OutlineDraft;
  method: "manual" | "magic_selection";
  magic?: { point: BuildingPlanPoint; options: MagicOutline[]; index: number; scale?: PageScale | null };
  name: string;
  history: OutlineDraft[];
  future: OutlineDraft[];
};
type PlanTool = "select" | "magic" | "pan" | "measure";
type CandidateEdit = { name?: string; targetEntityId?: string };
const toolKeys: Record<string, PlanTool | "edit"> = { v: "select", w: "magic", e: "edit", h: "pan", m: "measure" };

const magicPageScale = (session: OutlineSession | null) => session?.magic?.scale ?? null;

function outlineTarget(region: BuildingRegion): OutlineTarget {
  return region.isCandidate
    ? { type: "candidate", id: (region as BuildingExtractionCandidate).candidateId || region.id.replace(/^candidate:/, ""), regionId: region.id, label: region.label, sourceArea: region.sourceArea }
    : { type: "room", id: region.id, regionId: region.id, label: region.label, sourceArea: region.sourceArea };
}

/** Rooms and room candidates a magic-selection click could belong to: outlines containing the
 * point, then label-only candidates whose label sits inside the detected outline. Selected first. */
export function outlineTargetsAt(regions: BuildingRegion[], point: BuildingPlanPoint, detected: BuildingPlanPoint[], selectedId?: string): OutlineTarget[] {
  const rooms = regions.filter((region) => region.entityType !== "element" && region.kind !== "element");
  const area = (region: BuildingRegion) => region.box ? region.box.width * region.box.height : Infinity;
  const containing = rooms.filter((region) => region.polygon && region.polygon.length >= 3 && pointInRing(point, region.polygon));
  const labelled = rooms.filter((region) => !region.polygon?.length && region.box && pointInRing({ x: region.box.x + region.box.width / 2, y: region.box.y + region.box.height / 2 }, detected));
  const ordered = [...containing.sort((a, b) => area(a) - area(b)), ...labelled].sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId));
  return [...new Map(ordered.map((region) => [region.id, outlineTarget(region)])).values(), { type: "new_room" }];
}

export function BuildingModelMode({ projectId }: { projectId: string }) {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const requestedState = params.get("modelState");
  const state: BuildingModelState = states.some((item) => item.value === requestedState) ? requestedState as BuildingModelState : "existing";
  const setModelState = (nextState: BuildingModelState) => {
    const next = new URLSearchParams(params);
    next.set("modelState", nextState);
    setParams(next);
  };
  const [page, setPage] = useState(Math.max(1, Number(params.get("page") || 1)));
  const [sourceStoreyId, setSourceStoreyId] = useState(params.get("storey") || "");
  const [sourceVersionId, setSourceVersionId] = useState(params.get("sourceVersion") || "");
  const [sourceSelectionPinned, setSourceSelectionPinned] = useState(params.get("sourceSelection") === "manual" || isEntityDeepLink(params));
  const deepLinkedEntity = params.get("entity")?.split(":").slice(1).join(":");
  const [selectedId, setSelectedId] = useState<string | undefined>(deepLinkedEntity || undefined);
  const [layers, setLayers] = useState<Record<string, boolean>>({});
  const [pdfLayers, setPdfLayers] = useState<PdfEvidenceLayer[]>([]);
  const [conflict, setConflict] = useState<string>();
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>();
  const [candidateOverlayVisibility, setCandidateOverlayVisibility] = useState<CandidateOverlayVisibility>({ roomHypotheses: true, unresolvedAnchors: false, draftWalls: true, assemblies: false, footprints: false });
  const [viewerTransform, setViewerTransform] = useState<PdfViewerTransform>({ zoom: 1, pan: { x: 0, y: 0 } });
  const [planTool, setPlanTool] = useState<PlanTool>("select");
  const [outlineSession, setOutlineSession] = useState<OutlineSession | null>(null);
  const [magicNotice, setMagicNotice] = useState<string>();
  const [measurePoints, setMeasurePoints] = useState<BuildingPlanPoint[]>([]);
  const [snapToWalls, setSnapToWalls] = useState(true);
  // Per-object eye toggles in the outliner; unset objects follow their overlay category.
  const [objectVisibility, setObjectVisibility] = useState<Record<string, boolean>>({});
  const [candidateEdits, setCandidateEdits] = useState<Record<string, CandidateEdit>>({});
  const [panels, setPanels] = useState({ outliner: false, properties: false });
  const workbenchKeys = useRef<(event: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => workbenchKeys.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const paramsKey = params.toString();
  useBrowserLayoutEffect(() => {
    const nextPage = Math.max(1, Number(params.get("page") || 1));
    const nextStorey = params.get("storey") || "";
    const nextVersion = params.get("sourceVersion") || "";
    const nextSourceSelectionPinned = params.get("sourceSelection") === "manual" || isEntityDeepLink(params);
    const nextEntity = params.get("entity")?.split(":").slice(1).join(":") || undefined;
    setPage((current) => current === nextPage ? current : nextPage);
    setSourceStoreyId((current) => current === nextStorey ? current : nextStorey);
    setSourceVersionId((current) => current === nextVersion ? current : nextVersion);
    setSourceSelectionPinned((current) => current === nextSourceSelectionPinned ? current : nextSourceSelectionPinned);
    setSelectedId((current) => current === nextEntity ? current : nextEntity);
    setSelectedCandidateId(undefined);
  }, [paramsKey]);
  const modelQuery = useApi(`/projects/${projectId}/building-model`);
  const modelError = modelQuery.error instanceof Error ? modelQuery.error : null;
  const model = useMemo(() => adaptBuildingModel(modelQuery.data), [modelQuery.data]);
  // Property and review writes run one at a time and continue from the revision the previous write
  // returned, so quick consecutive edits are not rejected as stale before the model reloads.
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const writtenRevision = useRef({ projectId, revision: 0 });
  const loadedRevision = useRef(model.revision ?? 0);
  loadedRevision.current = model.revision ?? 0;
  const modelApi = useCallback(<T = RecordData,>(path: string, body?: unknown, method?: string): Promise<T> => {
    const run = writeQueue.current.catch(() => undefined).then(async () => {
      const written = writtenRevision.current.projectId === projectId ? writtenRevision.current.revision : 0;
      const revision = Math.max(loadedRevision.current, written);
      const result = await api<T>(path, body && typeof body === "object" && "baseRevision" in body ? { ...body, baseRevision: revision } : body, method);
      const next = (result as { revision?: unknown } | null)?.revision;
      if (typeof next === "number") writtenRevision.current = { projectId, revision: Math.max(written, next) };
      return result;
    });
    writeQueue.current = run;
    return run;
  }, [projectId]);
  const missingModelOrSource = (modelQuery.isError && modelError instanceof ApiError && modelError.status === 404) || (!modelQuery.isError && (!modelQuery.data || !model.planSources.length));
  const filesQuery = useApi(`/projects/${projectId}/files`, missingModelOrSource);
  const [bootstrapFileId, setBootstrapFileId] = useState("");
  const versionsQuery = useApi(`/projects/${projectId}/files/${bootstrapFileId}/versions`, missingModelOrSource && !!bootstrapFileId);
  const projectFiles = useMemo(() => list(filesQuery.data, "files").filter((file) => /\.pdf$/i.test(String(file.name || "")) || String(file.mimeType || "").toLowerCase() === "application/pdf"), [filesQuery.data]);
  const automaticPlanProcessing = model.automaticPlanProcessing;
  const hasAutomaticWork = automaticPlanProcessing.length > 0;
  const automaticWorkActive = automaticPlanProcessing.some((item) => automaticProcessingActive(item.status));
  const automaticLookupPending = missingModelOrSource && filesQuery.isLoading;
  const hasUploadedPdfAwaitingModel = missingModelOrSource && !filesQuery.isLoading && projectFiles.length > 0;
  const needsBootstrap = missingModelOrSource && !automaticLookupPending && !automaticWorkActive && !hasAutomaticWork && !hasUploadedPdfAwaitingModel;
  const selectedBootstrapFile = projectFiles.find((file) => file.id === bootstrapFileId);
  const bootstrapVersions = useMemo(() => list(versionsQuery.data).filter((version) => version.status === undefined || version.status === "ready"), [versionsQuery.data]);
  const regions = pickRegions(model, state);
  const regionMatchesView = (region: BuildingRegion) => region.page === page
    && (!sourceStoreyId || region.storeyId === sourceStoreyId)
    && (!sourceVersionId || region.sourceVersionId === sourceVersionId);
  const selectedById = regions.find((region) => region.id === selectedId);
  // An entity-only link: the view moves to the entity's own plan page.
  const entityHref = (id: string) => {
    const next = new URLSearchParams(params);
    for (const key of ["page", "storey", "sourceVersion", "sourceSelection", "object"]) next.delete(key);
    next.set("entity", `element:${id}`);
    return `?${next.toString()}`;
  };
  const explicitPage = params.has("page");
  const selected = selectedById && (!explicitPage || regionMatchesView(selectedById)) ? selectedById : explicitPage ? regions.find(regionMatchesView) : regions[0];
  const candidates = useMemo(() => model.extractionCandidates.filter((candidate) => candidate.status === "unreviewed"), [model.extractionCandidates]);
  const selectedProposals = selected ? model.proposals.filter((proposal) => proposal.status === "pending" && proposal.targetEntityId === selected.id) : [];
  const entityDeepLink = isEntityDeepLink(params);
  const deepLinkedRegion = entityDeepLink && selectedById?.id === deepLinkedEntity ? selectedById : undefined;
  const currentSource = planSourceForSelection(model.planSources, { page, storeyId: sourceStoreyId, sourceVersionId, pinned: sourceSelectionPinned, selected,
    deepLinked: deepLinkedRegion }, automaticPlanProcessing);
  const sourceForEvidence = currentSource || model.planSources[0];
  const evidence = sourceForEvidence?.source ? { ...model.evidence, fileName: sourceForEvidence.source.fileName, sourceVersionId: sourceForEvidence.source.versionId, fileId: sourceForEvidence.source.fileId, version: sourceForEvidence.source.version, pdfUrl: sourceForEvidence.source.downloadUrl, pageCount: sourceForEvidence.pageCount || 1, layers: sourceForEvidence.layers?.map((layer, index) => ({ id: layer.id || String(index), label: layer.label || layer.name || String(layer.id || index), visible: layer.visible ?? layer.defaultVisible })) } : model.evidence;
  const stateCandidates = useMemo(() => candidatesForModelState(candidates, state), [candidates, state]);
  const sourceCandidates = useMemo(() => candidatesForSource(stateCandidates, page, sourceForEvidence?.source?.versionId, currentSource?.storeyId), [stateCandidates, page, sourceForEvidence?.source?.versionId, currentSource?.storeyId]);
  const hiddenWallCount = candidatesForSource(candidatesForModelState(candidates, "proposed"), page, sourceForEvidence?.source?.versionId, currentSource?.storeyId)
    .filter((candidate) => candidateRole(candidate) === "draft-wall" && !stateCandidates.includes(candidate)).length;
  const wallReviewParams = new URLSearchParams(params);
  wallReviewParams.set("modelState", "proposed");
  const selectedCandidate = sourceCandidates.find((candidate) => candidate.id === selectedCandidateId);
  const currentAutomaticProcessing = automaticPlanProcessing.find((item) => item.sourceVersionId === evidence.sourceVersionId);
  const currentAutomaticActive = automaticProcessingActive(currentAutomaticProcessing?.status);
  const sourceLayers = pdfLayers.length ? pdfLayers : evidence.layers || [];
  const sourceDocuments = useMemo(() => [...new Map(model.planSources.flatMap((source) => source.source?.versionId ? [[source.source.versionId, source]] : [])).values()], [model.planSources]);
  const allExtractions = model.extraction && !model.extractions.some((job) => job.id === model.extraction?.id) ? [...model.extractions, model.extraction] : model.extractions;
  const displayedExtraction = allExtractions.find((job) => job.sourceVersionId === sourceForEvidence?.source?.versionId && job.page === page && job.storeyId === currentSource?.storeyId);
  const activeExtraction = displayedExtraction as BuildingExtractionJob | undefined;
  const contextNeedsAttention = automaticWorkActive
    || activeExtraction?.status === "queued"
    || activeExtraction?.status === "running"
    || activeExtraction?.status === "failed";
  const pollingExtractionIds = allExtractions.filter((job) => job.status === "queued" || job.status === "running").map((job) => job.id).join(",");
  useEffect(() => {
    if (!pollingExtractionIds && !automaticWorkActive && !hasUploadedPdfAwaitingModel) return;
    const timer = window.setInterval(() => { void queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }); }, 2000);
    return () => window.clearInterval(timer);
  }, [pollingExtractionIds, automaticWorkActive, hasUploadedPdfAwaitingModel, projectId]);
  useEffect(() => {
    if (activeExtraction && (activeExtraction.status === "complete" || activeExtraction.status === "failed")) {
      void queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] });
    }
  }, [activeExtraction?.id, activeExtraction?.status, projectId]);
  const candidateVisible = (candidate: BuildingExtractionCandidate) => objectVisibility[candidate.id] ?? overlayBucketVisible(candidate, candidateOverlayVisibility);
  const visibleCandidates = sourceCandidates.filter(candidateVisible);
  const pageRegions = regionsForSource(regions, page, sourceForEvidence?.source?.versionId, currentSource?.storeyId);
  const visibleRegions = pageRegions.filter((region) => objectVisibility[region.id] ?? true);
  useEffect(() => {
    if (selectedCandidateId && !visibleCandidates.some((candidate) => candidate.id === selectedCandidateId)) setSelectedCandidateId(undefined);
  }, [selectedCandidateId, page, currentSource?.id, sourceForEvidence?.source?.versionId]);

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
    if (currentSource && page !== currentSource.page) setPage(currentSource.page);
    if (currentSource && sourceStoreyId !== (currentSource.storeyId || "")) setSourceStoreyId(currentSource.storeyId || "");
    if (currentSource?.source?.versionId && sourceVersionId !== currentSource.source.versionId) setSourceVersionId(currentSource.source.versionId);
  }, [selected?.id, selectedId, currentSource?.id, sourceStoreyId, sourceVersionId]);
  // Keep an entity-only deep link in the URL until the model has loaded and the view state has moved to its source page.
  const deepLinkPending = entityDeepLink && (modelQuery.isLoading || Boolean(deepLinkedRegion && currentSource && (page !== currentSource.page
    || sourceStoreyId !== (currentSource.storeyId || "") || (currentSource.source?.versionId && sourceVersionId !== currentSource.source.versionId))));
  useEffect(() => {
    if (deepLinkPending) return;
    const next = new URLSearchParams(params);
    next.set("modelState", state);
    next.set("page", String(page));
    if (selected?.id) next.set("entity", `${selected.entityType || "room"}:${selected.id}`);
    else next.delete("entity");
    if (sourceStoreyId) next.set("storey", sourceStoreyId);
    else next.delete("storey");
    if (sourceVersionId) next.set("sourceVersion", sourceVersionId);
    else next.delete("sourceVersion");
    if (sourceSelectionPinned) next.set("sourceSelection", "manual");
    else next.delete("sourceSelection");
    next.delete("object");
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [state, page, selected?.id, sourceStoreyId, sourceVersionId, sourceSelectionPinned, deepLinkPending]);

  const updateObject = useMutation({
    mutationFn: ({ id, entityType, body }: { id: string; entityType: string; body: RecordData }) =>
      modelApi(`/projects/${projectId}/building-model/${entityType}/${id}`, {
        ...body,
        baseRevision: model.revision,
      }, "PATCH"),
    onMutate: () => setConflict(undefined),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] });
    },
    onError: (error) => {
      setConflict(error instanceof ApiError && error.status === 409 ? t("buildingModelOptimisticConflict") : error.message);
    },
  });
  const createMeasurement = useMutation({
    mutationFn: ({ region, measurement, value }: { region: BuildingRegion; measurement: NonNullable<BuildingRegion["measurements"]>[number]; value: number }) => modelApi(`/projects/${projectId}/building-model/measurements`, { baseRevision: model.revision, entityType: region.entityType || "room", entityId: region.id, quantity: measurement.semanticQuantity || "distance", value, unit: measurement.unit || "m", method: measurement.method || "manual", uncertainty: measurement.uncertainty ?? null, evidence: measurement.evidence || [] }, "POST"),
    onMutate: () => setConflict(undefined),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }),
    onError: (error) => setConflict(error instanceof ApiError && error.status === 409 ? t("buildingModelOptimisticConflict") : error.message),
  });
  const saveComponentProperty = useMutation({
    mutationFn: ({ region, save }: { region: BuildingRegion; save: ComponentPropertySave }) => {
      const sourceVersion = region.sourceVersionId || evidence.sourceVersionId;
      return modelApi(`/projects/${projectId}/building-model/properties`, { baseRevision: model.revision, entityType: region.entityType || "room", entityId: region.id,
        propertyKey: save.key, value: save.value, unit: save.unit, provenance: "manual",
        evidence: sourceVersion ? [{ kind: "page", sourceVersionId: sourceVersion, page: region.page, ...(region.box ? { region: region.box } : {}) }] : [] });
    },
    onMutate: () => setConflict(undefined),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }),
    onError: (error) => setConflict(error instanceof ApiError && error.status === 409 ? t("buildingModelOptimisticConflict") : error.message),
  });
  const reviewComponentProperty = useMutation({
    mutationFn: ({ state, decision }: { state: BuildingComponentPropertyState; decision: "approved" | "rejected" }) =>
      modelApi(`/projects/${projectId}/building-model/properties/${state.propertyId}/versions/${state.version}/review`, { baseRevision: model.revision, reviewRevision: state.reviewRevision, decision }),
    onMutate: () => setConflict(undefined),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }),
    onError: (error) => setConflict(error instanceof ApiError && error.status === 409 ? t("buildingModelOptimisticConflict") : error.message),
  });
  const deriveWallRoles = useMutation({
    mutationFn: () => api<{ summary: { walls: number; exterior: number; roles: number; roleProposals: number; thicknessProposals: number; ceilings: number; windows: number; doors: number; adopted: number; ambiguous: number } }>(`/projects/${projectId}/building-model/wall-adjacency`, { baseRevision: model.revision }),
    onMutate: () => setConflict(undefined),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }),
    onError: (error) => setConflict(error instanceof ApiError && error.status === 409 ? t("buildingModelOptimisticConflict") : error.message),
  });
  const copyWallType = useMutation({
    mutationFn: ({ region, keys }: { region: BuildingRegion; keys: string[] }) => api<{ summary: { targets: number; updated: Record<string, number>; kept: number } }>(`/projects/${projectId}/building-model/component-copy`, { baseRevision: model.revision, sourceElementId: region.id, keys }),
    onMutate: () => setConflict(undefined),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }),
    onError: (error) => setConflict(error instanceof ApiError && error.status === 409 ? t("buildingModelOptimisticConflict") : error.message),
  });
  const reviewWallType = useMutation({
    mutationFn: (items: Array<{ propertyId: string; version: number; reviewRevision: number }>) => modelApi<{ reviewed: number; skipped: number }>(`/projects/${projectId}/building-model/properties/review`, { baseRevision: model.revision, decision: "approved", items }),
    onMutate: () => setConflict(undefined),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }),
    onError: (error) => setConflict(error instanceof ApiError && error.status === 409 ? t("buildingModelOptimisticConflict") : error.message),
  });
  // The agreed sound insulation level belongs to the building; it is a requirement, not an observation.
  const saveBuildingProperty = useMutation({
    mutationFn: ({ buildingId, save }: { buildingId: string; save: ComponentPropertySave }) => modelApi(`/projects/${projectId}/building-model/properties`, { baseRevision: model.revision,
      // Zoning check areas and the exterior noise assessment are observations of the site and building; everything else here is a requirement.
      entityType: "building", entityId: buildingId, propertyKey: save.key, claimKind: ["parcelArea", "footprintArea", "exteriorNoiseApplicability", "exteriorNoiseFlanking"].includes(save.key) ? "observed_fact" : "requirement", value: save.value, unit: save.unit, provenance: "manual", evidence: [] }),
    onMutate: () => setConflict(undefined),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }),
    onError: (error) => setConflict(error instanceof ApiError && error.status === 409 ? t("buildingModelOptimisticConflict") : error.message),
  });
  const [colorWallRoles, setColorWallRoles] = useState(false);
  const [soundOpen, setSoundOpen] = useState(false);
  const componentSources = useApi(`/projects/${projectId}/building-model/component-sources`, soundOpen);
  const inquiries = useApi(`/projects/${projectId}/inquiries`, soundOpen);
  const createInquiry = useMutation({
    mutationFn: (input: { counterpart: string; body: string }) => api(`/projects/${projectId}/inquiries`, { kind: "component_data", title: t("buildingRequestTitle"), counterpart: input.counterpart,
      request: { subject: t("buildingRequestTitle"), body: input.body } }),
    onMutate: () => setConflict(undefined),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/inquiries`] }),
    onError: (error) => setConflict(error.message),
  });
  const readBebauungsplan = useMutation({
    mutationFn: (sourceVersionId: string) => api<{ summary: BebauungsplanReadResult }>(`/projects/${projectId}/building-model/regulatory-sources`, { baseRevision: model.revision, sourceVersionId }),
    onMutate: () => setConflict(undefined),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }),
    onError: (error) => setConflict(error instanceof ApiError && error.status === 409 ? t("buildingModelOptimisticConflict") : error.message),
  });
  const readDescription = useMutation({
    mutationFn: (sourceVersionId: string) => api<{ summary: DescriptionReadResult }>(`/projects/${projectId}/building-model/component-sources`, { baseRevision: model.revision, sourceVersionId }),
    onMutate: () => setConflict(undefined),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }),
    onError: (error) => setConflict(error instanceof ApiError && error.status === 409 ? t("buildingModelOptimisticConflict") : error.message),
  });
  const saveStoreyLevel = useMutation({
    mutationFn: ({ storeyId, level }: { storeyId: string; level: number | null }) => modelApi(`/projects/${projectId}/building-model/properties`, { baseRevision: model.revision,
      entityType: "storey", entityId: storeyId, propertyKey: "level", value: level, unit: null, provenance: "manual", evidence: [] }),
    onMutate: () => setConflict(undefined),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }),
    onError: (error) => setConflict(error instanceof ApiError && error.status === 409 ? t("buildingModelOptimisticConflict") : error.message),
  });
  const saveStoreyProperty = useMutation({
    mutationFn: ({ storeyId, save }: { storeyId: string; save: ComponentPropertySave }) => modelApi(`/projects/${projectId}/building-model/properties`, { baseRevision: model.revision,
      entityType: "storey", entityId: storeyId, propertyKey: save.key, value: save.value, unit: save.unit, provenance: "manual", evidence: [] }),
    onMutate: () => setConflict(undefined),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }),
    onError: (error) => setConflict(error instanceof ApiError && error.status === 409 ? t("buildingModelOptimisticConflict") : error.message),
  });
  const storeyNames = useMemo(() => new Map(model.storeys.map((storey) => {
    const state = storey.componentProperties?.level;
    const level = state && state.reviewStatus !== "rejected" && typeof state.value === "number" ? state.value : storey.levelIndex ?? null;
    return [storey.id, level === null ? storey.name || storey.id : `${storeyLevelLabel(level, t)} · ${storey.name || storey.id}`];
  })), [model, t]);
  const modelComponents = useMemo(() => [...new Map(Object.values(model.states).flat().filter((region) => region.entityType === "element" && regionComponentType(region)).map((region) => [region.id, region])).values()], [model]);
  const soundChecks = useMemo(() => { const checks = soundInsulationChecks(modelComponents.map(componentRecord)); return { total: checks.length, ready: checks.filter((check) => check.ready).length }; }, [modelComponents]);
  const modelWalls = useMemo(() => [...new Map(Object.values(model.states).flat().filter((region) => region.entityType === "element" && regionComponentType(region) === "wall").map((region) => [region.id, region])).values()], [model]);
  const wallRoles = useMemo(() => new Map(Object.values(model.states).flat().filter((region) => region.entityType === "element").map((region) => {
    const role = region.componentProperties?.wallRole;
    return [region.id, role && role.reviewStatus !== "rejected" ? role.value : role?.reviewedValue ?? null] as const;
  })), [model]);
  const roomNames = useMemo(() => new Map(Object.values(model.states).flat().filter((region) => region.entityType === "room").map((region) => [region.id, region.label])), [model]);
  const elementNames = useMemo(() => new Map(Object.values(model.states).flat().filter((region) => region.entityType === "element").map((region) => [region.id, region.label])), [model]);
  const startExtraction = useMutation({
    mutationFn: () => {
      if (!evidence.sourceVersionId || !currentSource?.storeyId) throw new Error(t("buildingModelExtractionSourceRequired"));
      return api<RecordData>(`/projects/${projectId}/building-model/extractions`, {
        sourceVersionId: evidence.sourceVersionId,
        page: currentSource.page,
        storeyId: currentSource.storeyId,
        baseRevision: model.revision,
      });
    },
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }),
    onError: (error) => setConflict(error instanceof Error ? error.message : String(error)),
  });
  const supersedePlanSet = useMutation({
    mutationFn: ({ sourceVersionId, supersededByVersionId }: { sourceVersionId: string; supersededByVersionId: string | null }) =>
      api<RecordData>(`/projects/${projectId}/building-model/superseded-sources/${sourceVersionId}`,
        supersededByVersionId ? { baseRevision: model.revision, supersededByVersionId } : { baseRevision: model.revision }, supersededByVersionId ? "PUT" : "DELETE"),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }),
    onError: (error) => setConflict(error instanceof Error ? error.message : String(error)),
  });
  const saveColourLegend = useMutation({
    mutationFn: ({ sourceVersionId, entries }: { sourceVersionId: string; entries: WallColourEntry[] }) =>
      api<RecordData>(`/projects/${projectId}/building-model/colour-legends/${sourceVersionId}`, { baseRevision: model.revision, entries }, "PUT"),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }),
    onError: (error) => setConflict(error instanceof Error ? error.message : String(error)),
  });
  const savePlanScale = useMutation({
    mutationFn: ({ sourceVersionId, denominator }: { sourceVersionId: string; denominator: number | null }) =>
      api<RecordData>(`/projects/${projectId}/building-model/plan-scales/${sourceVersionId}`, { baseRevision: model.revision, denominator }, "PUT"),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }),
    onError: (error) => setConflict(error instanceof Error ? error.message : String(error)),
  });
  const reviewCandidate = useMutation({
    mutationFn: ({ candidateId, body }: { candidateId: string; body: RecordData }) => api(`/projects/${projectId}/building-model/extraction-candidates/${candidateId}/review`, { ...body, baseRevision: model.revision }, "POST"),
    onSuccess: async () => {
      setSelectedCandidateId(undefined);
      await queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] });
    },
    onError: (error) => setConflict(error instanceof Error ? error.message : String(error)),
  });
  const candidateKey = (candidate: BuildingExtractionCandidate) => candidate.candidateId || candidate.id.replace(/^candidate:/, "");
  const mergeRooms = useMutation({
    mutationFn: (candidateIds: string[]) => api<RecordData>(`/projects/${projectId}/building-model/room-merges`, { baseRevision: model.revision, candidateIds }, "POST"),
    onMutate: () => setConflict(undefined),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] });
      setSelectedId(undefined); setSelectedCandidateId(`candidate:${data.entityId}`);
    },
    onError: (error) => setConflict(error instanceof ApiError && error.status === 409 ? t("buildingModelOptimisticConflict") : error.message),
  });
  const splitRoom = useMutation({
    mutationFn: (candidateId: string) => api<RecordData>(`/projects/${projectId}/building-model/room-merges/${candidateId}/split`, { baseRevision: model.revision }, "POST"),
    onMutate: () => setConflict(undefined),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }),
    onError: (error) => setConflict(error instanceof ApiError && error.status === 409 ? t("buildingModelOptimisticConflict") : error.message),
  });
  const pageScale = (magicPageScale(outlineSession) ?? activeExtraction?.result?.pageScale ?? null) as PageScale | null;
  useEffect(() => { setOutlineSession(null); setMagicNotice(undefined); setMeasurePoints([]); }, [page, sourceForEvidence?.source?.versionId]);
  const updateOutline = (update: (session: OutlineSession) => OutlineSession) => setOutlineSession((current) => current ? update(current) : current);
  const beginOutlineChange = () => updateOutline((session) => ({ ...session, history: [...session.history.slice(-49), session.draft], future: [] }));
  const undoOutline = () => updateOutline((session) => session.history.length ? { ...session, draft: session.history[session.history.length - 1]!, history: session.history.slice(0, -1), future: [session.draft, ...session.future] } : session);
  const redoOutline = () => updateOutline((session) => session.future.length ? { ...session, draft: session.future[0]!, history: [...session.history, session.draft], future: session.future.slice(1) } : session);
  const startOutlineEdit = (region: BuildingRegion) => {
    const polygon = region.polygon && region.polygon.length >= 3 ? region.polygon : region.box ? rectangleAround(region.box) : null;
    if (!polygon) return;
    const target = outlineTarget(region);
    setPlanTool("select");
    setMagicNotice(undefined);
    setOutlineSession({ target, targets: [target], draft: { polygon, holes: region.polygon?.length ? region.holes ?? [] : [] }, method: "manual", name: "", history: [], future: [] });
  };
  const magicSelect = useMutation({
    mutationFn: (point: BuildingPlanPoint) => api<RecordData>(`/projects/${projectId}/building-model/magic-selection`, { sourceVersionId: evidence.sourceVersionId, page, point }),
    onMutate: () => setMagicNotice(undefined),
    onSuccess: (data, point) => {
      if (data.status !== "found" || !Array.isArray(data.options) || !data.options.length) {
        setMagicNotice(t(data.status === "on_barrier" ? "buildingModelMagicOnBarrier" : "buildingModelMagicNotEnclosed"));
        return;
      }
      const options = data.options as MagicOutline[];
      const targets = outlineTargetsAt([...pageRegions, ...sourceCandidates], point, options[0]!.polygon, selectedCandidate?.id || selected?.id);
      setOutlineSession({ target: targets[0]!, targets, draft: { polygon: options[0]!.polygon, holes: options[0]!.holes }, method: "magic_selection",
        magic: { point, options, index: 0, scale: data.scale as PageScale | null }, name: "", history: [], future: [] });
    },
    onError: (error) => setMagicNotice(error instanceof ApiError && error.status === 404 ? t("buildingModelMagicUnavailable") : error.message),
  });
  const saveOutline = useMutation({
    mutationFn: (session: OutlineSession) => {
      const target = session.target.type === "new_room"
        ? { type: "new_room", storeyId: currentSource?.storeyId, sourceVersionId: evidence.sourceVersionId, page, name: session.name.trim() }
        : session.target.type === "room" ? { type: "room", id: session.target.id, sourceVersionId: evidence.sourceVersionId, page } : { type: "candidate", id: session.target.id };
      const proposal = session.magic?.options[session.magic.index];
      return api<RecordData>(`/projects/${projectId}/building-model/outline-edits`, { baseRevision: model.revision, target, polygon: session.draft.polygon, holes: session.draft.holes,
        method: session.method, ...(session.magic && proposal ? { magic: { point: session.magic.point, polygon: proposal.polygon, holes: proposal.holes } } : {}) });
    },
    onMutate: () => setConflict(undefined),
    onSuccess: async (data) => {
      setOutlineSession(null);
      await queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] });
      if (data.entityType === "candidate") { setSelectedId(undefined); setSelectedCandidateId(`candidate:${data.entityId}`); }
      else { setSelectedCandidateId(undefined); setSelectedId(String(data.entityId)); }
    },
    onError: (error) => setConflict(error instanceof ApiError && error.status === 409 ? t("buildingModelOptimisticConflict") : error.message),
  });
  const inspectedRegion = selectedCandidate || selected;
  const canEditOutline = Boolean(inspectedRegion && inspectedRegion.entityType !== "element" && inspectedRegion.kind !== "element" && inspectedRegion.page === page
    && (inspectedRegion.polygon?.length || inspectedRegion.box));
  const referenceParams = new URLSearchParams({ view: "building-model", entity: `${selected?.entityType || "room"}:${selected?.id || ""}`, modelState: state, page: String(page), sourceSelection: "manual" });
  if (sourceVersionId) referenceParams.set("sourceVersion", sourceVersionId);
  if (sourceStoreyId) referenceParams.set("storey", sourceStoreyId);
  const referenceHref = `/projects/${projectId}?${referenceParams.toString()}`;

  if (needsBootstrap) {
    return <BuildingModelBootstrap
      projectId={projectId}
      modelRevision={model.revision || 0}
      files={projectFiles}
      fileId={bootstrapFileId}
      onFileId={setBootstrapFileId}
      versions={bootstrapVersions}
      filesLoading={filesQuery.isLoading || versionsQuery.isLoading}
      error={modelError || filesQuery.error || versionsQuery.error}
      onComplete={async (sourcePage) => {
        await queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] });
        setSourceSelectionPinned(true);
        setPage(sourcePage);
      }}
      t={t}
    />;
  }


  if (missingModelOrSource && (automaticLookupPending || hasAutomaticWork || hasUploadedPdfAwaitingModel)) {
    return <AutomaticBuildingModelPreparation
      projectId={projectId}
      processing={automaticPlanProcessing}
      files={projectFiles}
      filesLoading={filesQuery.isLoading}
      manualFallback={<BuildingModelBootstrap
        projectId={projectId}
        modelRevision={model.revision || 0}
        files={projectFiles}
        fileId={bootstrapFileId}
        onFileId={setBootstrapFileId}
        versions={bootstrapVersions}
        filesLoading={filesQuery.isLoading || versionsQuery.isLoading}
        error={filesQuery.error || versionsQuery.error}
        onComplete={async (sourcePage) => { await queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }); setSourceSelectionPinned(true); setPage(sourcePage); }}
        t={t}
      />}
      t={t}
    />;
  }

  const selectRegion = (id: string) => {
    const region = regions.find((item) => item.id === id);
    setSelectedCandidateId(undefined);
    setSelectedId(id);
    setSourceSelectionPinned(true);
    if (region) {
      setSourceVersionId(region.sourceVersionId || "");
      setSourceStoreyId(region.storeyId || "");
      setPage(model.planSources.find((source) => source.storeyId && source.storeyId === region.storeyId
        && (!region.sourceVersionId || source.source?.versionId === region.sourceVersionId))?.page || region.page);
    }
  };
  const selectSourcePage = (nextPage: number, nextVersion = "", nextStorey = "") => {
    setSelectedId(undefined);
    setSelectedCandidateId(undefined);
    setSourceSelectionPinned(true);
    setSourceVersionId(nextVersion);
    setSourceStoreyId(nextStorey);
    setPage(nextPage);
  };

  const selectCandidate = (candidate: BuildingExtractionCandidate) => {
    setSelectedId(undefined);
    setSelectedCandidateId(candidate.id);
    setSourceSelectionPinned(true);
    if (!candidateVisible(candidate)) setObjectVisibility((current) => ({ ...current, [candidate.id]: true }));
    setSourceVersionId(candidate.sourceVersionId || "");
    setSourceStoreyId(candidate.storeyId || "");
    setPage(candidate.page);
  };
  const setVisible = (items: BuildingRegion[], visible: boolean) => setObjectVisibility((current) => ({ ...current, ...Object.fromEntries(items.map((item) => [item.id, visible])) }));
  const regionVisible = (region: BuildingRegion) => region.isCandidate ? candidateVisible(region as BuildingExtractionCandidate) : objectVisibility[region.id] ?? true;

  // Outliner: the shown storey's rooms by apartment group, construction by overlay category, other pages, PDF layers.
  const isRoom = (region: BuildingRegion) => region.entityType !== "element" && region.kind !== "element";
  const roomGroups = new Map<string, BuildingRegion[]>();
  for (const region of [...pageRegions.filter(isRoom), ...sourceCandidates.filter(isRoom)]) {
    const key = region.groupLabel || "";
    roomGroups.set(key, [...(roomGroups.get(key) || []), region]);
  }
  const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, undefined, { numeric: true });
  const outlinerGroups = [...roomGroups.entries()].sort(([a], [b]) => (a ? 0 : 1) - (b ? 0 : 1) || a.localeCompare(b, undefined, { numeric: true }))
    .map(([key, items]) => ({ key: `group:${key}`, label: key || t("buildingModelUngroupedCandidates"), items: [...items].sort(byLabel) }));
  const categoryLabels: Record<ReturnType<typeof candidateOverlayBucket>, string> = { draftWalls: t("buildingModelDraftWalls"), assemblies: t("buildingModelConstructionAssemblies"), footprints: t("buildingModelRawFootprints"), unresolvedAnchors: t("buildingModelUnresolvedAnchors"), roomHypotheses: t("buildingModelRoomHypotheses") };
  const outlinerCategories = (["draftWalls", "assemblies", "footprints", "unresolvedAnchors", "roomHypotheses"] as const).map((bucket): OutlinerNode => {
    const items = sourceCandidates.filter((candidate) => !isRoom(candidate) && candidateOverlayBucket(candidate) === bucket);
    return { key: `category:${bucket}`, label: categoryLabels[bucket], items, visible: overlayBucketVisible({ entityType: bucket === "roomHypotheses" ? "room" : "element", geometryQuality: { draftWalls: "draft_wall", assemblies: "assembly", footprints: "footprint", unresolvedAnchors: "anchor", roomHypotheses: "enclosed_region" }[bucket], semanticType: bucket === "draftWalls" ? "draft_wall" : null } as BuildingExtractionCandidate, candidateOverlayVisibility),
      onVisible: (visible: boolean) => { setCandidateOverlayVisibility((current) => ({ ...current, [bucket]: visible })); setObjectVisibility((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !items.some((item) => item.id === id)))); } };
  }).filter((category) => category.items.length);
  const acceptedElements = pageRegions.filter((region) => !isRoom(region));
  if (acceptedElements.length) outlinerCategories.unshift({ key: "category:elements", label: t("buildingModelAcceptedElements"), items: acceptedElements, visible: acceptedElements.some(regionVisible), onVisible: (visible) => setVisible(acceptedElements, visible) });
  const otherPageRegions = regions.filter((region) => !pageRegions.includes(region));
  const storeyLabel = model.storeys.find((storey) => storey.id === currentSource?.storeyId)?.name || `${t("buildingModelPage")} ${page}`;
  // Every storey of the shown plan set (and any storey with rooms), top floor first; the shown one is expanded.
  const planSetVersion = sourceForEvidence?.source?.versionId;
  const outlinerStoreys: OutlinerStorey[] = model.storeys.flatMap((storey) => {
    const source = model.planSources.find((item) => item.storeyId === storey.id && item.source?.versionId === planSetVersion) || model.planSources.find((item) => item.storeyId === storey.id);
    const current = storey.id === currentSource?.storeyId;
    const items = current ? [] : [...otherPageRegions.filter((region) => region.storeyId === storey.id && isRoom(region)),
      ...stateCandidates.filter((candidate) => candidate.storeyId === storey.id && isRoom(candidate) && candidate.kind !== "unknown-room" && (!planSetVersion || candidate.sourceVersionId === planSetVersion))].sort(byLabel);
    if (!current && !source && !items.length) return [];
    const state = storey.componentProperties?.level;
    const level = state && state.reviewStatus !== "rejected" && typeof state.value === "number" ? state.value : storey.levelIndex ?? null;
    return [{ id: storey.id, label: storeyNames.get(storey.id) ?? storey.name ?? storey.id, level, current, page: source?.page ?? null, items,
      onOpen: source && !current ? () => selectSourcePage(source.page, source.source?.versionId || "", storey.id) : undefined }];
  }).sort((a, b) => (b.level ?? -1e3) - (a.level ?? -1e3) || (a.page ?? 0) - (b.page ?? 0));
  if (!outlinerStoreys.some((storey) => storey.current)) outlinerStoreys.unshift({ id: "page", label: storeyLabel, level: null, current: true, page, items: [] });
  const listedStoreys = new Set(outlinerStoreys.map((storey) => storey.id));
  const unlistedRegions = otherPageRegions.filter((region) => !region.storeyId || !listedStoreys.has(region.storeyId));
  const areaOf = (region: BuildingRegion) => region.polygon && region.polygon.length >= 3 ? outlineAreaM2({ polygon: region.polygon, holes: region.holes ?? [] }, pageScale) : null;

  // Properties, status bar and keys.
  const sessionRegionId = outlineSession && outlineSession.target.type !== "new_room" ? outlineSession.target.regionId : undefined;
  const showInspector = !outlineSession || sessionRegionId === inspectedRegion?.id;
  const geometryDraft = outlineSession?.draft ?? (inspectedRegion?.polygon && inspectedRegion.polygon.length >= 3 ? { polygon: inspectedRegion.polygon, holes: inspectedRegion.holes ?? [] } : null);
  const geometryPrinted = outlineSession ? (outlineSession.target.type === "new_room" ? null : outlineSession.target.sourceArea) : inspectedRegion?.sourceArea;
  const canCreateRoom = Boolean(currentSource?.storeyId && evidence.sourceVersionId);
  const outlineBlocked = outlineSession ? outlineSelfIntersects(outlineSession.draft.polygon) || (outlineSession.target.type === "new_room" && (!outlineSession.name.trim() || !canCreateRoom)) : true;
  const canSaveOutline = Boolean(outlineSession) && !outlineBlocked && !saveOutline.isPending;
  const candidateEdit = selectedCandidate ? candidateEdits[selectedCandidate.id] ?? {} : {};
  const reviewSelected = (decision: "approved" | "rejected") => {
    if (!selectedCandidate || reviewCandidate.isPending) return;
    const name = candidateEdit.name?.trim();
    const correction = decision === "approved" ? { ...(name && name !== selectedCandidate.label ? { name } : {}), ...(candidateEdit.targetEntityId ? { targetEntityId: candidateEdit.targetEntityId } : {}) } : {};
    reviewCandidate.mutate({ candidateId: selectedCandidate.candidateId || selectedCandidate.id.replace(/^candidate:/, ""), body: { decision, ...correction } });
  };
  const editVertex = (index: number, point: BuildingPlanPoint) => {
    const move = (draft: OutlineDraft) => ({ ...draft, polygon: draft.polygon.map((current, i) => i === index ? point : current) });
    if (outlineSession) { beginOutlineChange(); updateOutline((session) => ({ ...session, draft: move(session.draft) })); return; }
    if (!inspectedRegion?.polygon || inspectedRegion.polygon.length < 3) return;
    const target = outlineTarget(inspectedRegion), draft = { polygon: inspectedRegion.polygon, holes: inspectedRegion.holes ?? [] };
    setOutlineSession({ target, targets: [target], draft: move(draft), method: "manual", name: "", history: [draft], future: [] });
  };
  const chooseTool = (tool: PlanTool | "edit") => {
    setMagicNotice(undefined);
    if (tool === "edit") { if (!outlineSession && canEditOutline && inspectedRegion) { if (planTool !== "pan") setPlanTool("select"); startOutlineEdit(inspectedRegion); } return; }
    if (outlineSession && tool !== "pan" && tool !== "select") return;
    setPlanTool(tool);
    if (tool !== "measure") setMeasurePoints([]);
  };
  const zoomBy = (delta: number) => setViewerTransform((current) => {
    const zoom = Math.min(4, Math.max(1, current.zoom + delta));
    return { zoom, pan: { x: current.pan.x * zoom / current.zoom, y: current.pan.y * zoom / current.zoom } };
  });
  workbenchKeys.current = (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (event.defaultPrevented || target?.closest("[role=dialog], [data-slot=popover-content]")) return;
    const typing = Boolean(target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)));
    const modifier = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      if (outlineSession) setOutlineSession(null);
      else if (measurePoints.length) setMeasurePoints([]);
      else if (planTool !== "select") { setPlanTool("select"); setMagicNotice(undefined); }
      return;
    }
    if (typing) return;
    if (modifier && outlineSession && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) {
      event.preventDefault();
      if (event.shiftKey || event.key.toLowerCase() === "y") redoOutline(); else undoOutline();
      return;
    }
    if (modifier || event.altKey) return;
    if (event.key === "Enter") {
      // Enter keeps its native meaning on links and buttons, except outliner rows, plan regions and outline points.
      if (target && (target.tagName === "A" || target.tagName === "BUTTON") && !target.closest("[data-workbench-enter], .building-model-region, .building-model-outline-editor")) return;
      if (outlineSession) { if (canSaveOutline) { event.preventDefault(); saveOutline.mutate(outlineSession); } }
      else if (selectedCandidate) { event.preventDefault(); reviewSelected("approved"); }
      return;
    }
    const tool = toolKeys[event.key.toLowerCase()];
    if (tool && !event.repeat) { event.preventDefault(); chooseTool(tool); }
  };

  const tools = [
    { value: "select", key: "V", Icon: MousePointer2, label: t("buildingModelToolSelect"), disabled: false },
    { value: "magic", key: "W", Icon: WandSparkles, label: t("buildingModelToolMagic"), disabled: !evidence.sourceVersionId || Boolean(outlineSession) },
    { value: "edit", key: "E", Icon: Spline, label: t("buildingModelToolEdit"), disabled: !outlineSession && !canEditOutline },
    { value: "pan", key: "H", Icon: Hand, label: t("buildingModelToolPan"), disabled: false },
    { value: "measure", key: "M", Icon: Ruler, label: t("buildingModelToolMeasure"), disabled: Boolean(outlineSession) },
  ] as const;
  const activeTool = outlineSession && planTool !== "pan" ? "edit" : planTool;
  const measureDistance = measurePoints.length === 2 ? planDistanceM(measurePoints[0]!, measurePoints[1]!, pageScale) : null;
  const measureLabel = measurePoints.length === 2 ? measureDistance == null ? t("buildingModelOutlineNoScale") : `${measureDistance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m` : undefined;
  const targetName = (target: OutlineTarget) => target.type === "new_room" ? t("buildingModelOutlineNewRoom") : target.label;
  const kindLabel = (region: BuildingRegion) => region.kind === "unknown-room" ? t("buildingModelUnknownRoom") : region.kind === "element" ? t("buildingModelElement") : t("buildingModelOutlineRoom");
  const summary = (outlineSession ? [targetName(outlineSession.target), t("buildingModelEditingOutline")]
    : planTool === "measure" ? [t("buildingModelToolMeasure"), measureLabel ?? t("buildingModelMeasureHint")]
    : selectedCandidate ? [selectedCandidate.label, t("buildingModelUnreviewedCandidate"), selectedCandidate.groupLabel, `${t("buildingModelPage")} ${selectedCandidate.page}`]
    : selected ? [selected.label, kindLabel(selected), selected.groupLabel, `${t("buildingModelPage")} ${selected.page}`]
    : [t("buildingModelSelectObject")]).filter(Boolean);
  const hints: Array<[string, string]> = outlineSession ? [[t("buildingModelKeyDrag"), t("buildingModelHintMovePoint")], ["Alt", t("buildingModelHintNoSnap")], ["Del", t("buildingModelHintRemovePoint")], ["⌘Z", t("buildingModelUndo")], ["Esc", t("cancel")]]
    : planTool === "magic" ? [[t("buildingModelKeyClick"), t("buildingModelMagicHint")], ["Esc", t("buildingModelToolSelect")]]
    : planTool === "measure" ? [[t("buildingModelKeyClick"), t("buildingModelMeasureHint")], ["Esc", t("buildingModelMeasureClear")]]
    : selectedCandidate ? [["E", t("buildingModelEditOutline")], ["W", t("buildingModelToolMagic")]]
    : [["V", t("buildingModelToolSelect")], ["W", t("buildingModelToolMagic")], ["H", t("buildingModelToolPan")], ["M", t("buildingModelToolMeasure")]];
  const pageNumbers = model.planSources.length ? [...new Set(model.planSources.filter((source) => !evidence.sourceVersionId || source.source?.versionId === evidence.sourceVersionId).map((source) => source.page))] : [1];
  const extractionActive = activeExtraction?.status === "queued" || activeExtraction?.status === "running";
  const contextStatus = currentAutomaticActive ? automaticPhaseLabel(currentAutomaticProcessing, t) : contextExtractionStatus(activeExtraction?.status, t);
  const geometry = <GeometrySection draft={geometryDraft} scale={pageScale} printed={geometryPrinted} editing={Boolean(outlineSession)} snap={snapToWalls} onSnap={setSnapToWalls}
    onEditVertex={editVertex} canEdit={canEditOutline} onEdit={() => chooseTool("edit")} t={t} />;

  return (
    <div className="building-model is-workbench">
      <div className="building-model-toolbar" role="toolbar" aria-label={t("buildingModelControls")}>
        <Button variant="ghost" size="icon-sm" type="button" className="building-model-panel-toggle" aria-label={t("buildingModelOutliner")} title={t("buildingModelOutliner")} aria-pressed={panels.outliner} onClick={() => setPanels((current) => ({ ...current, outliner: !current.outliner }))}><PanelLeft className="size-icon-sm" aria-hidden="true" /></Button>
        <Button variant="ghost" size="icon-sm" type="button" className="building-model-panel-toggle" aria-label={t("buildingModelProperties")} title={t("buildingModelProperties")} aria-pressed={panels.properties} onClick={() => setPanels((current) => ({ ...current, properties: !current.properties }))}><PanelRight className="size-icon-sm" aria-hidden="true" /></Button>
        <div className="building-model-toolbar-source">
          <FileText className="size-icon-sm" aria-hidden="true" />
          {sourceDocuments.length > 1 ? <NativeSelect className="building-model-source-select" aria-label={t("buildingModelSourceDocument")} value={evidence.sourceVersionId || ""} onChange={(event) => {
            const versionSources = model.planSources.filter((source) => source.source?.versionId === event.target.value);
            const nextSource = preferredPlanSource(versionSources, automaticPlanProcessing) || versionSources[0];
            if (nextSource) selectSourcePage(nextSource.page, nextSource.source?.versionId || "", nextSource.storeyId || "");
          }}>{sourceDocuments.map((source) => <option key={source.source!.versionId} value={source.source!.versionId}>{source.source!.fileName}</option>)}</NativeSelect> : <strong title={evidence.fileName}>{evidence.fileName || t("buildingModelNoSource")}</strong>}
        </div>
        <Segmented value={state} onChange={(value) => setModelState(value as BuildingModelState)}
          items={states.map((item) => ({ value: item.value, label: t(`buildingModelState${item.value[0].toUpperCase()}${item.value.slice(1)}` as keyof typeof import("../../locales/en.json")) }))} />
        <div className="building-model-pages" aria-label={t("buildingModelPages")}>
          {pageNumbers.map((pageNumber) => {
            const source = model.planSources.find((item) => item.source?.versionId === evidence.sourceVersionId && item.page === pageNumber);
            const processing = automaticPlanProcessing.find((item) => item.sourceVersionId === source?.source?.versionId);
            const disposition = automaticPageDisposition(processing, pageNumber);
            const dispositionLabel = t(disposition === "floor_plan" ? "buildingModelPageFloorPlan" : disposition === "non_floor_plan" ? "buildingModelPageNonPlan" : "buildingModelPageUnresolved");
            return <button key={`${source?.source?.versionId || "source"}-${pageNumber}`} type="button" className={`is-${disposition.replaceAll("_", "-")}`} aria-label={`${t("buildingModelPage")} ${pageNumber} · ${dispositionLabel}`} title={dispositionLabel} aria-pressed={page === pageNumber} onClick={() => selectSourcePage(pageNumber, source?.source?.versionId || "", source?.storeyId || "")}>{pageNumber}</button>;
          })}
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="building-model-context-trigger" aria-label={`${t("buildingModelContext")}: ${contextStatus}`} title={t("buildingModelContext")}>
              {(currentAutomaticActive || extractionActive) && <LoaderCircle className="size-icon-sm animate-spin" aria-hidden="true" />}
              {activeExtraction?.status === "failed" && <span className="building-model-attention-dot" aria-hidden="true" />}
              <span aria-live="polite">{contextStatus}</span>
              <ChevronDown className="size-icon-sm" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="building-model-context-popover">
            <h2 className="building-model-panel-title">{t("buildingModelContext")}</h2>
            <ExtractionPanel
              job={activeExtraction}
              coverage={activeExtraction?.result?.coverage ? { note: activeExtraction.result.coverage } : model.extractionCoverage}
              source={currentSource}
              storeys={model.storeys}
              selectedStoreyId={sourceStoreyId || currentSource?.storeyId || ""}
              onStorey={(value) => { const source = model.planSources.find((item) => item.storeyId === value); if (source) selectSourcePage(source.page, source.source?.versionId || "", value); else { setSelectedId(undefined); setSelectedCandidateId(undefined); setSourceSelectionPinned(true); setSourceStoreyId(value); } }}
              canStart={Boolean(evidence.sourceVersionId && currentSource?.storeyId)}
              pending={startExtraction.isPending}
              onStart={() => startExtraction.mutate()}
              t={t}
            />
            {automaticPlanProcessing.length > 0 && <AutomaticPlanCoverage processing={automaticPlanProcessing} sources={model.planSources} storeys={model.storeys} selectedPage={page} selectedSourceVersionId={sourceForEvidence?.source?.versionId} onPage={({ page: nextPage, sourceVersionId: nextVersion, storeyId }) => selectSourcePage(nextPage, nextVersion, storeyId || "")}
              superseded={model.supersededSources} pending={supersedePlanSet.isPending}
              onSupersede={(sourceVersionId, supersededByVersionId) => supersedePlanSet.mutate({ sourceVersionId, supersededByVersionId })}
              onRestore={(sourceVersionId) => supersedePlanSet.mutate({ sourceVersionId, supersededByVersionId: null })}
              colourPending={saveColourLegend.isPending} onSaveColours={(sourceVersionId, entries) => saveColourLegend.mutate({ sourceVersionId, entries })}
              scalePending={savePlanScale.isPending} onSaveScale={(sourceVersionId, denominator) => savePlanScale.mutate({ sourceVersionId, denominator })} t={t} />}
          </PopoverContent>
        </Popover>
        <Popover open={soundOpen} onOpenChange={setSoundOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="building-model-context-trigger" aria-label={`${t("buildingSoundInsulation")}: ${t("buildingSoundChecksShort").replace("{ready}", String(soundChecks.ready)).replace("{total}", String(soundChecks.total))}`} title={t("buildingSoundInsulation")}>
              <AudioLines className="size-icon-sm" aria-hidden="true" />
              <span>{t("buildingSoundInsulation")} · {t("buildingSoundChecksShort").replace("{ready}", String(soundChecks.ready)).replace("{total}", String(soundChecks.total))}</span>
              <ChevronDown className="size-icon-sm" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="building-model-context-popover building-model-sound-popover">
            {model.buildings[0] && <>
              <h2 className="building-model-panel-title">{t("buildingRegulatoryBasis")}</h2>
              <RegulatoryBasis properties={model.buildings[0].componentProperties} t={t} pending={saveBuildingProperty.isPending || reviewComponentProperty.isPending}
                onSave={(save) => saveBuildingProperty.mutate({ buildingId: model.buildings[0].id, save })} onReview={(state, decision) => reviewComponentProperty.mutate({ state, decision })} />
              <BebauungsplanReader documents={((componentSources.data as { documents?: ComponentSourceDocument[] } | undefined)?.documents) ?? []} t={t} pending={readBebauungsplan.isPending}
                result={readBebauungsplan.data?.summary} onRead={(sourceVersionId) => readBebauungsplan.mutate(sourceVersionId)} />
              {model.buildings[0].componentProperties.bebauungsplan?.value === "applies" && model.buildings[0].componentProperties.bebauungsplan.reviewStatus !== "rejected" && <>
                <h2 className="building-model-panel-title">{t("buildingZoningCheck")}</h2>
                <ZoningCheck model={model} storeyLabel={(storeyId) => storeyNames.get(storeyId) ?? storeyId} t={t}
                  pending={saveBuildingProperty.isPending || saveStoreyProperty.isPending || reviewComponentProperty.isPending}
                  onSaveBuilding={(buildingId, save) => saveBuildingProperty.mutate({ buildingId, save })} onSaveStorey={(storeyId, save) => saveStoreyProperty.mutate({ storeyId, save })}
                  onReview={(state, decision) => reviewComponentProperty.mutate({ state, decision })} />
              </>}
            </>}
            <h2 className="building-model-panel-title">{t("noiseNav")}</h2>
            {model.buildings[0] && <ExteriorNoiseBasis properties={model.buildings[0].componentProperties} storeys={model.storeys} storeyLabel={(storeyId) => storeyNames.get(storeyId) ?? storeyId} t={t}
              pending={saveBuildingProperty.isPending || saveStoreyProperty.isPending || reviewComponentProperty.isPending}
              onSaveBuilding={(save) => saveBuildingProperty.mutate({ buildingId: model.buildings[0].id, save })} onSaveStorey={(storeyId, save) => saveStoreyProperty.mutate({ storeyId, save })}
              onReview={(state, decision) => reviewComponentProperty.mutate({ state, decision })} />}
            <Link className="text-ui-xs underline underline-offset-2" to={`/projects/${projectId}?view=noise&step=exterior`}>{t("buildingExteriorNoiseOpen")} →</Link>
            <h2 className="building-model-panel-title">{t("buildingSoundInsulation")}</h2>
            <SoundInsulationOverview components={modelComponents} level={model.buildings[0]?.componentProperties.soundInsulationLevel} t={t}
              pending={saveBuildingProperty.isPending || reviewComponentProperty.isPending}
              onLevel={model.buildings[0] ? (save) => saveBuildingProperty.mutate({ buildingId: model.buildings[0].id, save }) : undefined}
              onReviewLevel={(state, decision) => reviewComponentProperty.mutate({ state, decision })}
              derive={{ pending: deriveWallRoles.isPending, result: deriveWallRoles.data?.summary, onDerive: () => deriveWallRoles.mutate() }} />
            <h2 className="building-model-panel-title">{t("buildingStoreys")}</h2>
            <StoreyLevels storeys={model.storeys} t={t} pending={saveStoreyLevel.isPending || reviewComponentProperty.isPending}
              onSave={(storeyId, level) => saveStoreyLevel.mutate({ storeyId, level })} onReview={(state, decision) => reviewComponentProperty.mutate({ state, decision })} />
            <h2 className="building-model-panel-title">{t("buildingSoundRequest")}</h2>
            <DescriptionReader documents={((componentSources.data as { documents?: ComponentSourceDocument[] } | undefined)?.documents) ?? []} t={t} pending={readDescription.isPending}
              result={readDescription.data?.summary} onRead={(sourceVersionId) => readDescription.mutate(sourceVersionId)} />
            <DataRequest projectId={projectId} components={modelComponents} inquiries={(inquiries.data as InquirySummary[] | undefined) ?? []} t={t} pending={createInquiry.isPending}
              onCreate={(counterpart, body) => createInquiry.mutate({ counterpart, body })} />
          </PopoverContent>
        </Popover>
        <Button variant="ghost" size="icon-sm" type="button" aria-label={t("buildingSoundColorWalls")} title={t("buildingSoundColorWalls")} aria-pressed={colorWallRoles} onClick={() => setColorWallRoles((value) => !value)}><Palette className="size-icon-sm" aria-hidden="true" /></Button>
        <Badge title={model.reviewStatus === "needs-review" ? t("buildingModelReviewInWorkspace") : model.updatedAt ? `${t("buildingModelUpdated")} · ${new Date(model.updatedAt).toLocaleString()}` : t("buildingModelNoReview")}>{statusLabel(model.reviewStatus, t)}</Badge>
        <div className="building-model-toolbar-end">
          <Button variant="ghost" size="icon-sm" type="button" aria-label={t("buildingModelUndo")} title={`${t("buildingModelUndo")} (⌘Z)`} disabled={!outlineSession?.history.length} onClick={undoOutline}><Undo2 className="size-icon-sm" aria-hidden="true" /></Button>
          <Button variant="ghost" size="icon-sm" type="button" aria-label={t("buildingModelRedo")} title={`${t("buildingModelRedo")} (⇧⌘Z)`} disabled={!outlineSession?.future.length} onClick={redoOutline}><Redo2 className="size-icon-sm" aria-hidden="true" /></Button>
        </div>
      </div>
      <div className={`building-model-workbench${panels.outliner ? " show-outliner" : ""}${panels.properties ? " show-properties" : ""}`}>
        <Outliner t={t} storeys={outlinerStoreys} groups={outlinerGroups} categories={outlinerCategories} otherPages={unlistedRegions}
          layers={sourceLayers} layerVisible={(layer) => layers[layer.id] ?? layer.visible !== false} onLayer={(id, visible) => setLayers((current) => ({ ...current, [id]: visible }))}
          selectedId={selectedCandidate?.id || selected?.id} isVisible={regionVisible} onVisible={setVisible} areaOf={areaOf}
          onSelect={(region) => region.isCandidate ? selectCandidate(region as BuildingExtractionCandidate) : selectRegion(region.id)}
          addRegion={<RegionForm projectId={projectId} modelRevision={model.revision || 0} storeyId={currentSource?.storeyId || undefined} sourcePage={currentSource?.page || page} sourceVersionId={evidence.sourceVersionId || undefined} compact
            onComplete={() => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] })} t={t} />}
          footer={state !== "proposed" && hiddenWallCount > 0 && <p className="building-model-outliner-note"><span>{hiddenWallCount} {t("buildingModelHiddenWallHypotheses")}</span>{" "}<Link className="underline underline-offset-2" to={`?${wallReviewParams}`}>{t("buildingModelReviewWallHypotheses")}</Link></p>} />
        <div className="workbench-tool-rail" role="toolbar" aria-orientation="vertical" aria-label={t("buildingModelTools")}>
          {tools.map(({ value, key, Icon, label, disabled }) => <WorkbenchTool key={value} label={label} shortcut={key} aria-pressed={activeTool === value} disabled={disabled} onClick={() => chooseTool(value)}>
            <Icon className="size-icon" aria-hidden="true" />
          </WorkbenchTool>)}
          <div className="building-model-tool-rail-zoom" aria-label={t("buildingModelZoomControls")}>
            <WorkbenchTool onClick={() => zoomBy(.25)} disabled={viewerTransform.zoom >= 4} label={t("buildingModelZoomIn")}><Plus className="size-icon-sm" aria-hidden="true" /></WorkbenchTool>
            <span aria-live="polite">{Math.round(viewerTransform.zoom * 100)}%</span>
            <WorkbenchTool onClick={() => zoomBy(-.25)} disabled={viewerTransform.zoom <= 1} label={t("buildingModelZoomOut")}><Minus className="size-icon-sm" aria-hidden="true" /></WorkbenchTool>
            <WorkbenchTool onClick={() => setViewerTransform({ zoom: 1, pan: { x: 0, y: 0 } })} label={t("buildingModelFitView")}><Maximize className="size-icon-sm" aria-hidden="true" /></WorkbenchTool>
          </div>
        </div>
        <section className="building-model-evidence" aria-label={t("buildingModelSourceEvidence")}>
          <div className={`building-model-automatic-canvas is-tool-${activeTool}`}>
            <Suspense fallback={<div className="building-model-pdf-empty"><ScanLine aria-hidden="true" /><p>{t("buildingModelLoadingEvidence")}</p></div>}>
              <LazyPdfEvidenceRenderer projectId={projectId} evidence={evidence} page={page} selectedId={selectedCandidate?.id || selected?.id} regions={[...visibleRegions, ...visibleCandidates]} layerVisibility={layers} transform={viewerTransform} onTransform={setViewerTransform} onLayers={setPdfLayers} onSelect={(id) => { const candidate = sourceCandidates.find((item) => item.id === id); if (candidate) selectCandidate(candidate); else selectRegion(id); }} labels={{ empty: t("buildingModelPdfEmpty"), loading: t("buildingModelPdfLoading"), region: t("buildingModelSelectableRegions"), zoom: t("buildingModelZoomControls"), zoomIn: t("buildingModelZoomIn"), zoomOut: t("buildingModelZoomOut"), fit: t("buildingModelFitView"), magicSurface: planTool === "measure" ? t("buildingModelMeasureHint") : t("buildingModelMagicHint"), point: t("buildingModelOutlinePoint"), addPoint: t("buildingModelOutlineAddPoint") }}
                hideViewControls colorWallRoles={colorWallRoles} tool={planTool} measure={planTool === "measure" ? { points: measurePoints, label: measureLabel } : null}
                onPlanPick={(point) => { if (planTool === "measure") setMeasurePoints((current) => current.length >= 2 ? [point] : [...current, point]); else if (!magicSelect.isPending) magicSelect.mutate(point); }}
                outline={outlineSession ? { draft: outlineSession.draft, snap: snapToWalls, onBegin: beginOutlineChange, onChange: (draft) => updateOutline((session) => ({ ...session, draft })) } : null} />
            </Suspense>
            {currentAutomaticActive && <div className="building-model-scan-sweep" aria-hidden="true" />}
            {colorWallRoles && <div className="building-model-role-legend" aria-label={t("buildingSoundWallRoleLegend")}>
              {[...wallRoleOptions, "none"].flatMap((role) => { const count = pageRegions.filter((region) => region.entityType === "element" && regionComponentType(region) === "wall" && wallRoleOf(region) === role).length;
                return count ? [<span key={role}><i className={`building-model-role-swatch is-${role}`} aria-hidden="true" />{role === "none" ? t("buildingSoundWallsWithoutRole") : t(`buildingComponentWallRole${role.replace(/(^|_)([a-z])/g, (_, __, letter: string) => letter.toUpperCase())}` as keyof typeof import("../../locales/en.json"))} · {count}</span>] : []; })}
            </div>}
            {(conflict || modelError || magicNotice || magicSelect.isPending) && <div className="building-model-canvas-notices" aria-live="polite">
              <NoticeStack>{[
                conflict && <Callout key="conflict" tone="warning">{conflict}</Callout>,
                modelError && <Callout key="error" tone="error">{modelError.message}</Callout>,
                magicNotice && <Callout key="magic" tone="warning">{magicNotice}</Callout>,
                magicSelect.isPending && <Callout key="detecting">{t("buildingModelMagicDetecting")}</Callout>,
              ]}</NoticeStack>
            </div>}
          </div>
        </section>
        <aside className="building-model-inspector building-model-properties" aria-label={t("buildingModelInspector")}>
          <div className="building-model-panel-header">
            <h2 className="building-model-panel-title">{t("buildingModelProperties")}</h2>
            {selected && !selectedCandidate && !outlineSession && <Link className="building-model-panel-action" to={referenceHref} title={t("buildingModelOpenReference")} aria-label={t("buildingModelOpenReference")}><Link2 className="size-icon-sm" aria-hidden="true" /></Link>}
          </div>
          <div className="building-model-properties-scroll">
            {outlineSession && <OutlineSection session={outlineSession} canCreateRoom={canCreateRoom} pending={saveOutline.isPending} t={t} onUpdate={updateOutline} onBegin={beginOutlineChange} />}
            {!showInspector ? geometry
              : selectedCandidate ? <CandidateInspector candidate={selectedCandidate} regions={regions} t={t} pending={reviewCandidate.isPending || mergeRooms.isPending || splitRoom.isPending} geometry={isRoom(selectedCandidate) ? geometry : undefined}
                mergeOptions={isRoom(selectedCandidate) ? neighbouringRooms(selectedCandidate, sourceCandidates) : []}
                onMerge={(other) => mergeRooms.mutate([candidateKey(selectedCandidate), candidateKey(other)])} onSplit={() => splitRoom.mutate(candidateKey(selectedCandidate))}
                edit={candidateEdit} onEdit={(edit) => setCandidateEdits((current) => ({ ...current, [selectedCandidate.id]: { ...current[selectedCandidate.id], ...edit } }))}
                onPage={(nextPage) => selectSourcePage(nextPage, selectedCandidate.sourceVersionId || evidence.sourceVersionId || "", selectedCandidate.storeyId || currentSource?.storeyId || "")}
                onReview={(decision, correction) => reviewCandidate.mutate({ candidateId: selectedCandidate.candidateId || selectedCandidate.id.replace(/^candidate:/, ""), body: { decision, ...correction } })} />
              : selected ? <ObjectInspector region={selected} sourcePage={selected.page} sourceVersionId={selected.sourceVersionId || evidence.sourceVersionId} sourceRegion={selected.box} proposals={selectedProposals} t={t} geometry={isRoom(selected) ? geometry : undefined}
                onPage={(nextPage) => selectSourcePage(nextPage, selected.sourceVersionId || evidence.sourceVersionId || "", selected.storeyId || currentSource?.storeyId || "")} onSave={(body) => updateObject.mutate({ id: selected.id, entityType: selected.entityType || "room", body })} onMeasurementSave={(measurement, value) => createMeasurement.mutate({ region: selected, measurement, value })} pending={updateObject.isPending || createMeasurement.isPending}
                components={(selected.entityType === "room" || regionComponentType(selected)) ? <ComponentProperties region={selected} roomNames={roomNames} elementNames={elementNames} storeyNames={storeyNames} elementHref={entityHref} t={t} pending={saveComponentProperty.isPending || reviewComponentProperty.isPending}
                  onSave={(save) => saveComponentProperty.mutate({ region: selected, save })} onReview={(state, decision) => reviewComponentProperty.mutate({ state, decision })}
                  derivation={{ pending: deriveWallRoles.isPending, result: deriveWallRoles.data?.summary, onDerive: () => deriveWallRoles.mutate() }}
                  copy={{ pending: copyWallType.isPending, result: copyWallType.variables?.region.id === selected.id ? copyWallType.data?.summary : undefined, onCopy: (keys) => copyWallType.mutate({ region: selected, keys }),
                    sameRoleCount: [...wallRoles].filter(([id, role]) => id !== selected.id && role != null && role === wallRoles.get(selected.id)).length }} /> : undefined}
                wallType={wallRoles.get(selected.id) != null ? <WallTypeReview walls={modelWalls.filter((wall) => wallRoles.get(wall.id) === wallRoles.get(selected.id))} t={t} pending={reviewWallType.isPending} onApprove={(items) => reviewWallType.mutate(items)} /> : undefined} />
              : <Empty>{t("buildingModelSelectObject")}</Empty>}
          </div>
        </aside>
      </div>
      <footer className="building-model-statusbar">
        <div className="building-model-statusbar-summary">{summary.map((part, index) => index === 0 ? <strong key={index}>{part}</strong> : <span key={index}>{part}</span>)}</div>
        <div className="building-model-statusbar-hints" aria-hidden="true">{hints.map(([key, label]) => <span key={key}><kbd>{key}</kbd>{label}</span>)}</div>
        <div className="building-model-statusbar-actions">
          {outlineSession ? <>
            <Button size="sm" variant="ghost" type="button" disabled={saveOutline.isPending} onClick={() => setOutlineSession(null)}>{t("cancel")}</Button>
            <Button size="sm" type="button" disabled={!canSaveOutline} onClick={() => saveOutline.mutate(outlineSession)} title={t("buildingModelOutlineLogged")}>{saveOutline.isPending ? t("loading") : t("buildingModelSaveOutline")}<kbd>↵</kbd></Button>
          </> : selectedCandidate ? <>
            <Button size="sm" variant="outline" type="button" disabled={reviewCandidate.isPending} onClick={() => reviewSelected("rejected")}>{t("buildingModelRejectCandidate")}</Button>
            <Button size="sm" type="button" disabled={reviewCandidate.isPending} onClick={() => reviewSelected("approved")}>{t("buildingModelAcceptCandidate")}<kbd>↵</kbd></Button>
          </> : null}
        </div>
      </footer>
    </div>
  );
}

function contextExtractionStatus(status: string | undefined, t: ReturnType<typeof useT>) {
  if (status === "queued") return t("buildingModelExtractionQueued");
  if (status === "running") return t("buildingModelExtractionRunning");
  if (status === "failed") return t("buildingModelExtractionFailed");
  if (status === "complete" || status === "succeeded") return t("buildingModelExtractionComplete");
  return t("buildingModelExtractionNotRun");
}

function contextClassificationStatus(processing: BuildingAutomaticPlanProcessing | undefined, hasProcessing: boolean, t: ReturnType<typeof useT>) {
  if (processing) return automaticPhaseLabel(processing, t);
  return hasProcessing ? t("buildingModelPageClassificationAvailable") : t("buildingModelPageClassificationUnavailable");
}

function automaticStatusLabel(status: string, t: ReturnType<typeof useT>) {
  const labels: Record<string, keyof typeof import("../../locales/en.json")> = {
    reading_source: "buildingModelAutomaticReadingSource",
    classifying_pages: "buildingModelAutomaticClassifyingPages",
    planning: "buildingModelAutomaticPlanning",
    processing: "buildingModelAutomaticPlanning",
    queued: "buildingModelAutomaticQueued",
    extracting: "buildingModelAutomaticExtracting",
    complete: "buildingModelAutomaticComplete",
    partial: "buildingModelAutomaticPartial",
    unresolved: "buildingModelAutomaticUnresolved",
    failed: "buildingModelAutomaticFailed",
  };
  return t(labels[status] || "buildingModelAutomaticPlanning");
}

function automaticPhaseLabel(processing: BuildingAutomaticPlanProcessing | undefined, t: ReturnType<typeof useT>) {
  if (!processing) return t("buildingModelAutomaticReadingSource");
  if (processing.inference?.active) return t("buildingModelExtractionClassifyingRoomLabels");
  const labels: Record<string, keyof typeof import("../../locales/en.json")> = {
    reading_plan: "buildingModelAutomaticReadingSource",
    identifying_floors: "buildingModelAutomaticClassifyingPages",
    extracting_geometry: "buildingModelExtractionExtractingGeometry",
    preparing_draft: "buildingModelExtractionPreparingDraft",
    complete: "buildingModelAutomaticComplete",
    partial: "buildingModelAutomaticPartial",
    unsupported: "buildingModelAutomaticUnresolved",
    failed: "buildingModelAutomaticFailed",
  };
  return processing.currentPhase && labels[processing.currentPhase] ? t(labels[processing.currentPhase]!) : automaticStatusLabel(processing.status, t);
}

export function AutomaticBuildingModelPreparation({ projectId, processing, files, filesLoading, manualFallback, t }: {
  projectId: string;
  processing: BuildingAutomaticPlanProcessing[];
  files: RecordData[];
  filesLoading: boolean;
  manualFallback: ReactElement;
  t: ReturnType<typeof useT>;
}) {
  const active = filesLoading || processing.some((item) => automaticProcessingActive(item.status)) || (!processing.length && files.length > 0);
  const unresolved = processing.length > 0 && processing.every((item) => item.status === "unresolved" || item.status === "partial" || item.status === "failed");
  const [previewSourceId, setPreviewSourceId] = useState("");
  const primaryProcessing = processing.find((item) => item.sourceVersionId === previewSourceId) || preferredAutomaticProcessing(processing);
  const preferredFile = [...files].sort((a, b) => planFileNamePreference(String(b.name || "")) - planFileNamePreference(String(a.name || "")))[0];
  const sourceFile = files.find((file) => file.id === primaryProcessing?.fileId || file.versionId === primaryProcessing?.sourceVersionId)
    || files.find((file) => file.versionId === previewSourceId || file.id === previewSourceId) || preferredFile;
  const [previewPage, setPreviewPage] = useState(1);
  const [previewTransform, setPreviewTransform] = useState<PdfViewerTransform>({ zoom: 1, pan: { x: 0, y: 0 } });
  const activePreviewSourceId = primaryProcessing?.sourceVersionId || String(sourceFile?.versionId || sourceFile?.id || "");
  useEffect(() => { setPreviewPage(primaryProcessing?.floorPlanPages[0] || 1); }, [activePreviewSourceId]);
  const previewPageCount = Math.max(1, primaryProcessing?.pageCount || sourceFile?.pageCount || 1);
  const previewEvidence = sourceFile || primaryProcessing?.renderableSource?.downloadUrl ? { fileName: String(sourceFile?.name || primaryProcessing?.fileName || "Building plan.pdf"), fileId: typeof sourceFile?.id === "string" ? sourceFile.id : primaryProcessing?.fileId, sourceVersionId: typeof sourceFile?.versionId === "string" ? sourceFile.versionId : primaryProcessing?.sourceVersionId, version: typeof sourceFile?.version === "number" ? sourceFile.version : 1, pageCount: previewPageCount, pdfUrl: typeof primaryProcessing?.renderableSource?.downloadUrl === "string" ? primaryProcessing.renderableSource.downloadUrl : typeof sourceFile?.downloadUrl === "string" ? sourceFile.downloadUrl : undefined } : undefined;
  const stage = automaticPhaseLabel(primaryProcessing, t);
  return <section className="building-model-automatic-preparation" aria-label={t("buildingModelAutomaticTitle")}>
    <div className="building-model-automatic-heading">
      <div className="building-model-automatic-icon" aria-hidden="true"><LoaderCircle /></div>
      <div><p className="eyebrow">{t("buildingModelSection")}</p><h2>{active ? t("buildingModelAutomaticTitle") : t("buildingModelAutomaticNeedsReview")}</h2><p>{active ? t("buildingModelAutomaticDescription") : t("buildingModelAutomaticUnresolvedDescription")}</p></div>
    </div>
    {active && <div className="building-model-automatic-meter" role="status"><span /><small>{t("buildingModelAutomaticDurableHint")}</small></div>}
    <div className="building-model-automatic-sources">
      {processing.map((item) => <div className="building-model-automatic-source" key={item.sourceVersionId}><div><strong>{item.fileName}</strong><small>{item.reason || t("buildingModelAutomaticWaitingForCoverage")}</small></div><Badge>{automaticPhaseLabel(item, t)}</Badge></div>)}
      {!processing.length && files.map((file) => <div className="building-model-automatic-source" key={file.id}><div><strong>{String(file.name)}</strong><small>{t("buildingModelAutomaticWaitingForCoverage")}</small></div><Badge>{filesLoading ? t("loading") : t("buildingModelAutomaticReadingSource")}</Badge></div>)}
      {filesLoading && !processing.length && !files.length && <div className="building-model-automatic-source"><div><strong>{t("buildingModelAutomaticCheckingUploads")}</strong><small>{t("buildingModelAutomaticWaitingForCoverage")}</small></div><Badge>{t("loading")}</Badge></div>}
    </div>
    {previewEvidence && <div className={`building-model-automatic-preview${active ? " is-active" : ""}`}>
      <div className="building-model-automatic-preview-bar"><div><Badge>{stage}</Badge><span>{previewEvidence.fileName}</span></div><div>{(processing.length > 1 || (!processing.length && files.length > 1)) && <NativeSelect aria-label={t("buildingModelSourceDocument")} value={activePreviewSourceId} onChange={(event) => setPreviewSourceId(event.target.value)}>{processing.length ? processing.map((item) => <option key={item.sourceVersionId} value={item.sourceVersionId}>{item.fileName}</option>) : files.map((file) => <option key={String(file.versionId || file.id)} value={String(file.versionId || file.id)}>{String(file.name)}</option>)}</NativeSelect>}{previewPageCount > 1 && <NativeSelect aria-label={t("buildingModelPage")} value={String(previewPage)} onChange={(event) => setPreviewPage(Number(event.target.value))}>{Array.from({ length: previewPageCount }, (_, index) => <option key={index + 1} value={index + 1}>{t("buildingModelPage")} {index + 1}</option>)}</NativeSelect>}</div></div>
      <div className="building-model-automatic-canvas">
        <Suspense fallback={<div className="building-model-pdf-empty"><ScanLine aria-hidden="true" /><p>{t("buildingModelLoadingEvidence")}</p></div>}>
          <LazyPdfEvidenceRenderer projectId={projectId} evidence={previewEvidence} page={previewPage} regions={[]} layerVisibility={emptyLayerVisibility} transform={previewTransform} onTransform={setPreviewTransform} onLayers={() => undefined} onSelect={() => undefined} labels={{ empty: t("buildingModelPdfEmpty"), loading: t("buildingModelPdfLoading"), region: t("buildingModelSelectableRegions"), zoom: t("buildingModelZoomControls"), zoomIn: t("buildingModelZoomIn"), zoomOut: t("buildingModelZoomOut"), fit: t("buildingModelFitView") }} />
        </Suspense>
        {active && <div className="building-model-scan-sweep" aria-hidden="true" />}
      </div>
      <p className="muted text-ui-2xs" aria-live="polite" aria-atomic="true">{stage} · {t("buildingModelAutomaticNoFakeProgress")}</p>
    </div>}
    {unresolved && <Callout tone="warning">{t("buildingModelAutomaticUnresolvedDescription")}</Callout>}
    {processing.flatMap((item) => item.errors || []).map((error, index) => <Callout tone="error" key={`${error.jobId || "automatic"}-${index}`}>{error.reason || t("buildingModelExtractionFailed")} {error.page ? `· ${t("buildingModelPage")} ${error.page}` : ""} {error.retryable ? `· ${t("buildingModelAutomaticRetryScheduled")}` : ""}</Callout>)}
    <div className="building-model-automatic-actions"><Button asChild><Link to={`/projects/${projectId}?view=building-model`}>{t("buildingModelOpen")}</Link></Button><small>{t("buildingModelAutomaticCanLeave")}</small></div>
    {!active && <details className="building-model-manual-fallback"><summary>{t("buildingModelManualFallback")}</summary><p className="muted text-ui-xs">{t("buildingModelManualFallbackHint")}</p>{manualFallback}</details>}
  </section>;
}

export function AutomaticPlanCoverage({ processing, sources, storeys, selectedPage, selectedSourceVersionId, onPage, superseded = [], onSupersede, onRestore, pending = false, onSaveColours, colourPending = false, onSaveScale, scalePending = false, t }: {
  processing: BuildingAutomaticPlanProcessing[];
  onSaveColours?: (sourceVersionId: string, entries: WallColourEntry[]) => void;
  colourPending?: boolean;
  onSaveScale?: (sourceVersionId: string, denominator: number | null) => void;
  scalePending?: boolean;
  superseded?: BuildingSupersededSource[];
  onSupersede?: (sourceVersionId: string, supersededByVersionId: string) => void;
  onRestore?: (sourceVersionId: string) => void;
  pending?: boolean;
  sources: BuildingPlanSource[];
  storeys: Array<{ id: string; name?: string; levelIndex?: number | null }>;
  selectedPage: number;
  selectedSourceVersionId?: string;
  onPage: (selection: { page: number; sourceVersionId: string; storeyId: string | null }) => void;
  t: ReturnType<typeof useT>;
}) {
  return <section className="building-model-page-coverage" aria-label={t("buildingModelPageCoverage")}>
    <div className="building-model-page-coverage-heading"><div><h2>{t("buildingModelPageCoverage")}</h2><p>{t("buildingModelPageCoverageHint")}</p></div><div className="building-model-page-legend"><span className="is-floor-plan">{t("buildingModelPageFloorPlan")}</span><span className="is-non-floor-plan">{t("buildingModelPageNonPlan")}</span><span className="is-unresolved">{t("buildingModelPageUnresolved")}</span></div></div>
    {processing.map((item) => {
      const pages = Array.from({ length: Math.max(0, item.registeredPageCount || item.pageCount || 0) }, (_, index) => index + 1);
      return <div className="building-model-page-coverage-source" key={item.sourceVersionId}>
        <div className="building-model-page-coverage-meta"><strong>{item.fileName}</strong><Badge>{automaticStatusLabel(item.status, t)}</Badge><small>{item.reason}</small>
          {onSupersede && processing.length > 1 && <SupersedePlanSet item={item} processing={processing} pending={pending} onSupersede={onSupersede} t={t} />}</div>
        <div className="building-model-page-coverage-pages">{pages.map((pageNumber) => {
          const disposition = automaticPageDisposition(item, pageNumber);
          const nonPlan = item.nonFloorPlanPages.find((entry) => entry.page === pageNumber);
          const pageSource = sources.find((source) => source.source?.versionId === item.sourceVersionId && source.page === pageNumber);
          const storeyName = storeys.find((storey) => storey.id === pageSource?.storeyId)?.name;
          const label = disposition === "floor_plan" ? `${t("buildingModelPageFloorPlan")}${storeyName ? ` · ${storeyName}` : ""}` : disposition === "non_floor_plan" ? `${t("buildingModelPageNonPlan")}${nonPlan?.pageType ? ` · ${nonPlan.pageType.replaceAll("_", " ")}` : ""}` : t("buildingModelPageUnresolved");
          return <button type="button" key={pageNumber} className={`is-${disposition.replaceAll("_", "-")}`} aria-pressed={selectedSourceVersionId === item.sourceVersionId && selectedPage === pageNumber} title={label} onClick={() => onPage({ page: pageNumber, sourceVersionId: item.sourceVersionId, storeyId: pageSource?.storeyId || null })}><span>{pageNumber}</span><small>{label}</small></button>;
        })}</div>
        {item.coverageTruncated && <Callout tone="warning">{t("buildingModelCoverageTruncated")}</Callout>}
        {onSaveScale && item.planScale && item.floorPlanPages.length > 0 && <PlanScale key={`${item.planScale.savedDenominator ?? "read"}`} scale={item.planScale} pending={scalePending}
          onSave={(denominator) => onSaveScale(item.sourceVersionId, denominator)} t={t} />}
        {onSaveColours && item.colourLegend && item.floorPlanPages.length > 0 && <WallColours key={item.colourLegend.savedAt || "suggested"} item={item} pending={colourPending}
          onSave={(entries) => onSaveColours(item.sourceVersionId, entries)} onPage={(pageNumber) => onPage({ page: pageNumber, sourceVersionId: item.sourceVersionId,
            storeyId: sources.find((source) => source.source?.versionId === item.sourceVersionId && source.page === pageNumber)?.storeyId || null })} t={t} />}
      </div>;
    })}
    {superseded.length > 0 && <div className="building-model-superseded-sources">
      <h3>{t("buildingModelSupersededSets")}</h3><p className="muted text-ui-xs">{t("buildingModelSupersededHint")}</p>
      {superseded.map((item) => {
        const replacement = processing.find((entry) => entry.sourceVersionId === item.supersededByVersionId)?.fileName;
        return <div className="building-model-page-coverage-meta" key={item.sourceVersionId}><strong>{item.fileName}</strong>{replacement && <small>{t("buildingModelSupersededBy")} {replacement}</small>}
          {onRestore && <Button size="sm" variant="outline" type="button" disabled={pending} onClick={() => onRestore(item.sourceVersionId)}>{t("buildingModelRestorePlanSet")}</Button>}</div>;
      })}
    </div>}
  </section>;
}

const planScaleSourceLabels = { dimension_chains: "buildingModelScaleFromDimensions", dimension_chains_and_title_block: "buildingModelScaleFromDimensionsAndTitle",
  title_block: "buildingModelScaleFromTitle", planner: "buildingModelScaleFromPlanner" } as const;

/** The scale each page was read at; the planner can set the plan set's scale instead. */
function PlanScale({ scale, pending, onSave, t }: { scale: BuildingPlanScale; pending: boolean; onSave: (denominator: number | null) => void; t: ReturnType<typeof useT> }) {
  const read = scale.pages.filter((page) => page.denominator);
  const typical = read[0]?.denominator ?? null;
  const [value, setValue] = useState(String(scale.savedDenominator ?? typical ?? ""));
  const inputId = useId();
  const parsed = /^\d{2,4}$/.test(value.trim()) ? Number(value.trim()) : null;
  // Pages read at the same scale and from the same evidence share one line.
  const groups = [...read.reduce((map, page) => { const key = `${page.denominator}:${page.source}`;
    map.set(key, [...(map.get(key) ?? []), page]); return map; }, new Map<string, typeof read>()).values()];
  return <div className="building-model-plan-scale">
    <h3>{t("buildingModelScale")}</h3>
    {groups.length ? <ul className="text-ui-xs">{groups.map((pages) => { const first = pages[0]!;
      return <li key={`${first.denominator}:${first.source}`}><strong>1:{first.denominator}</strong> · {t("buildingModelWallColourPages")} {pages.map((page) => page.page).join(", ")}
        {first.source && <span className="muted"> · {t(planScaleSourceLabels[first.source])}{first.agreeingPairs > 0 ? ` (${t("buildingModelScaleChecks").replace("{count}", String(Math.min(...pages.map((page) => page.agreeingPairs))))})` : ""}</span>}</li>; })}</ul>
      : <p className="muted text-ui-xs">{t("buildingModelScaleNone")}</p>}
    <div className="building-model-plan-scale-form">
      <label className="text-ui-xs" htmlFor={inputId}>1 :</label>
      <Input id={inputId} className="h-control-sm w-20" inputMode="numeric" aria-label={t("buildingModelScale")} value={value} onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && parsed) onSave(parsed); }} />
      <Button size="sm" variant="outline" type="button" disabled={pending || !parsed || parsed === scale.savedDenominator} onClick={() => parsed && onSave(parsed)}>{t("buildingModelSetScale")}</Button>
      {scale.savedDenominator !== null && <Button size="sm" variant="ghost" type="button" disabled={pending} onClick={() => onSave(null)}>{t("buildingModelReadScaleFromPlan")}</Button>}
    </div>
    <p className="muted text-ui-xs">{t("buildingModelScaleHint")}</p>
  </div>;
}

type WallColourEntry = { colour: string; layer: BuildingWallColour["layer"]; state: BuildingWallColourState };
const wallColourStateLabels: Record<BuildingWallColourState, Parameters<ReturnType<typeof useT>>[0]> = { proposed: "buildingModelWallColourProposed", retained: "buildingModelWallColourRetained",
  demolished: "buildingModelWallColourDemolished", not_wall: "buildingModelWallColourNotWall" };

/** The planner's reading of the plan set's wall colours; the DIN 1356-1 colours are only the preselection. */
function WallColours({ item, pending, onSave, onPage, t }: { item: BuildingAutomaticPlanProcessing; pending: boolean;
  onSave: (entries: WallColourEntry[]) => void; onPage: (page: number) => void; t: ReturnType<typeof useT> }) {
  const colours = item.colourLegend?.colours ?? [];
  const keyOf = (colour: BuildingWallColour) => `${colour.layer}:${colour.colour}`;
  const [states, setStates] = useState<Record<string, BuildingWallColourState>>(() => Object.fromEntries(colours.map((colour) => [keyOf(colour), colour.state ?? colour.suggested])));
  const changed = !item.colourLegend?.savedAt || colours.some((colour) => states[keyOf(colour)] !== (colour.state ?? colour.suggested));
  return <div className="building-model-wall-colours">
    <div className="building-model-wall-colours-heading"><div><h3>{t("buildingModelWallColours")}</h3>
      <p className="muted text-ui-xs">{colours.length ? t("buildingModelWallColoursHint") : t("buildingModelWallColoursNone")}</p></div>
      {colours.length > 0 && <Button size="sm" variant="outline" type="button" disabled={pending || !changed}
        onClick={() => onSave(colours.map((colour) => ({ colour: colour.colour, layer: colour.layer, state: states[keyOf(colour)] ?? colour.suggested })))}>{t("buildingModelSaveWallColours")}</Button>}</div>
    {colours.length > 0 && <Table>
      <TableHeader><TableRow><TableHead>{t("buildingModelWallColour")}</TableHead>
        <TableHead className="text-right">{t("buildingModelWallColourFills")}</TableHead><TableHead>{t("buildingModelWallColourPages")}</TableHead><TableHead>{t("buildingModelWallColourMeaning")}</TableHead></TableRow></TableHeader>
      <TableBody>{colours.map((colour) => {
        const key = keyOf(colour), state = states[key] ?? colour.suggested;
        return <TableRow key={key}>
          <TableCell><span className="building-model-wall-colour"><span className="building-model-wall-colour-swatch" style={{ background: colour.colour }} aria-hidden="true" />
            <span><code>{colour.colour}</code><small>{colour.layer === "existing" ? t("buildingModelWallColourLayerExisting") : t("buildingModelWallColourLayerConstruction")}</small></span></span></TableCell>
          <TableCell className="text-right tabular-nums">{colour.count}</TableCell>
          <TableCell><span className="building-model-wall-colour-pages">{colour.pages.map((pageNumber) => <button type="button" key={pageNumber} onClick={() => onPage(pageNumber)}>{pageNumber}</button>)}</span></TableCell>
          <TableCell><NativeSelect aria-label={`${t("buildingModelWallColourMeaning")} ${colour.colour}`} value={state} onChange={(event) => setStates((current) => ({ ...current, [key]: event.target.value as BuildingWallColourState }))}>
            {(Object.keys(wallColourStateLabels) as BuildingWallColourState[]).map((option) => <option key={option} value={option}>{t(wallColourStateLabels[option])}</option>)}
          </NativeSelect>{state !== colour.suggested && <small className="building-model-wall-colour-suggested">{t("buildingModelWallColourSuggested")}: {t(wallColourStateLabels[colour.suggested])}</small>}</TableCell>
        </TableRow>;
      })}</TableBody>
    </Table>}
  </div>;
}

function SupersedePlanSet({ item, processing, pending, onSupersede, t }: { item: BuildingAutomaticPlanProcessing; processing: BuildingAutomaticPlanProcessing[]; pending: boolean;
  onSupersede: (sourceVersionId: string, supersededByVersionId: string) => void; t: ReturnType<typeof useT> }) {
  const [replacement, setReplacement] = useState("_none");
  return <span className="building-model-supersede">
    <NativeSelect aria-label={t("buildingModelSupersededBy")} value={replacement} onChange={(event) => setReplacement(event.target.value)}>
      <option value="_none">{t("buildingModelSupersedeWith")}</option>
      {processing.filter((entry) => entry.sourceVersionId !== item.sourceVersionId).map((entry) => <option key={entry.sourceVersionId} value={entry.sourceVersionId}>{entry.fileName}</option>)}
    </NativeSelect>
    <Button size="sm" variant="outline" type="button" disabled={pending || replacement === "_none"} onClick={() => onSupersede(item.sourceVersionId, replacement)}>{t("buildingModelMarkSuperseded")}</Button>
  </span>;
}

type BuildingModelBootstrapProps = {
  projectId: string;
  modelRevision: number;
  files: RecordData[];
  fileId: string;
  onFileId: (value: string) => void;
  versions: RecordData[];
  filesLoading: boolean;
  error?: Error | null;
  onComplete: (page: number) => Promise<void>;
  t: ReturnType<typeof useT>;
};

/** Small, real-data setup for the first plan source. It deliberately does not invent geometry. */
export function BuildingModelBootstrap({ projectId, modelRevision, files, fileId, onFileId, versions, filesLoading, error, onComplete, t }: BuildingModelBootstrapProps) {
  const [buildingName, setBuildingName] = useState("");
  const [buildingStableKey, setBuildingStableKey] = useState("");
  const [storeyName, setStoreyName] = useState("");
  const [storeyStableKey, setStoreyStableKey] = useState("");
  const [levelIndex, setLevelIndex] = useState("0");
  const [sourceVersionId, setSourceVersionId] = useState("");
  const [page, setPage] = useState("1");
  const [failure, setFailure] = useState<string>();
  const bootstrap = useMutation({
    mutationFn: async () => {
      const building = await api<RecordData>(`/projects/${projectId}/building-model`, {
        ...(modelRevision > 0 ? { baseRevision: modelRevision } : {}),
        stableKey: buildingStableKey.trim() || slug(buildingName),
        name: buildingName.trim(),
        constructionState: "existing",
      });
      const buildingId = building.building?.id || building.data?.building?.id || building.id;
      const revision = building.model?.revision || building.data?.model?.revision || modelRevision || 1;
      if (!buildingId) throw new Error(t("buildingModelBootstrapBuildingError"));
      const storey = await api<RecordData>(`/projects/${projectId}/building-model/buildings/${buildingId}/storeys`, {
        baseRevision: revision,
        stableKey: storeyStableKey.trim() || slug(storeyName),
        name: storeyName.trim(),
        levelIndex: Number(levelIndex),
        constructionState: "existing",
      });
      const storeyId = storey.created?.id || storey.data?.created?.id || storey.id;
      const storeyRevision = storey.revision || storey.data?.revision || revision;
      if (!storeyId) throw new Error(t("buildingModelBootstrapStoreyError"));
      const selectedVersion = versions.find((version) => version.id === sourceVersionId);
      const pageCount = typeof selectedVersion?.pageCount === "number" && selectedVersion.pageCount > 0 ? selectedVersion.pageCount : null;
      const planSource = await api<RecordData>(`/projects/${projectId}/building-model/plan-sources`, {
        baseRevision: storeyRevision,
        storeyId,
        sourceVersionId,
        page: Number(page),
        pageCount,
        layers: [],
        alignmentStatus: "unknown",
      });
      const planSourceRevision = planSource.revision || planSource.data?.revision || storeyRevision;
      await api(`/projects/${projectId}/building-model/extractions`, {
        sourceVersionId,
        page: Number(page),
        storeyId,
        baseRevision: planSourceRevision,
      });
      return Number(page);
    },
    onSuccess: async (sourcePage) => onComplete(sourcePage),
    onError: (cause) => setFailure(cause instanceof Error ? cause.message : String(cause)),
  });
  const selectedFile = files.find((file) => file.id === fileId);
  const canSubmit = !!selectedFile && !!sourceVersionId && !!buildingName.trim() && !!storeyName.trim() && Number(page) > 0 && Number.isInteger(Number(levelIndex));
  return (
    <section className="building-model-bootstrap" aria-label={t("buildingModelBootstrapTitle")}>
      <div className="building-model-bootstrap-heading">
        <div>
          <p className="eyebrow">{t("buildingModelSection")}</p>
          <h2>{t("buildingModelBootstrapTitle")}</h2>
          <p className="muted text-ui-xs">{t("buildingModelBootstrapDescription")}</p>
        </div>
        <Badge>{t("buildingModelBootstrapStatus")}</Badge>
      </div>
      {(error || failure) && <Callout tone="error">{failure || error?.message}</Callout>}
      {!filesLoading && !files.length && !error && <Callout tone="warning">{t("buildingModelNoUploadedPdf")}</Callout>}
      <form className="building-model-bootstrap-form" onSubmit={(event) => { event.preventDefault(); if (canSubmit) bootstrap.mutate(); }}>
        <div className="building-model-bootstrap-grid">
          <Field label={t("buildingModelBootstrapPdf") } hint={t("buildingModelBootstrapPdfHint")}>
            <NativeSelect value={fileId} onChange={(event) => { onFileId(event.target.value); setSourceVersionId(""); }} disabled={filesLoading || bootstrap.isPending}>
              <option value="">{filesLoading ? t("buildingModelLoadingSources") : t("buildingModelChoosePdf")}</option>
              {files.map((file) => <option key={file.id} value={file.id}>{file.name}</option>)}
            </NativeSelect>
          </Field>
          <Field label={t("buildingModelBootstrapRevision")} hint={t("buildingModelBootstrapRevisionHint")}>
            <NativeSelect value={sourceVersionId} onChange={(event) => setSourceVersionId(event.target.value)} disabled={!selectedFile || versions.length === 0 || bootstrap.isPending}>
              <option value="">{t("buildingModelChooseRevision")}</option>
              {versions.map((version) => <option key={version.id} value={version.id}>{t("buildingModelVersion")} {version.version ?? version.id}</option>)}
            </NativeSelect>
          </Field>
          <Field label={t("buildingModelBootstrapPage")} hint={t("buildingModelBootstrapPageHint")}>
            <Input type="number" min="1" step="1" value={page} onChange={(event) => setPage(event.target.value)} disabled={bootstrap.isPending} required />
          </Field>
          <Field label={t("buildingModelBootstrapBuilding")}>
            <Input value={buildingName} onChange={(event) => setBuildingName(event.target.value)} disabled={bootstrap.isPending} required />
          </Field>
          <Field label={t("buildingModelBootstrapBuildingKey")} hint={t("buildingModelBootstrapKeyHint")}>
            <Input value={buildingStableKey} onChange={(event) => setBuildingStableKey(event.target.value)} disabled={bootstrap.isPending} placeholder={slug(buildingName) || "building"} />
          </Field>
          <Field label={t("buildingModelBootstrapStorey")}>
            <Input value={storeyName} onChange={(event) => setStoreyName(event.target.value)} disabled={bootstrap.isPending} required />
          </Field>
          <Field label={t("buildingModelBootstrapStoreyKey")} hint={t("buildingModelBootstrapKeyHint")}>
            <Input value={storeyStableKey} onChange={(event) => setStoreyStableKey(event.target.value)} disabled={bootstrap.isPending} placeholder={slug(storeyName) || "storey"} />
          </Field>
          <Field label={t("buildingModelBootstrapLevel")} hint={t("buildingModelBootstrapLevelHint")}>
            <Input type="number" step="1" value={levelIndex} onChange={(event) => setLevelIndex(event.target.value)} disabled={bootstrap.isPending} required />
          </Field>
        </div>
        <div className="building-model-bootstrap-actions">
          <Button type="submit" disabled={!canSubmit || bootstrap.isPending}>{bootstrap.isPending ? t("buildingModelBootstrapCreating") : t("buildingModelBootstrapCreateAndExtract")}</Button>
          <span className="muted text-ui-2xs">{t("buildingModelBootstrapEvidenceNote")}</span>
        </div>
      </form>
    </section>
  );
}

function slug(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "building";
}

function RegionForm({ projectId, modelRevision, storeyId, sourcePage, sourceVersionId, compact = false, onComplete, t }: { projectId: string; modelRevision: number; storeyId?: string; sourcePage: number; sourceVersionId?: string; compact?: boolean; onComplete: () => void | Promise<void>; t: ReturnType<typeof useT> }) {
  const [open, setOpen] = useState(compact);
  const [kind, setKind] = useState<"room" | "element">("room");
  const [stableKey, setStableKey] = useState("");
  const [name, setName] = useState("");
  const [constructionState, setConstructionState] = useState("existing");
  const [box, setBox] = useState({ x: "0", y: "0", width: "1", height: "1" });
  const [failure, setFailure] = useState<string>();
  const createRegion = useMutation({
    mutationFn: () => {
      if (!storeyId) throw new Error(t("buildingModelRegionStoreyRequired"));
      const planRegion = Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Number(value)]));
      return api(`/projects/${projectId}/building-model/storeys/${storeyId}/${kind === "room" ? "rooms" : "elements"}`, {
        baseRevision: modelRevision,
        stableKey: stableKey.trim() || slug(name),
        name: name.trim(),
        constructionState,
        geometry: { planRegion, source: sourceVersionId ? { sourceVersionId, page: sourcePage } : null },
        ...(kind === "element" ? { kind: "element" } : {}),
      });
    },
    onSuccess: async () => {
      if (!compact) setOpen(false);
      setName("");
      setStableKey("");
      setBox({ x: "0", y: "0", width: "1", height: "1" });
      setFailure(undefined);
      await onComplete();
    },
    onError: (cause) => setFailure(cause instanceof Error ? cause.message : String(cause)),
  });
  const numericBox = Object.values(box).every((value) => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1);
  if (!open) return compact ? null : <div className="building-model-sidebar-section building-model-region-create"><Button size="sm" variant="outline" onClick={() => setOpen(true)}>{t("buildingModelAddRegion")}</Button></div>;
  return <div className="building-model-sidebar-section building-model-region-create">{!compact && <h2>{t("buildingModelAddRegion")}</h2>}<p className="muted text-ui-2xs">{t("buildingModelRegionHint")} · {t("buildingModelPage")} {sourcePage}</p>{failure && <Callout tone="error">{failure}</Callout>}<form onSubmit={(event) => { event.preventDefault(); if (name.trim() && numericBox && sourceVersionId) createRegion.mutate(); }}>
    <Field label={t("buildingModelRegionType")}><NativeSelect value={kind} onChange={(event) => setKind(event.target.value as "room" | "element")}><option value="room">{t("buildingModelRoom")}</option><option value="element">{t("buildingModelElement")}</option></NativeSelect></Field>
    <Field label={t("buildingModelRegionName")}><Input value={name} onChange={(event) => setName(event.target.value)} required /></Field>
    <Field label={t("buildingModelRegionKey")}><Input value={stableKey} onChange={(event) => setStableKey(event.target.value)} placeholder={slug(name)} /></Field>
    <Field label={t("buildingModelConstructionState")}><NativeSelect value={constructionState} onChange={(event) => setConstructionState(event.target.value)}><option value="existing">{t("buildingModelStateExisting")}</option><option value="demolished">{t("buildingModelStateDemolition")}</option><option value="proposed">{t("buildingModelStateProposed")}</option><option value="retained">{t("buildingModelRetained")}</option></NativeSelect></Field>
    <div className="building-model-region-box">{(["x", "y", "width", "height"] as const).map((key) => <Field key={key} label={key}><Input type="number" min="0" max="1" step="0.001" value={box[key]} onChange={(event) => setBox((current) => ({ ...current, [key]: event.target.value }))} required /></Field>)}</div>
    <div className="building-model-bootstrap-actions"><Button size="sm" type="submit" disabled={createRegion.isPending || !name.trim() || !numericBox || !sourceVersionId}>{t("buildingModelCreateRegion")}</Button>{!compact && <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>{t("cancel")}</Button>}</div>
  </form></div>;
}

export function ExtractionPanel({ job, coverage, source, storeys, selectedStoreyId, onStorey, canStart, pending, onStart, t }: { job?: BuildingExtractionJob; coverage?: { pages?: number | null; regions?: number | null; objects?: number | null; unresolved?: number | null; note?: string | null } | null; source?: BuildingPlanSource; storeys: Array<{ id: string; name?: string; levelIndex?: number | null }>; selectedStoreyId: string; onStorey: (value: string) => void; canStart: boolean; pending: boolean; onStart: () => void; t: ReturnType<typeof useT> }) {
  const active = job?.status === "queued" || job?.status === "running";
  const failed = job?.status === "failed";
  const complete = job?.status === "complete" || job?.status === "succeeded";
  const jobCoverage = job?.coverage;
  const result = job?.result;
  const persistedPhase = result?.phase || job?.phase;
  const runningLabel = job?.status === "queued" ? t("buildingModelExtractionQueued")
    : result?.inference?.active ? t("buildingModelExtractionClassifyingRoomLabels")
    : persistedPhase === "preparing_draft" ? t("buildingModelExtractionPreparingDraft")
    : t("buildingModelExtractionExtractingGeometry");
  const topologyCoverage = result?.topologyCoverage;
  const wallCount = result?.draftWallCount ?? result?.semanticWallCount ?? result?.wallCandidateCount ?? topologyCoverage?.wallCount ?? topologyCoverage?.draftWallCount ?? topologyCoverage?.semanticWallCount;
  const semanticCoverage = topologyCoverage != null || result?.roomHypothesisCount != null || result?.unresolvedAnchorCount != null || result?.constructionAssemblyCount != null || result?.sourceAreaObservationCount != null || wallCount != null;
  const roomCount = result?.roomHypothesisCount ?? topologyCoverage?.approximateRegionCount ?? result?.roomAnchorCount;
  const unresolvedCount = result?.unresolvedAnchorCount ?? topologyCoverage?.unresolvedRegionCount;
  const assemblyCount = result?.constructionFragmentCount ?? result?.constructionAssemblyCount ?? topologyCoverage?.fragmentAssemblyCount ?? topologyCoverage?.assemblyCount ?? result?.elementFootprintCount;
  const sourceAreaCount = result?.sourceAreaObservationCount ?? topologyCoverage?.printedAreaCount;
  const extractionNotes = [...new Set([result?.geometryExtraction?.limitations, coverage?.note, result?.coverage, result?.reason].filter((note): note is string => Boolean(note)))];
  return <section className="building-model-extraction" aria-label={t("buildingModelExtraction") }>
    <div className="building-model-extraction-heading">
      <div><h2>{t("buildingModelExtraction")}</h2><p className="muted text-ui-2xs">{source?.source ? `${source.source.fileName} · ${t("buildingModelPage")} ${source.page}` : t("buildingModelExtractionChooseSource")}</p></div>
      <Button size="sm" variant="outline" type="button" disabled={!canStart || pending || active} onClick={onStart}>{pending ? t("buildingModelExtractionStarting") : active ? runningLabel : failed ? t("buildingModelRetryExtraction") : t("buildingModelExtractCandidates")}</Button>
    </div>
    {storeys.length > 1 && <Field label={t("buildingModelBootstrapStorey")}><NativeSelect value={selectedStoreyId} onChange={(event) => onStorey(event.target.value)}><option value="">{t("buildingModelBootstrapStorey")}</option>{storeys.map((storey) => <option key={storey.id} value={storey.id}>{storey.name || storey.id}</option>)}</NativeSelect></Field>}
    {active && <div className="building-model-status-line" role="status" aria-live="polite" aria-atomic="true"><Badge>{runningLabel}</Badge><small>{t("buildingModelExtractionInProgress")} {typeof job?.progress === "number" ? `· ${Math.round(job.progress * (job.progress <= 1 ? 100 : 1))}%` : ""}</small></div>}
    {failed && <Callout tone="error">{job.error || t("buildingModelExtractionFailed")}</Callout>}
    {complete && <div className="building-model-status-line"><Badge>{t("buildingModelExtractionComplete")}</Badge><small>{job?.result?.method || t("buildingModelExtractionMethodUnknown")} · {job?.result?.geometryQuality ? `${t("buildingModelGeometryQuality")}: ${job.result.geometryQuality}` : t("buildingModelGeometryQualityUnknown")}</small></div>}
    {complete && <div className="building-model-extraction-grid" aria-label={t("buildingModelSourceCoverage")}>
      <div className="building-model-extraction-stat"><strong>{job ? 1 : "—"}</strong><small>{t("buildingModelCoveragePages")}</small></div>
      <div className="building-model-extraction-stat"><strong>{roomCount ?? "—"}</strong><small>{t(semanticCoverage ? "buildingModelCoverageRoomHypotheses" : "buildingModelCoverageRoomAnchors")}</small></div>
      {semanticCoverage && <div className="building-model-extraction-stat"><strong>{unresolvedCount ?? "—"}</strong><small>{t("buildingModelCoverageUnresolvedAnchors")}</small></div>}
      {wallCount != null && <div className="building-model-extraction-stat"><strong>{wallCount}</strong><small>{t("buildingModelCoverageDraftWalls")}</small></div>}
      <div className="building-model-extraction-stat"><strong>{assemblyCount ?? "—"}</strong><small>{t(semanticCoverage ? "buildingModelCoverageAssemblies" : "buildingModelCoverageFootprints")}</small></div>
      {semanticCoverage && <div className="building-model-extraction-stat"><strong>{sourceAreaCount ?? "—"}</strong><small>{t("buildingModelCoverageSourceAreas")}</small></div>}
      <div className="building-model-extraction-stat"><strong>{result?.candidateCount ?? jobCoverage?.regions ?? coverage?.regions ?? "—"}</strong><small>{t("buildingModelCoverageTotalCandidates")}</small></div>
    </div>}
    {extractionNotes.length > 0 && <p className="muted text-ui-2xs">{extractionNotes.join(" ")}</p>}
    {!job && <p className="muted text-ui-2xs">{t("buildingModelExtractionNotRun")}</p>}
  </section>;
}


function printedArea(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return `${value} m²`;
  if (value && typeof value === "object" && (value as RecordData).value != null) return `${(value as RecordData).value} ${(value as RecordData).unit || "m²"}`;
  return null;
}

function printedAreaValue(value: unknown) {
  const number = typeof value === "number" ? value : value && typeof value === "object" ? Number((value as RecordData).value) : NaN;
  return Number.isFinite(number) && number > 0 ? number : null;
}

const formatSquareMetres = (value: number) => `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m²`;

/** A collapsible Blender-style panel section; native details so content stays in the document. */
function PropertySection({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  return <details className="building-model-property-section" open={defaultOpen}>
    <summary><ChevronRight className="size-icon-sm building-model-caret" aria-hidden="true" /><span>{title}</span></summary>
    <div className="building-model-property-body">{children}</div>
  </details>;
}

type OutlinerStorey = { id: string; label: string; level: number | null; current: boolean; page: number | null; items: BuildingRegion[]; onOpen?: () => void };
type OutlinerNode = { key: string; label: string; items: BuildingRegion[]; visible?: boolean; onVisible?: (visible: boolean) => void };

function VisibilityToggle({ visible, label, onToggle }: { visible: boolean; label: string; onToggle: () => void }) {
  const Icon = visible ? Eye : EyeOff;
  return <button type="button" className={`building-model-eye${visible ? "" : " is-hidden"}`} aria-pressed={visible} aria-label={label} title={label} onClick={onToggle}><Icon className="size-icon-sm" aria-hidden="true" /></button>;
}

export function Outliner({ t, storeys, groups, categories, otherPages, layers, layerVisible, onLayer, selectedId, isVisible, onVisible, areaOf, onSelect, addRegion, footer }: {
  t: ReturnType<typeof useT>; storeys: OutlinerStorey[]; groups: OutlinerNode[]; categories: OutlinerNode[]; otherPages: BuildingRegion[];
  layers: Array<{ id: string; label: string; visible?: boolean }>; layerVisible: (layer: { id: string; visible?: boolean }) => boolean; onLayer: (id: string, visible: boolean) => void;
  selectedId?: string; isVisible: (region: BuildingRegion) => boolean; onVisible: (regions: BuildingRegion[], visible: boolean) => void;
  areaOf: (region: BuildingRegion) => number | null; onSelect: (region: BuildingRegion) => void; addRegion: ReactNode; footer?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const tree = useRef<HTMLDivElement>(null);
  // Keep the selected object in view when it is picked on the plan.
  useEffect(() => { tree.current?.querySelector(".building-model-tree-row.is-selected")?.scrollIntoView({ block: "nearest" }); }, [selectedId]);
  const needle = query.trim().toLowerCase();
  const matches = (region: BuildingRegion) => !needle || region.label.toLowerCase().includes(needle) || Boolean(region.groupLabel?.toLowerCase().includes(needle));
  const open = (key: string, fallback: boolean) => Boolean(needle) || (expanded[key] ?? fallback);
  const toggle = (key: string, fallback: boolean) => setExpanded((current) => ({ ...current, [key]: !(current[key] ?? fallback) }));
  const show = t("buildingModelShow"), hide = t("buildingModelHide");
  const branch = (key: string, label: string, level: number, fallback: boolean, count: number, eye?: ReactNode) => <div className="building-model-tree-row is-branch" data-level={level}>
    <button type="button" className="building-model-tree-main" aria-expanded={open(key, fallback)} onClick={() => toggle(key, fallback)}>
      <ChevronRight className="size-icon-sm building-model-caret" aria-hidden="true" /><span className="building-model-tree-label">{label}</span><span className="building-model-tree-meta">{count}</span>
    </button>
    {eye}
  </div>;
  const item = (region: BuildingRegion, level: number, meta: ReactNode) => {
    const visible = isVisible(region), selected = region.id === selectedId;
    return <div key={region.id} className={`building-model-tree-row${selected ? " is-selected" : ""}`} data-level={level}>
      <button type="button" className="building-model-tree-main" data-workbench-enter aria-pressed={selected} onClick={() => onSelect(region)}>
        <span className={`building-model-status-dot${region.isCandidate ? " is-candidate" : " is-accepted"}${region.kind === "unknown-room" ? " is-unknown" : ""}`} aria-hidden="true" />
        <span className="building-model-tree-label">{region.label}</span><span className="building-model-tree-meta">{meta}</span>
      </button>
      <VisibilityToggle visible={visible} label={`${visible ? hide : show}: ${region.label}`} onToggle={() => onVisible([region], !visible)} />
    </div>;
  };
  const areaMeta = (region: BuildingRegion) => { const area = areaOf(region); return area != null ? formatSquareMetres(area) : printedArea(region.sourceArea) ?? ""; };
  const node = (group: OutlinerNode, level: number, fallback: boolean, meta: (region: BuildingRegion) => ReactNode) => {
    const items = group.items.filter(matches);
    if (!items.length) return null;
    const visible = group.visible ?? items.some(isVisible), isOpen = open(group.key, fallback || items.some((region) => region.id === selectedId));
    return <div key={group.key} role="group" aria-label={group.label}>
      {branch(group.key, group.label, level, fallback || items.some((region) => region.id === selectedId), items.length,
        <VisibilityToggle visible={visible} label={`${visible ? hide : show}: ${group.label}`} onToggle={() => group.onVisible ? group.onVisible(!visible) : onVisible(items, !visible)} />)}
      <div hidden={!isOpen}>{items.map((region) => item(region, level + 1, meta(region)))}</div>
    </div>;
  };
  const storeyCount = [...groups, ...categories].reduce((sum, group) => sum + group.items.filter(matches).length, 0);
  const visibleLayers = layers.filter((layer) => !needle || layer.label.toLowerCase().includes(needle));
  return <aside className="building-model-outliner" aria-label={t("buildingModelOutliner")}>
    <div className="building-model-panel-header">
      <h2 className="building-model-panel-title">{t("buildingModelOutliner")}</h2>
      <Popover>
        <PopoverTrigger asChild><Button variant="ghost" size="icon-xs" type="button" className="building-model-panel-action" aria-label={t("buildingModelAddRegion")} title={t("buildingModelAddRegion")}><Plus className="size-icon-sm" aria-hidden="true" /></Button></PopoverTrigger>
        <PopoverContent align="start" side="right" className="building-model-add-popover"><h2 className="building-model-panel-title">{t("buildingModelAddRegion")}</h2>{addRegion}</PopoverContent>
      </Popover>
    </div>
    <label className="building-model-outliner-search"><Search className="size-icon-sm" aria-hidden="true" /><Input className="h-control-sm" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("buildingModelSearchObjects")} aria-label={t("buildingModelSearchObjects")} /></label>
    <div ref={tree} className="building-model-tree">
      {storeys.map((storey) => {
        const key = `storey:${storey.id}`;
        if (storey.current) return <div key={key} role="group" aria-label={storey.label} className="building-model-tree-storey is-current">
          {branch(key, storey.label, 0, true, storeyCount)}
          <div hidden={!open(key, true)}>
            {groups.map((group) => node(group, 1, true, areaMeta))}
            {categories.map((category) => node(category, 1, false, () => ""))}
            {!storeyCount && <p className="building-model-tree-empty">{needle ? t("buildingModelNoMatches") : t("buildingModelNoObjects")}</p>}
          </div>
        </div>;
        const items = storey.items.filter(matches);
        if (needle && !items.length) return null;
        const openLabel = storey.page ? t("buildingModelOpenStoreyPlan").replace("{page}", String(storey.page)) : "";
        return <div key={key} role="group" aria-label={storey.label} className="building-model-tree-storey">
          {branch(key, storey.label, 0, false, items.length, storey.onOpen && <button type="button" className="building-model-eye" aria-label={`${openLabel}: ${storey.label}`} title={openLabel} onClick={storey.onOpen}><FileText className="size-icon-sm" aria-hidden="true" /></button>)}
          <div hidden={!open(key, false)}>{items.map((region) => item(region, 1, `${t("buildingModelPageShort")} ${region.page}`))}</div>
        </div>;
      })}
      {otherPages.some(matches) && <div role="group" aria-label={t("buildingModelOtherPages")}>
        {branch("other", t("buildingModelOtherPages"), 0, false, otherPages.filter(matches).length)}
        <div hidden={!open("other", false)}>{otherPages.filter(matches).map((region) => item(region, 1, `${t("buildingModelPageShort")} ${region.page}`))}</div>
      </div>}
      {visibleLayers.length > 0 && <div role="group" aria-label={t("buildingModelEvidenceLayers")}>
        {branch("layers", t("buildingModelEvidenceLayers"), 0, false, visibleLayers.length)}
        <div hidden={!open("layers", false)}>{visibleLayers.map((layer) => {
          const visible = layerVisible(layer);
          return <div key={layer.id} className="building-model-tree-row" data-level={1}>
            <span className="building-model-tree-main"><span className="building-model-tree-label">{layer.label}</span></span>
            <VisibilityToggle visible={visible} label={`${visible ? hide : show}: ${layer.label}`} onToggle={() => onLayer(layer.id, !visible)} />
          </div>;
        })}</div>
      </div>}
    </div>
    {footer}
  </aside>;
}

function OutlineThumbnail({ draft, aspect }: { draft: OutlineDraft; aspect: number }) {
  const xs = draft.polygon.map((point) => point.x * aspect), ys = draft.polygon.map((point) => point.y);
  const minX = Math.min(...xs), minY = Math.min(...ys), width = Math.max(...xs) - minX || 1e-6, height = Math.max(...ys) - minY || 1e-6, pad = Math.max(width, height) * .08;
  const ring = (points: BuildingPlanPoint[]) => `M${points.map((point) => `${(point.x * aspect).toFixed(6)} ${point.y.toFixed(6)}`).join("L")}Z`;
  return <svg className="building-model-outline-thumb" viewBox={`${minX - pad} ${minY - pad} ${width + pad * 2} ${height + pad * 2}`} aria-hidden="true">
    <path d={[draft.polygon, ...draft.holes].map(ring).join("")} fillRule="evenodd" vectorEffect="non-scaling-stroke" />
  </svg>;
}

function VertexInput({ value, label, disabled, onCommit }: { value: string; label: string; disabled?: boolean; onCommit: (value: number) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => { const number = Number(text.replace(",", ".")); if (text !== value && Number.isFinite(number)) onCommit(number); else setText(value); };
  return <Input className="building-model-vertex-input" inputMode="decimal" value={text} aria-label={label} disabled={disabled} onChange={(event) => setText(event.target.value)} onBlur={commit}
    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } if (event.key === "Escape") { setText(value); event.currentTarget.blur(); } }} />;
}

function GeometrySection({ draft, scale, printed, editing, snap, onSnap, onEditVertex, canEdit, onEdit, t }: {
  draft: OutlineDraft | null; scale: PageScale | null; printed: unknown; editing: boolean; snap: boolean; onSnap: (snap: boolean) => void;
  onEditVertex: (index: number, point: BuildingPlanPoint) => void; canEdit: boolean; onEdit: () => void; t: ReturnType<typeof useT>;
}) {
  const [showAll, setShowAll] = useState(false);
  const area = draft ? outlineAreaM2(draft, scale) : null;
  const printedValue = printedAreaValue(printed);
  const delta = area != null && printedValue ? (area - printedValue) / printedValue * 100 : null;
  const metric = Boolean(scale?.metresPerPageHeight);
  const points = draft?.polygon ?? [];
  const shown = showAll ? points : points.slice(0, 6);
  // Without a printed scale, points are edited as a percentage of the page.
  const display = (point: BuildingPlanPoint) => metric ? pointToMetres(point, scale!) : { x: point.x * 100, y: point.y * 100 };
  const fromDisplay = (value: { x: number; y: number }) => metric ? metresToPoint(value, scale!) : { x: Math.min(1, Math.max(0, value.x / 100)), y: Math.min(1, Math.max(0, value.y / 100)) };
  const unit = metric ? "m" : "%", digits = metric ? 3 : 2;
  return <PropertySection title={t("buildingModelSectionGeometry")}>
    {draft ? <>
      <div className="building-model-geometry-summary">
        <OutlineThumbnail draft={draft} aspect={scale?.pageAspectRatio ?? 1} />
        <dl className="building-model-readouts">
          <div><dt>{t("buildingModelOutlineArea")}</dt><dd>{area == null ? "—" : formatSquareMetres(area)}</dd></div>
          <div><dt>{t("buildingModelPrintedArea")}</dt><dd>{printedArea(printed) ?? "—"}</dd></div>
          <div><dt>{t("buildingModelAreaDifference")}</dt><dd>{delta == null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)} %`}</dd></div>
          <div><dt>{t("buildingModelOutlinePoints")}</dt><dd>{points.length}</dd></div>
        </dl>
      </div>
      <Table className="building-model-vertex-table">
        <TableHeader><TableRow><TableHead>#</TableHead><TableHead>X ({unit})</TableHead><TableHead>Y ({unit})</TableHead></TableRow></TableHeader>
        <TableBody>{shown.map((point, index) => {
          const value = display(point);
          return <TableRow key={index}>
            <TableCell>{index + 1}</TableCell>
            <TableCell><VertexInput value={value.x.toFixed(digits)} label={`${t("buildingModelOutlinePoint")} ${index + 1} X`} disabled={!canEdit && !editing} onCommit={(x) => onEditVertex(index, fromDisplay({ x, y: value.y }))} /></TableCell>
            <TableCell><VertexInput value={value.y.toFixed(digits)} label={`${t("buildingModelOutlinePoint")} ${index + 1} Y`} disabled={!canEdit && !editing} onCommit={(y) => onEditVertex(index, fromDisplay({ x: value.x, y }))} /></TableCell>
          </TableRow>;
        })}</TableBody>
      </Table>
      {points.length > 6 && <button type="button" className="building-model-link-button" onClick={() => setShowAll(!showAll)}>{showAll ? t("buildingModelShowFewer") : `${t("buildingModelShowAll")} ${points.length}`}</button>}
    </> : <span className="building-model-unknown text-ui-xs">{t("buildingModelNoOutline")}</span>}
    {editing ? <label className="building-model-switch-row" title={t("buildingModelSnapHint")}><span>{t("buildingModelSnapToWalls")}</span><Switch size="sm" checked={snap} onCheckedChange={onSnap} /></label>
      : canEdit && <Button size="xs" variant="outline" type="button" className="building-model-geometry-edit" onClick={onEdit}><Spline className="size-icon-sm" aria-hidden="true" />{draft ? t("buildingModelEditOutline") : t("buildingModelDrawOutline")}<kbd>E</kbd></Button>}
  </PropertySection>;
}

export function OutlineSection({ session, canCreateRoom, pending, t, onUpdate, onBegin }: {
  session: OutlineSession; canCreateRoom: boolean; pending: boolean; t: ReturnType<typeof useT>;
  onUpdate: (update: (session: OutlineSession) => OutlineSession) => void; onBegin: () => void;
}) {
  const target = session.target;
  const scopeLabel = (scope: MagicOutline["scope"]) => t(scope === "room" ? "buildingModelOutlineScopeRoom" : scope === "space" ? "buildingModelOutlineScopeSpace" : "buildingModelOutlineScopeConstruction");
  const targetLabel = (item: OutlineTarget) => item.type === "new_room" ? t("buildingModelOutlineNewRoom") : `${item.label} · ${item.type === "candidate" ? t("buildingModelUnreviewedCandidate") : t("buildingModelOutlineRoom")}`;
  return <PropertySection title={t("buildingModelOutline")}>
    <dl>
      <dt>{t("buildingModelOutlineMethod")}</dt><dd><Badge>{session.method === "magic_selection" ? t("buildingModelToolMagic") : t("buildingModelEditOutline")}</Badge></dd>
      {session.magic && session.magic.options.length > 1 && <><dt>{t("buildingModelOutlineScope")}</dt><dd>
        <Segmented value={String(session.magic.index)} onChange={(value) => { onBegin(); onUpdate((current) => { const option = current.magic!.options[Number(value)]!; return { ...current, magic: { ...current.magic!, index: Number(value) }, draft: { polygon: option.polygon, holes: option.holes } }; }); }}
          items={session.magic.options.map((option, index) => ({ value: String(index), label: scopeLabel(option.scope) }))} />
      </dd></>}
      {session.targets.length > 1 && <><dt>{t("buildingModelOutlineTarget")}</dt><dd>
        <NativeSelect aria-label={t("buildingModelOutlineTarget")} value={String(session.targets.indexOf(target))} onChange={(event) => onUpdate((current) => ({ ...current, target: current.targets[Number(event.target.value)]! }))} disabled={pending}>
          {session.targets.map((item, index) => <option key={index} value={index} disabled={item.type === "new_room" && !canCreateRoom}>{targetLabel(item)}</option>)}
        </NativeSelect>
      </dd></>}
      {target.type === "new_room" && <><dt>{t("buildingModelOutlineRoomName")}</dt><dd><Input autoFocus aria-label={t("buildingModelOutlineRoomName")} value={session.name} onChange={(event) => onUpdate((current) => ({ ...current, name: event.target.value }))} disabled={pending} /></dd></>}
    </dl>
    {outlineSelfIntersects(session.draft.polygon) && <Callout tone="warning">{t("buildingModelOutlineCrossing")}</Callout>}
  </PropertySection>;
}

/** Unreviewed rooms from the same extraction whose bounds touch or nearly touch this room's: the rooms it can merge with. */
export function neighbouringRooms(candidate: BuildingExtractionCandidate, candidates: BuildingExtractionCandidate[]) {
  const a = candidate.box;
  if (!a || !candidate.polygon?.length) return [];
  return candidates.filter((other) => other.id !== candidate.id && other.entityType === "room" && other.kind !== "element" && other.jobId === candidate.jobId && other.polygon?.length && other.box
    && Math.max(other.box.x - a.x - a.width, a.x - other.box.x - other.box.width, other.box.y - a.y - a.height, a.y - other.box.y - other.box.height) <= .012)
    .sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true }));
}

function MergeRoomsSection({ candidate, options, pending, t, onMerge, onSplit }: { candidate: BuildingExtractionCandidate; options: BuildingExtractionCandidate[]; pending: boolean; t: ReturnType<typeof useT>; onMerge: (other: BuildingExtractionCandidate) => void; onSplit: () => void }) {
  const [otherId, setOtherId] = useState("");
  useEffect(() => setOtherId(""), [candidate.id]);
  const other = options.find((option) => option.id === otherId);
  if (candidate.mergedFrom?.length) return <PropertySection title={t("buildingModelMergeRooms")}>
    <p className="building-model-merge-note muted text-ui-sm">{t("buildingModelMergedFrom").replace("{rooms}", candidate.mergedFrom.join(", "))}</p>
    <Button size="xs" variant="outline" type="button" disabled={pending} onClick={onSplit}>{t("buildingModelSplitRooms")}</Button>
  </PropertySection>;
  return <PropertySection title={t("buildingModelMergeRooms")} defaultOpen={false}>
    {options.length ? <>
      <dl>
        <dt>{t("buildingModelMergeWith")}</dt>
        <dd><NativeSelect aria-label={t("buildingModelMergeWith")} value={otherId} onChange={(event) => setOtherId(event.target.value)} disabled={pending}>
          <option value="">{t("buildingModelChooseRoom")}</option>
          {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </NativeSelect></dd>
      </dl>
      <Button size="xs" variant="outline" type="button" disabled={pending || !other} onClick={() => other && onMerge(other)}>{t("buildingModelMergeRoomsAction")}</Button>
    </> : <p className="building-model-merge-note muted text-ui-sm">{t("buildingModelMergeNoNeighbours")}</p>}
  </PropertySection>;
}

export function CandidateInspector({ candidate, regions, t, pending, onPage, onReview, edit = {}, onEdit, geometry, mergeOptions = [], onMerge, onSplit }: { candidate: BuildingExtractionCandidate; regions: BuildingRegion[]; t: ReturnType<typeof useT>; pending: boolean; onPage: (page: number) => void; onReview: (decision: "approved" | "rejected", correction?: RecordData) => void; edit?: CandidateEdit; onEdit?: (edit: CandidateEdit) => void; geometry?: ReactNode; mergeOptions?: BuildingExtractionCandidate[]; onMerge?: (other: BuildingExtractionCandidate) => void; onSplit?: () => void }) {
  const name = edit.name ?? candidate.label;
  const targetEntityId = edit.targetEntityId ?? candidate.match?.existingId ?? "";
  const propertyEntries = Object.entries(candidate.properties || {});
  const role = candidate.candidateRole || candidateRole(candidate);
  const isConstructionHypothesis = role === "draft-wall" || role === "construction-assembly";
  const sourceMinorDimension = Number(candidate.classification?.pageRelativeMinorDimension);
  const sourceMinorDimensionLabel = Number.isFinite(sourceMinorDimension) ? `${(sourceMinorDimension * 100).toFixed(3)}%` : null;
  const geometryLabel = role === "draft-wall" ? t("buildingModelGeometryDraftWall") : role === "construction-assembly" ? t("buildingModelConstructionFragmentGeometry") : candidate.geometryQuality === "anchor" ? t("buildingModelGeometryAnchor") : candidate.geometryQuality === "footprint" ? t("buildingModelGeometryFootprint") : candidate.geometryQuality === "approximate_partition" || candidate.geometryQuality === "approximate_region" ? t("buildingModelGeometryApproximateRegion") : candidate.geometryQuality === "enclosed_region" ? t("buildingModelGeometryEnclosedRegion") : candidate.geometryQuality === "manual_outline" ? t("buildingModelGeometryManualOutline") : candidate.geometryQuality || t("buildingModelGeometryQualityUnknown");
  const sourceLayer = candidate.layerName && candidate.layerId ? `${candidate.layerName} · ${candidate.layerId}` : candidate.layerName || candidate.layerId || t("buildingModelNoSourceLayer");
  const sourceCoordinates = candidate.box ? `x ${candidate.box.x.toFixed(5)} · y ${candidate.box.y.toFixed(5)} · w ${candidate.box.width.toFixed(5)} · h ${candidate.box.height.toFixed(5)}` : "—";
  const polygonCoordinates = candidate.polygon?.map((point) => `${point.x.toFixed(5)}, ${point.y.toFixed(5)}`).join(" · ");
  const partPolygonCoordinates = candidate.parts?.map((part, index) => `${index + 1}: ${part.polygon.map((point) => `${point.x.toFixed(5)},${point.y.toFixed(5)}`).join(" · ")}`).join("\n");
  const geometryLimitations = candidate.geometryLimitations || (candidate.geometryQuality === "anchor" ? t("buildingModelGeometryAnchor") : candidate.geometryQuality === "approximate_partition" || candidate.geometryQuality === "approximate_region" ? t("buildingModelGeometryApproximateRegion") : candidate.geometryQuality === "enclosed_region" ? t("buildingModelGeometryEnclosedRegion") : t("buildingModelGeometryLimitationsUnknown"));
  const sourceArea = typeof candidate.sourceArea === "number" && Number.isFinite(candidate.sourceArea) ? `${candidate.sourceArea} m²` : candidate.sourceArea && typeof candidate.sourceArea === "object" ? (() => { const area = candidate.sourceArea as RecordData; return area.value == null ? JSON.stringify(area) : `${area.value}${area.unit ? ` ${area.unit}` : ""}`; })() : typeof candidate.sourceArea === "string" ? candidate.sourceArea : undefined;
  const roomUseProposal = candidate.roomUseProposal?.roomUse;
  const proposalConfidence = typeof candidate.roomUseProposal?.confidence === "number" ? `${Math.round(candidate.roomUseProposal.confidence * 100)}%` : undefined;
  const formatUnknown = (value: unknown) => value == null || value === "" ? t("buildingModelUnknownValue") : typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value);
  const candidateWarning = role === "draft-wall" ? t("buildingModelDraftWallWarning") : role === "unresolved-anchor" ? t("buildingModelAnchorWarning") : role === "room-region" ? t("buildingModelRoomRegionWarning") : t("buildingModelCandidateWarning");
  const matchOptions = regions.filter((region) => region.entityType === candidate.entityType);
  return <>
    <PropertySection title={candidate.entityType === "room" ? t("buildingModelSectionRoom") : t("buildingModelSectionElement")}>
      <dl>
        <dt>{t("buildingModelLabel")}</dt><dd><Input aria-label={t("buildingModelLabel")} title={t("buildingModelCandidateCorrectionHint")} value={name} onChange={(event) => onEdit?.({ name: event.target.value })} disabled={pending} /></dd>
        <dt>{t("buildingModelCandidateType")}</dt><dd>{candidateTypeLabel(candidate, t)}</dd>
        <dt>{t("status")}</dt><dd><Badge title={candidateWarning}>{t("buildingModelUnreviewedCandidate")}</Badge></dd>
        {candidate.groupLabel && <><dt>{t("buildingModelCandidateGroup")}</dt><dd>{candidate.groupLabel}</dd></>}
        {candidate.entityType === "room" ? <><dt>{t("buildingModelRoomUse")}</dt><dd className={!candidate.roomUse && !roomUseProposal ? "building-model-unknown" : undefined}>{candidate.roomUse || (roomUseProposal ? <>{roomUseProposal.replaceAll("_", " ")} {proposalConfidence ? `· ${proposalConfidence}` : ""} <Badge title={`${candidate.roomUseProposal?.provider || "TypeSafe"}${candidate.roomUseProposal?.model ? ` / ${candidate.roomUseProposal.model}` : ""}`}>{t("buildingModelUnreviewedProposal")}</Badge></> : t("buildingModelUnknownValue"))}</dd></> : <>
          <dt>{t("buildingModelWallThickness")}</dt><dd className={isConstructionHypothesis || candidate.wallThickness == null ? "building-model-unknown" : undefined}>{formatUnknown(isConstructionHypothesis ? null : candidate.wallThickness)}</dd>
          <dt>{t("buildingModelMaterial")}</dt><dd className={isConstructionHypothesis || candidate.material == null ? "building-model-unknown" : undefined}>{formatUnknown(isConstructionHypothesis ? null : candidate.material)}</dd>
          <dt>{t("buildingModelConstructionState")}</dt><dd className={!candidate.constructionState ? "building-model-unknown" : undefined}>{candidate.constructionState || t("buildingModelUnknownValue")}{isConstructionHypothesis && candidate.constructionState && candidate.constructionState !== "unknown" && <small className="block muted text-ui-xs">{t("buildingModelInferredSourcePhase")}</small>}</dd>
          <dt>{t("buildingModelSourceScale")}</dt><dd className={candidate.sourceScale == null ? "building-model-unknown" : undefined}>{formatUnknown(candidate.sourceScale)}</dd>
        </>}
      </dl>
    </PropertySection>
    {geometry}
    {candidate.entityType === "room" && onMerge && onSplit && <MergeRoomsSection candidate={candidate} options={mergeOptions} pending={pending} t={t} onMerge={onMerge} onSplit={onSplit} />}
    <PropertySection title={t("buildingModelMatchExisting")} defaultOpen={Boolean(targetEntityId)}>
      <dl>
        <dt>{candidate.entityType === "element" ? t("buildingModelExistingElement") : t("buildingModelExistingObject")}</dt>
        <dd><NativeSelect aria-label={t("buildingModelMatchExisting")} title={t("buildingModelMatchHint")} value={targetEntityId} onChange={(event) => onEdit?.({ targetEntityId: event.target.value })} disabled={pending}><option value="">{t("buildingModelNoMatch")}</option>{matchOptions.map((region) => <option key={region.id} value={region.id}>{region.label} · {region.id}</option>)}</NativeSelect></dd>
      </dl>
      <Button size="xs" variant="outline" type="button" disabled={pending || !targetEntityId} onClick={() => onReview("approved", { targetEntityId })}>{t("buildingModelReconcile")}</Button>
    </PropertySection>
    <PropertySection title={t("buildingModelSectionSource")}>
      <dl>
        <dt>{t("buildingModelSourcePage")}</dt><dd><button type="button" className="building-model-link-button" onClick={() => onPage(candidate.page)}>{t("buildingModelPage")} {candidate.page}</button></dd>
        <dt>{t("buildingModelSourceLayer")}</dt><dd>{sourceLayer}</dd>
        {sourceArea && <><dt>{t("buildingModelSourceArea")}</dt><dd>{sourceArea}</dd></>}
        {propertyEntries.map(([key, value]) => <Fragment key={key}><dt>{key}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd></Fragment>)}
        {candidate.evidence?.map((item, index) => <Fragment key={index}><dt>{item.label || t("buildingModelSourcePage")}</dt><dd>{item.value || "—"} {item.page ? `· ${t("buildingModelPage")} ${item.page}` : ""}</dd></Fragment>)}
        {candidate.uncertainty != null && <><dt>{t("buildingModelUncertainty")}</dt><dd>{typeof candidate.uncertainty === "string" ? candidate.uncertainty : JSON.stringify(candidate.uncertainty)}</dd></>}
      </dl>
    </PropertySection>
    <PropertySection title={t("buildingModelTechnicalSourceDetails")} defaultOpen={false}>
      <dl>
        <dt>{t("buildingModelSourceVersion")}</dt><dd className="mono">{candidate.sourceVersionId || t("buildingModelUnknownValue")}</dd>
        <dt>{t("buildingModelStorey")}</dt><dd className={!candidate.storeyId ? "building-model-unknown" : undefined}>{candidate.storeyId || t("buildingModelUnknownValue")}</dd>
        <dt>{t("buildingModelGeometryQuality")}</dt><dd>{geometryLabel}</dd>
        {candidate.algorithm && <><dt>{t("buildingModelAlgorithm")}</dt><dd>{candidate.algorithm}</dd></>}
        {candidate.classification?.method != null && <><dt>{t("buildingModelClassificationMethod")}</dt><dd>{String(candidate.classification.method)}</dd></>}
        {sourceMinorDimensionLabel && <><dt>{t("buildingModelSourceMinorDimension")}</dt><dd>{sourceMinorDimensionLabel}</dd></>}
        {candidate.classification?.evidenceTier != null && <><dt>{t("buildingModelEvidenceTier")}</dt><dd>{String(candidate.classification.evidenceTier)}</dd></>}
        {candidate.classification?.sourcePolygonExact != null && <><dt>{t("buildingModelSourcePolygonExact")}</dt><dd>{candidate.classification.sourcePolygonExact ? t("buildingModelYes") : t("buildingModelNo")}</dd></>}
        {(candidate.competingLabels?.length ?? 0) > 0 && <><dt>{t("buildingModelCompetingLabels")}</dt><dd><details className="building-model-competing-labels"><summary>{candidate.competingLabels!.length} {t("buildingModelCompetingLabelCount")}</summary><code>{candidate.competingLabels!.join("\n")}</code></details></dd></>}
        {(candidate.sourceFootprintKeys?.length ?? 0) > 0 && <><dt>{t("buildingModelSourceFootprints")}</dt><dd><code className="building-model-source-coordinates">{candidate.sourceFootprintKeys!.join(" · ")}</code></dd></>}
        {(candidate.parts?.length ?? 0) > 0 && <><dt>{t("buildingModelGeometryParts")}</dt><dd>{candidate.parts!.length}</dd></>}
        <dt>{t("buildingModelSourceCoordinates")}</dt><dd><code className="building-model-source-coordinates">{sourceCoordinates}</code>{polygonCoordinates && <details className="building-model-source-polygons"><summary>{t("buildingModelExactSourcePolygon")}</summary><code>{polygonCoordinates}</code></details>}{partPolygonCoordinates && <details className="building-model-source-polygons"><summary>{t("buildingModelExactSourcePolygons")}</summary><code>{partPolygonCoordinates}</code></details>}</dd>
        <dt>{t("buildingModelGeometryLimitations")}</dt><dd>{geometryLimitations}</dd>
      </dl>
    </PropertySection>
  </>;
}

function ObjectInspector({ region, sourcePage, sourceVersionId, sourceRegion, proposals, t, onPage, onSave, onMeasurementSave, pending, geometry, components, wallType }: { components?: ReactNode; wallType?: ReactNode; region: BuildingRegion; sourcePage: number; sourceVersionId?: string; sourceRegion?: BuildingRegion["box"]; proposals: RecordData[]; t: ReturnType<typeof useT>; onPage: (page: number) => void; onSave: (body: RecordData) => void; onMeasurementSave: (measurement: NonNullable<BuildingRegion["measurements"]>[number], value: number) => void; pending: boolean; geometry?: ReactNode }) {
  const [label, setLabel] = useState(region.label);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  useEffect(() => setLabel(region.label), [region.id, region.label]);
  const copyId = () => {
    setCopyFailed(false);
    void copyStableObjectId(region.id).then((success) => {
      if (success) { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
      else { setCopied(false); setCopyFailed(true); }
    });
  };
  const commitLabel = () => { if (label.trim() && label.trim() !== region.label) onSave({ name: label.trim() }); else setLabel(region.label); };
  return (
    <>
      <PropertySection title={region.entityType === "element" || region.kind === "element" ? t("buildingModelSectionElement") : t("buildingModelSectionRoom")}>
        <dl>
          <dt>{t("buildingModelLabel")}</dt><dd><Input aria-label={t("buildingModelLabel")} title={t("buildingModelCorrectionHint")} value={label} disabled={pending} onChange={(event) => setLabel(event.target.value)} onBlur={commitLabel} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } if (event.key === "Escape") { setLabel(region.label); } }} /></dd>
          {region.entityType === "room" && <><dt>{t("buildingModelRoomUse")}</dt><dd><Input aria-label={t("buildingModelRoomUse")} title={t("buildingModelRoomUseHint")} defaultValue={region.roomUse || ""} onBlur={(event) => { if (sourceVersionId && event.target.value !== (region.roomUse || "")) onSave({ roomUse: event.target.value.trim() || null, evidence: [{ kind: "page", sourceVersionId, page: sourcePage, ...(region.box ? { region: region.box } : {}) }] }); }} /></dd></>}
          <dt>{t("status")}</dt><dd><Badge>{region.kind === "unknown-room" ? t("buildingModelUnknownRoom") : t("buildingModelAccepted")}</Badge></dd>
          {region.groupLabel && <><dt>{t("buildingModelCandidateGroup")}</dt><dd>{region.groupLabel}</dd></>}
          <dt>{t("buildingModelObjectId")}</dt><dd><button type="button" className="building-model-id-copy mono" onClick={copyId} title={t("buildingModelCopyObjectId")} aria-label={`${t("buildingModelCopyObjectId")}: ${region.id}`}><span>{region.id}</span><Copy className="size-icon-sm" aria-hidden="true" />{copied && <small>{t("buildingModelCopiedObjectId")}</small>}{copyFailed && <small>{t("buildingModelCopyUnavailable")}</small>}</button></dd>
        </dl>
      </PropertySection>
      {components && <PropertySection title={region.entityType === "room" ? t("buildingComponentSpace") : t("buildingComponentComponent")}>{components}</PropertySection>}
      {wallType && <PropertySection title={t("buildingComponentTypeReview")} defaultOpen={false}>{wallType}</PropertySection>}
      {geometry}
      <PropertySection title={t("buildingModelMeasurements")} defaultOpen={Boolean(region.measurements?.length)}>
        {region.measurements?.length ? region.measurements.map((measurement) => (
          <Measurement key={measurement.key} measurement={measurement} t={t} onSave={(value) => onMeasurementSave(measurement, value)} pending={pending} />
        )) : <NewMeasurementForm t={t} pending={pending} onSave={(measurement, value) => onMeasurementSave({ ...measurement, evidence: sourceVersionId ? [{ kind: "page", sourceVersionId, page: sourcePage, ...(sourceRegion ? { region: sourceRegion } : {}) }] : [] }, value)} />}
      </PropertySection>
      <PropertySection title={t("buildingModelPendingProposals")} defaultOpen={proposals.length > 0}>
        {proposals.length ? proposals.map((proposal) => <div className="building-model-evidence-row" key={proposal.id}><span><Badge>{t("buildingModelPending")}</Badge> {String(proposal.payload?.value ?? proposal.payload?.proposedValue ?? "—")}</span><small>{String(proposal.payload?.reason || t("buildingModelNoReason"))} {proposal.payload?.evidence?.[0]?.page ? `· ${t("buildingModelPage")} ${proposal.payload.evidence[0].page}` : ""}</small></div>) : <span className="building-model-unknown text-ui-xs">{t("buildingModelNoPendingProposals")}</span>}
      </PropertySection>
      <PropertySection title={t("buildingModelSectionSource")}>
        <dl>
          <dt>{t("buildingModelSourcePage")}</dt><dd><button type="button" className="building-model-link-button" onClick={() => onPage(sourcePage)}>{t("buildingModelPage")} {sourcePage}</button></dd>
        </dl>
        {region.evidence?.length ? region.evidence.map((item, index) => <div className="building-model-evidence-row" key={`${item.label}-${index}`}><span>{item.label}</span><small>{item.value} · {item.source === "source-stated" ? t("buildingModelSourceStated") : item.source === "calibrated" ? t("buildingModelCalibrated") : t("buildingModelInferred")} {item.page ? `· p. ${item.page}` : ""}</small></div>) : <span className="building-model-unknown text-ui-xs">{t("buildingModelNoEvidence")}</span>}
      </PropertySection>
    </>
  );
}

function Measurement({ measurement, t, onSave, pending }: { measurement: NonNullable<BuildingRegion["measurements"]>[number]; t: ReturnType<typeof useT>; onSave: (value: number) => void; pending: boolean }) {
  const [value, setValue] = useState(measurement.calibratedValue == null ? "" : String(measurement.calibratedValue));
  const uncertainty = measurement.uncertainty && typeof measurement.uncertainty === "object"
    ? (measurement.uncertainty as RecordData).plusMinus
    : measurement.uncertainty;
  const uncertaintyUnit = measurement.uncertainty && typeof measurement.uncertainty === "object"
    ? String((measurement.uncertainty as RecordData).unit || measurement.unit || "")
    : measurement.unit || "";
  return (
    <div className="building-model-measurement">
      <div>
        <strong className="text-ui-xs">{measurement.label}</strong>
        <div className="building-model-measurement-source">{measurement.semanticQuantity || t("buildingModelDistance")} · {measurement.sourceValue ?? "—"} {measurement.unit || ""}{uncertainty != null && uncertainty !== "" ? ` · ± ${String(uncertainty)} ${uncertaintyUnit}` : ""} · {measurement.method === "manual" ? t("buildingModelCalibrated") : t("buildingModelSourceStated")}</div>
      </div>
      <Field label={t("buildingModelCalibrated")}>
        <Input inputMode="decimal" type="number" value={value} onChange={(event) => setValue(event.target.value)} onBlur={() => { const numeric = Number(value); if (Number.isFinite(numeric) && value !== String(measurement.calibratedValue ?? "")) onSave(numeric); }} disabled={pending} aria-label={`${measurement.label} ${t("buildingModelCalibrated")}`} />
      </Field>
    </div>
  );
}

function NewMeasurementForm({ t, pending, onSave }: { t: ReturnType<typeof useT>; pending: boolean; onSave: (measurement: NonNullable<BuildingRegion["measurements"]>[number], value: number) => void }) {
  const [quantity, setQuantity] = useState("wall_thickness");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("m");
  const [method, setMethod] = useState("plan");
  const [uncertainty, setUncertainty] = useState("");
  return (
    <form className="building-model-new-measurement" onSubmit={(event) => {
      event.preventDefault();
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return;
      onSave({ key: `new-${quantity}`, label: quantity, semanticQuantity: quantity, unit, method, uncertainty: uncertainty ? { plusMinus: Number(uncertainty), unit } : null, sourceValue: null, calibratedValue: null }, numeric);
      setValue("");
    }}>
      <Field label={t("buildingModelMeasurementQuantity")}>
        <NativeSelect value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={pending}>
          <option value="wall_thickness">{t("buildingModelWallThickness")}</option>
          <option value="distance">{t("buildingModelDistance")}</option>
        </NativeSelect>
      </Field>
      <div className="building-model-new-measurement-grid">
        <Field label={t("buildingModelNumericValue")}><Input type="number" inputMode="decimal" step="any" min="0" required value={value} onChange={(event) => setValue(event.target.value)} disabled={pending} /></Field>
        <Field label={t("buildingModelUnit")}><Input value={unit} onChange={(event) => setUnit(event.target.value)} disabled={pending} /></Field>
      </div>
      <div className="building-model-new-measurement-grid">
        <Field label={t("buildingModelMeasurementMethod")}>
          <NativeSelect value={method} onChange={(event) => setMethod(event.target.value)} disabled={pending}><option value="plan">{t("buildingModelMethodPlan")}</option><option value="manual">{t("buildingModelMethodManual")}</option></NativeSelect>
        </Field>
        <Field label={t("buildingModelUncertainty")}><Input type="number" inputMode="decimal" step="any" min="0" value={uncertainty} onChange={(event) => setUncertainty(event.target.value)} disabled={pending} placeholder="—" /></Field>
      </div>
      <Button size="xs" variant="outline" type="submit" disabled={pending || !value} title={t("buildingModelMeasurementMaterialHint")}>{t("buildingModelAddMeasurement")}</Button>
    </form>
  );
}
