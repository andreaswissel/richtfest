import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError, list, type RecordData } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Badge, Callout, Empty, Field, Segmented } from "../ui/primitives";
import { Copy, ExternalLink, Link2, ScanLine } from "lucide-react";
import { adaptBuildingModel, type BuildingExtractionCandidate, type BuildingExtractionJob, type BuildingModelState, type BuildingPlanSource, type BuildingRegion, type PdfEvidenceLayer } from "./types";
import type { PdfViewerTransform } from "./pdf-evidence-renderer";
import "./building-model.css";

const LazyPdfEvidenceRenderer = lazy(async () => import("./pdf-evidence-renderer").then((module) => ({ default: module.PdfEvidenceRenderer })));

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

export type CandidateOverlayVisibility = {
  roomAnchors?: boolean;
  footprints?: boolean;
  roomHypotheses?: boolean;
  unresolvedAnchors?: boolean;
  assemblies?: boolean;
};

export function candidateOverlayBucket(candidate: Pick<BuildingExtractionCandidate, "entityType" | "geometryQuality">) {
  if (candidate.geometryQuality === "footprint") return "footprints" as const;
  if (candidate.geometryQuality === "assembly") return "assemblies" as const;
  if (candidate.geometryQuality === "anchor") return "unresolvedAnchors" as const;
  if (candidate.geometryQuality === "enclosed_region" || candidate.geometryQuality === "approximate_partition" || candidate.geometryQuality === "approximate_region") return "roomHypotheses" as const;
  return candidate.entityType === "room" ? "roomHypotheses" as const : "assemblies" as const;
}

export function candidateOverlaysForSource(candidates: BuildingExtractionCandidate[], page: number, sourceVersionId: string | undefined, storeyId: string | null | undefined, visibility: CandidateOverlayVisibility) {
  return candidatesForSource(candidates, page, sourceVersionId, storeyId).filter((candidate) => {
    const bucket = candidateOverlayBucket(candidate);
    if (bucket === "roomHypotheses") return visibility.roomHypotheses ?? visibility.roomAnchors ?? true;
    if (bucket === "unresolvedAnchors") return visibility.unresolvedAnchors ?? visibility.roomAnchors ?? false;
    if (bucket === "assemblies") return visibility.assemblies ?? visibility.footprints ?? false;
    return visibility.footprints ?? false;
  });
}

export function regionsForSource(regions: BuildingRegion[], page: number, sourceVersionId?: string, storeyId?: string | null) {
  return regions.filter((region) => region.page === page && (!storeyId || region.storeyId === storeyId) && (!sourceVersionId || region.sourceVersionId === sourceVersionId));
}

export function BuildingModelMode({ projectId }: { projectId: string }) {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const [state, setState] = useState<BuildingModelState>((params.get("modelState") as BuildingModelState) || "existing");
  const [page, setPage] = useState(Math.max(1, Number(params.get("page") || 1)));
  const [sourceStoreyId, setSourceStoreyId] = useState(params.get("storey") || "");
  const deepLinkedEntity = params.get("entity")?.split(":").slice(1).join(":");
  const [selectedId, setSelectedId] = useState<string | undefined>(deepLinkedEntity || undefined);
  const [layers, setLayers] = useState<Record<string, boolean>>({});
  const [pdfLayers, setPdfLayers] = useState<PdfEvidenceLayer[]>([]);
  const [conflict, setConflict] = useState<string>();
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>();
  const [candidateGroupFilter, setCandidateGroupFilter] = useState("all");
  const [candidateOverlayVisibility, setCandidateOverlayVisibility] = useState<CandidateOverlayVisibility>({ roomHypotheses: true, unresolvedAnchors: false, assemblies: false, footprints: false });
  const [viewerTransform, setViewerTransform] = useState<PdfViewerTransform>({ zoom: 1, pan: { x: 0, y: 0 } });
  const modelQuery = useApi(`/projects/${projectId}/building-model`);
  const modelError = modelQuery.error instanceof Error ? modelQuery.error : null;
  const model = useMemo(() => adaptBuildingModel(modelQuery.data), [modelQuery.data]);
  const needsBootstrap = (modelQuery.isError && modelError instanceof ApiError && modelError.status === 404) || (!modelQuery.isError && (!modelQuery.data || !model.planSources.length));
  const filesQuery = useApi(`/projects/${projectId}/files`, needsBootstrap);
  const [bootstrapFileId, setBootstrapFileId] = useState("");
  const versionsQuery = useApi(`/projects/${projectId}/files/${bootstrapFileId}/versions`, needsBootstrap && !!bootstrapFileId);
  const projectFiles = useMemo(() => list(filesQuery.data, "files").filter((file) => /\.pdf$/i.test(String(file.name || "")) || String(file.mimeType || "").toLowerCase() === "application/pdf"), [filesQuery.data]);
  const selectedBootstrapFile = projectFiles.find((file) => file.id === bootstrapFileId);
  const bootstrapVersions = useMemo(() => list(versionsQuery.data).filter((version) => version.status === undefined || version.status === "ready"), [versionsQuery.data]);
  const regions = pickRegions(model, state);
  const selected = regions.find((region) => region.id === selectedId) || regions[0];
  const candidates = model.extractionCandidates.filter((candidate) => candidate.status === "unreviewed");
  const candidateGroups = useMemo(() => {
    const grouped = new Map<string, BuildingExtractionCandidate[]>();
    for (const candidate of candidates) {
      const group = candidate.groupLabel || "__ungrouped__";
      if (candidateGroupFilter !== "all" && candidateGroupFilter !== group) continue;
      const items = grouped.get(group) || [];
      items.push(candidate);
      grouped.set(group, items);
    }
    return grouped;
  }, [candidates, candidateGroupFilter]);
  const candidateGroupOptions = useMemo(() => [...new Set(candidates.flatMap((candidate) => candidate.groupLabel ? [candidate.groupLabel] : []))].sort(), [candidates]);
  const selectedCandidate = candidates.find((candidate) => candidate.id === selectedCandidateId);
  const selectedProposals = selected ? model.proposals.filter((proposal) => proposal.status === "pending" && proposal.targetEntityId === selected.id) : [];
  const currentSource = model.planSources.find((source) => source.storeyId && source.storeyId === sourceStoreyId && source.page === page) || model.planSources.find((source) => source.page === page) || model.planSources.find((source) => source.storeyId && source.storeyId === sourceStoreyId) || model.planSources.find((source) => source.storeyId && source.storeyId === selected?.storeyId) || model.planSources[0];
  const sourceForEvidence = currentSource || model.planSources[0];
  const evidence = sourceForEvidence?.source ? { ...model.evidence, fileName: sourceForEvidence.source.fileName, sourceVersionId: sourceForEvidence.source.versionId, fileId: sourceForEvidence.source.fileId, version: sourceForEvidence.source.version, pdfUrl: sourceForEvidence.source.downloadUrl, pageCount: sourceForEvidence.pageCount || 1, layers: sourceForEvidence.layers?.map((layer, index) => ({ id: layer.id || String(index), label: layer.label || layer.name || String(layer.id || index), visible: layer.visible ?? layer.defaultVisible })) } : model.evidence;
  const sourceLayers = pdfLayers.length ? pdfLayers : evidence.layers || [];
  const allExtractions = model.extraction && !model.extractions.some((job) => job.id === model.extraction?.id) ? [...model.extractions, model.extraction] : model.extractions;
  const displayedExtraction = allExtractions.find((job) => job.sourceVersionId === sourceForEvidence?.source?.versionId && job.page === page && job.storeyId === currentSource?.storeyId);
  const activeExtraction = displayedExtraction as BuildingExtractionJob | undefined;
  const pollingExtractionIds = allExtractions.filter((job) => job.status === "queued" || job.status === "running").map((job) => job.id).join(",");
  useEffect(() => {
    if (!pollingExtractionIds) return;
    const timer = window.setInterval(() => { void queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }); }, 2000);
    return () => window.clearInterval(timer);
  }, [pollingExtractionIds, projectId]);
  useEffect(() => {
    if (activeExtraction && (activeExtraction.status === "complete" || activeExtraction.status === "failed")) {
      void queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] });
    }
  }, [activeExtraction?.id, activeExtraction?.status, projectId]);
  const visibleCandidates = candidateOverlaysForSource(candidates, page, sourceForEvidence?.source?.versionId, currentSource?.storeyId, candidateOverlayVisibility);
  const visibleRegions = regionsForSource(regions, page, sourceForEvidence?.source?.versionId, currentSource?.storeyId);
  useEffect(() => {
    if (selectedCandidateId && !visibleCandidates.some((candidate) => candidate.id === selectedCandidateId)) setSelectedCandidateId(undefined);
  }, [selectedCandidateId, page, currentSource?.id, sourceForEvidence?.source?.versionId]);

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
    if (currentSource && page !== currentSource.page && !params.get("page")) setPage(currentSource.page);
    if (!sourceStoreyId && currentSource?.storeyId) setSourceStoreyId(currentSource.storeyId);
  }, [selected?.id, selectedId, currentSource?.id, sourceStoreyId]);
  useEffect(() => {
    const next = new URLSearchParams(params);
    next.set("modelState", state);
    next.set("page", String(page));
    if (selected?.id) next.set("entity", `${selected.entityType || "room"}:${selected.id}`);
    else next.delete("entity");
    if (sourceStoreyId) next.set("storey", sourceStoreyId);
    else next.delete("storey");
    next.delete("object");
    setParams(next, { replace: true });
  }, [state, page, selected?.id, sourceStoreyId]);

  const updateObject = useMutation({
    mutationFn: ({ id, entityType, body }: { id: string; entityType: string; body: RecordData }) =>
      api(`/projects/${projectId}/building-model/${entityType}/${id}`, {
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
    mutationFn: ({ region, measurement, value }: { region: BuildingRegion; measurement: NonNullable<BuildingRegion["measurements"]>[number]; value: number }) => api(`/projects/${projectId}/building-model/measurements`, { baseRevision: model.revision, entityType: region.entityType || "room", entityId: region.id, quantity: measurement.semanticQuantity || "distance", value, unit: measurement.unit || "m", method: measurement.method || "manual", uncertainty: measurement.uncertainty ?? null, evidence: measurement.evidence || [] }, "POST"),
    onMutate: () => setConflict(undefined),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }),
    onError: (error) => setConflict(error instanceof ApiError && error.status === 409 ? t("buildingModelOptimisticConflict") : error.message),
  });
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
  const reviewCandidate = useMutation({
    mutationFn: ({ candidateId, body }: { candidateId: string; body: RecordData }) => api(`/projects/${projectId}/building-model/extraction-candidates/${candidateId}/review`, { ...body, baseRevision: model.revision }, "POST"),
    onSuccess: async () => {
      setSelectedCandidateId(undefined);
      await queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] });
    },
    onError: (error) => setConflict(error instanceof Error ? error.message : String(error)),
  });
  const referenceHref = `/projects/${projectId}?view=building-model&entity=${encodeURIComponent(`${selected?.entityType || "room"}:${selected?.id || ""}`)}&modelState=${state}&page=${page}`;

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
        setPage(sourcePage);
      }}
      t={t}
    />;
  }

  const selectRegion = (id: string) => {
    const region = regions.find((item) => item.id === id);
    setSelectedCandidateId(undefined);
    setSelectedId(id);
    if (region) setPage(model.planSources.find((source) => source.storeyId && source.storeyId === region.storeyId)?.page || region.page);
  };

  return (
    <div className="building-model">
      {conflict && <Callout tone="warning">{conflict}</Callout>}
      {modelError && <Callout tone="error">{modelError.message}</Callout>}
      <div className="building-model-toolbar" aria-label={t("buildingModelControls")}>
        <div className="building-model-toolbar-group">
          <span className="building-model-toolbar-label">{t("buildingModelState")}</span>
          <Segmented
            value={state}
            onChange={(value) => setState(value as BuildingModelState)}
            items={states.map((item) => ({ value: item.value, label: t(`buildingModelState${item.value[0].toUpperCase()}${item.value.slice(1)}` as keyof typeof import("../../locales/en.json")) }))}
          />
        </div>
        <div className="building-model-status-line">
          <Badge>{statusLabel(model.reviewStatus, t)}</Badge>
          <small>{model.updatedAt ? `${t("buildingModelUpdated")} · ${new Date(model.updatedAt).toLocaleString()}` : t("buildingModelNoReview")}</small>
          {model.reviewStatus === "needs-review" && <span className="muted text-ui-xs">{t("buildingModelReviewInWorkspace")}</span>}
        </div>
      </div>
      <ExtractionPanel
        job={activeExtraction}
        coverage={activeExtraction?.result?.coverage ? { note: activeExtraction.result.coverage } : model.extractionCoverage}
        source={currentSource}
        storeys={model.storeys}
        selectedStoreyId={sourceStoreyId || currentSource?.storeyId || ""}
        onStorey={(value) => { setSourceStoreyId(value); const source = model.planSources.find((item) => item.storeyId === value); if (source) setPage(source.page); }}
        canStart={Boolean(evidence.sourceVersionId && currentSource?.storeyId)}
        pending={startExtraction.isPending}
        onStart={() => startExtraction.mutate()}
        t={t}
      />
      <div className="building-model-workbench">
        <aside className="building-model-sidebar" aria-label={t("buildingModelObjects")}>
          <div className="building-model-sidebar-section">
            <h2>{t("buildingModelObjects")}</h2>
            <div className="building-model-list">
              {regions.map((region) => (
                <button key={region.id} type="button" aria-pressed={selected?.id === region.id} onClick={() => selectRegion(region.id)}>
                  <span>{region.label}</span>
                  <small>{region.kind === "unknown-room" ? t("buildingModelUnknownRoom") : `p. ${region.page}`}</small>
                </button>
              ))}
              {!regions.length && <Empty>{t("buildingModelNoObjects")}</Empty>}
            </div>
          </div>
          <div className="building-model-sidebar-section">
            <h2>{t("buildingModelExtractionCandidates")}</h2>
            {candidateGroupOptions.length > 1 && <Field label={t("buildingModelCandidateGroupFilter")}><NativeSelect value={candidateGroupFilter} onChange={(event) => setCandidateGroupFilter(event.target.value)}><option value="all">{t("buildingModelAllCandidateGroups")}</option>{candidateGroupOptions.map((group) => <option key={group} value={group}>{group}</option>)}</NativeSelect></Field>}
            <div className="building-model-candidate-list">
              {[...candidateGroups.entries()].map(([group, groupedCandidates]) => <div className="building-model-candidate-group" key={group}><h3>{group === "__ungrouped__" ? t("buildingModelUngroupedCandidates") : group}</h3>{groupedCandidates.map((candidate) => <button key={candidate.id} type="button" aria-pressed={selectedCandidate?.id === candidate.id} onClick={() => { setSelectedCandidateId(candidate.id); const bucket = candidateOverlayBucket(candidate); setCandidateOverlayVisibility((current) => ({ ...current, ...(bucket === "footprints" ? { footprints: true } : bucket === "assemblies" ? { assemblies: true } : bucket === "unresolvedAnchors" ? { unresolvedAnchors: true } : { roomHypotheses: true }) })); if (candidate.storeyId) setSourceStoreyId(candidate.storeyId); setPage(candidate.page); }}><span>{candidate.label}</span><small>{candidate.geometryQuality === "footprint" ? t("buildingModelConstructionFootprint") : candidate.geometryQuality === "assembly" ? t("buildingModelConstructionAssembly") : candidate.geometryQuality === "anchor" ? t("buildingModelUnresolvedAnchor") : t("buildingModelRoomHypothesis")} {candidate.groupLabel ? `· ${candidate.groupLabel}` : ""} · {t("buildingModelPage")} {candidate.page}</small></button>)}</div>)}
              {!candidates.length && <p className="muted text-ui-xs">{t("buildingModelNoExtractionCandidates")}</p>}
            </div>
          </div>
          <div className="building-model-sidebar-section" aria-label={t("buildingModelCandidateOverlayControls")}>
            <h2>{t("buildingModelCandidateOverlayControls")}</h2>
            <label className="building-model-layer">
              <input type="checkbox" checked={candidateOverlayVisibility.roomHypotheses ?? true} onChange={(event) => setCandidateOverlayVisibility((current) => ({ ...current, roomHypotheses: event.target.checked }))} />
              <span>{t("buildingModelRoomHypotheses")}</span>
            </label>
            <label className="building-model-layer">
              <input type="checkbox" checked={candidateOverlayVisibility.unresolvedAnchors ?? false} onChange={(event) => setCandidateOverlayVisibility((current) => ({ ...current, unresolvedAnchors: event.target.checked }))} />
              <span>{t("buildingModelUnresolvedAnchors")}</span>
            </label>
            <label className="building-model-layer">
              <input type="checkbox" checked={candidateOverlayVisibility.assemblies ?? false} onChange={(event) => setCandidateOverlayVisibility((current) => ({ ...current, assemblies: event.target.checked }))} />
              <span>{t("buildingModelConstructionAssemblies")}</span>
            </label>
            <label className="building-model-layer">
              <input type="checkbox" checked={candidateOverlayVisibility.footprints ?? false} onChange={(event) => setCandidateOverlayVisibility((current) => ({ ...current, footprints: event.target.checked }))} />
              <span>{t("buildingModelRawFootprints")}</span>
            </label>
            <p className="muted text-ui-2xs">{t("buildingModelCandidateOverlayHint")}</p>
          </div>
          <div className="building-model-sidebar-section">
            <h2>{t("buildingModelEvidenceLayers")}</h2>
            {sourceLayers.length ? sourceLayers.map((layer) => (
              <label className="building-model-layer" key={layer.id}>
                <input type="checkbox" checked={layers[layer.id] ?? layer.visible !== false} onChange={(event) => setLayers((current) => ({ ...current, [layer.id]: event.target.checked }))} />
                <span>{layer.label}</span>
              </label>
            )) : <p className="muted text-ui-xs">{t("buildingModelNoLayers")}</p>}
            <p className="muted text-ui-2xs">{t("buildingModelLayerHint")}</p>
          </div>
          <RegionForm
            projectId={projectId}
            modelRevision={model.revision || 0}
            storeyId={currentSource?.storeyId || undefined}
            sourcePage={currentSource?.page || page}
            sourceVersionId={evidence.sourceVersionId || undefined}
            onComplete={() => queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] })}
            t={t}
          />
        </aside>
        <section className="building-model-evidence" aria-label={t("buildingModelSourceEvidence")}>
          <div className="building-model-page-strip" aria-label={t("buildingModelPages")}>
            <span className="muted text-ui-2xs">{evidence.fileName}</span>
            {(model.planSources.length ? [...new Set(model.planSources.map((source) => source.page))] : [1]).map((pageNumber) => (
              <button key={pageNumber} type="button" aria-pressed={page === pageNumber} onClick={() => { setSelectedCandidateId(undefined); setPage(pageNumber); }}>
                {pageNumber}
              </button>
            ))}
          </div>
          <Suspense fallback={<div className="building-model-pdf-empty"><ScanLine aria-hidden="true" /><p>{t("buildingModelLoadingEvidence")}</p></div>}>
            <LazyPdfEvidenceRenderer projectId={projectId} evidence={evidence} page={page} selectedId={selectedCandidate?.id || selected?.id} regions={[...visibleRegions, ...visibleCandidates]} layerVisibility={layers} transform={viewerTransform} onTransform={setViewerTransform} onLayers={setPdfLayers} onSelect={(id) => id.startsWith("candidate:") ? setSelectedCandidateId(id) : selectRegion(id)} labels={{ empty: t("buildingModelPdfEmpty"), loading: t("buildingModelPdfLoading"), region: t("buildingModelSelectableRegions"), zoom: t("buildingModelZoomControls"), zoomIn: t("buildingModelZoomIn"), zoomOut: t("buildingModelZoomOut"), fit: t("buildingModelFitView") }} />
          </Suspense>
        </section>
        <aside className="building-model-inspector" aria-label={t("buildingModelInspector")}>
          <div className="building-model-inspector-header">
            <div>
              <h2>{selectedCandidate?.label || selected?.label || t("buildingModelSelectObject")}</h2>
              {selectedCandidate ? <div className="building-model-status-line"><Badge>{t("buildingModelUnreviewedCandidate")}</Badge></div> : selected && <div className="building-model-status-line"><Badge>{selected.kind === "unknown-room" ? t("buildingModelUnknownRoom") : selected.kind}</Badge></div>}
            </div>
            {!selectedCandidate && <Link className="text-ui-xs" to={referenceHref} title={t("buildingModelOpenReference")}><Link2 className="size-icon-sm" aria-hidden="true" /></Link>}
          </div>
          {selectedCandidate ? <CandidateInspector candidate={selectedCandidate} regions={regions} t={t} pending={reviewCandidate.isPending} onReview={(decision, correction) => reviewCandidate.mutate({ candidateId: selectedCandidate.candidateId || selectedCandidate.id.replace(/^candidate:/, ""), body: { decision, ...correction } })} /> : selected ? <ObjectInspector region={selected} sourcePage={selected.page} sourceVersionId={selected.sourceVersionId || evidence.sourceVersionId} sourceRegion={selected.box} proposals={selectedProposals} t={t} onPage={setPage} onSave={(body) => updateObject.mutate({ id: selected.id, entityType: selected.entityType || "room", body })} onMeasurementSave={(measurement, value) => createMeasurement.mutate({ region: selected, measurement, value })} pending={updateObject.isPending || createMeasurement.isPending} /> : <Empty>{t("buildingModelSelectObject")}</Empty>}
        </aside>
      </div>
    </div>
  );
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

function RegionForm({ projectId, modelRevision, storeyId, sourcePage, sourceVersionId, onComplete, t }: { projectId: string; modelRevision: number; storeyId?: string; sourcePage: number; sourceVersionId?: string; onComplete: () => void | Promise<void>; t: ReturnType<typeof useT> }) {
  const [open, setOpen] = useState(false);
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
    onSuccess: async () => { setOpen(false); setFailure(undefined); await onComplete(); },
    onError: (cause) => setFailure(cause instanceof Error ? cause.message : String(cause)),
  });
  const numericBox = Object.values(box).every((value) => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1);
  if (!open) return <div className="building-model-sidebar-section building-model-region-create"><Button size="sm" variant="outline" onClick={() => setOpen(true)}>{t("buildingModelAddRegion")}</Button></div>;
  return <div className="building-model-sidebar-section building-model-region-create"><h2>{t("buildingModelAddRegion")}</h2><p className="muted text-ui-2xs">{t("buildingModelRegionHint")} · {t("buildingModelPage")} {sourcePage}</p>{failure && <Callout tone="error">{failure}</Callout>}<form onSubmit={(event) => { event.preventDefault(); if (name.trim() && numericBox && sourceVersionId) createRegion.mutate(); }}>
    <Field label={t("buildingModelRegionType")}><NativeSelect value={kind} onChange={(event) => setKind(event.target.value as "room" | "element")}><option value="room">{t("buildingModelRoom")}</option><option value="element">{t("buildingModelElement")}</option></NativeSelect></Field>
    <Field label={t("buildingModelRegionName")}><Input value={name} onChange={(event) => setName(event.target.value)} required /></Field>
    <Field label={t("buildingModelRegionKey")}><Input value={stableKey} onChange={(event) => setStableKey(event.target.value)} placeholder={slug(name)} /></Field>
    <Field label={t("buildingModelConstructionState")}><NativeSelect value={constructionState} onChange={(event) => setConstructionState(event.target.value)}><option value="existing">{t("buildingModelStateExisting")}</option><option value="demolished">{t("buildingModelStateDemolition")}</option><option value="proposed">{t("buildingModelStateProposed")}</option><option value="retained">{t("buildingModelRetained")}</option></NativeSelect></Field>
    <div className="building-model-region-box">{(["x", "y", "width", "height"] as const).map((key) => <Field key={key} label={key}><Input type="number" min="0" max="1" step="0.001" value={box[key]} onChange={(event) => setBox((current) => ({ ...current, [key]: event.target.value }))} required /></Field>)}</div>
    <div className="building-model-bootstrap-actions"><Button size="sm" type="submit" disabled={createRegion.isPending || !name.trim() || !numericBox || !sourceVersionId}>{t("buildingModelCreateRegion")}</Button><Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>{t("cancel")}</Button></div>
  </form></div>;
}

function ExtractionPanel({ job, coverage, source, storeys, selectedStoreyId, onStorey, canStart, pending, onStart, t }: { job?: BuildingExtractionJob; coverage?: { pages?: number | null; regions?: number | null; objects?: number | null; unresolved?: number | null; note?: string | null } | null; source?: BuildingPlanSource; storeys: Array<{ id: string; name?: string; levelIndex?: number | null }>; selectedStoreyId: string; onStorey: (value: string) => void; canStart: boolean; pending: boolean; onStart: () => void; t: ReturnType<typeof useT> }) {
  const active = job?.status === "queued" || job?.status === "running";
  const failed = job?.status === "failed";
  const complete = job?.status === "complete" || job?.status === "succeeded";
  const jobCoverage = job?.coverage;
  const result = job?.result;
  const semanticCoverage = result?.roomHypothesisCount != null || result?.unresolvedAnchorCount != null || result?.constructionAssemblyCount != null || result?.sourceAreaObservationCount != null;
  const roomCount = result?.roomHypothesisCount ?? result?.roomAnchorCount;
  const assemblyCount = result?.constructionAssemblyCount ?? result?.elementFootprintCount;
  const extractionNotes = [...new Set([result?.geometryExtraction?.limitations, coverage?.note, result?.coverage, result?.reason].filter((note): note is string => Boolean(note)))];
  return <section className="building-model-extraction" aria-label={t("buildingModelExtraction") }>
    <div className="building-model-extraction-heading">
      <div><h2>{t("buildingModelExtraction")}</h2><p className="muted text-ui-2xs">{source?.source ? `${source.source.fileName} · ${t("buildingModelPage")} ${source.page}` : t("buildingModelExtractionChooseSource")}</p></div>
      <Button size="sm" variant="outline" type="button" disabled={!canStart || pending || active} onClick={onStart}>{pending ? t("buildingModelExtractionStarting") : active ? t("buildingModelExtractionRunning") : t("buildingModelExtractCandidates")}</Button>
    </div>
    {storeys.length > 1 && <Field label={t("buildingModelBootstrapStorey")}><NativeSelect value={selectedStoreyId} onChange={(event) => onStorey(event.target.value)}><option value="">{t("buildingModelBootstrapStorey")}</option>{storeys.map((storey) => <option key={storey.id} value={storey.id}>{storey.name || storey.id}</option>)}</NativeSelect></Field>}
    {active && <div className="building-model-status-line" role="status"><Badge>{t("buildingModelExtractionRunning")}</Badge><small>{job?.phase || t("buildingModelExtractionInProgress")} {typeof job?.progress === "number" ? `· ${Math.round(job.progress * (job.progress <= 1 ? 100 : 1))}%` : ""}</small></div>}
    {failed && <Callout tone="error">{job.error || t("buildingModelExtractionFailed")}</Callout>}
    {complete && <div className="building-model-status-line"><Badge>{t("buildingModelExtractionComplete")}</Badge><small>{job?.result?.method || t("buildingModelExtractionMethodUnknown")} · {job?.result?.geometryQuality ? `${t("buildingModelGeometryQuality")}: ${job.result.geometryQuality}` : t("buildingModelGeometryQualityUnknown")}</small></div>}
    {complete && <div className="building-model-extraction-grid" aria-label={t("buildingModelSourceCoverage")}>
      <div className="building-model-extraction-stat"><strong>{job ? 1 : "—"}</strong><small>{t("buildingModelCoveragePages")}</small></div>
      <div className="building-model-extraction-stat"><strong>{roomCount ?? "—"}</strong><small>{t(semanticCoverage ? "buildingModelCoverageRoomHypotheses" : "buildingModelCoverageRoomAnchors")}</small></div>
      {semanticCoverage && <div className="building-model-extraction-stat"><strong>{result?.unresolvedAnchorCount ?? "—"}</strong><small>{t("buildingModelCoverageUnresolvedAnchors")}</small></div>}
      <div className="building-model-extraction-stat"><strong>{assemblyCount ?? "—"}</strong><small>{t(semanticCoverage ? "buildingModelCoverageAssemblies" : "buildingModelCoverageFootprints")}</small></div>
      {semanticCoverage && <div className="building-model-extraction-stat"><strong>{result?.sourceAreaObservationCount ?? "—"}</strong><small>{t("buildingModelCoverageSourceAreas")}</small></div>}
      <div className="building-model-extraction-stat"><strong>{result?.candidateCount ?? jobCoverage?.regions ?? coverage?.regions ?? "—"}</strong><small>{t("buildingModelCoverageTotalCandidates")}</small></div>
    </div>}
    {extractionNotes.length > 0 && <p className="muted text-ui-2xs">{extractionNotes.join(" ")}</p>}
    {!job && <p className="muted text-ui-2xs">{t("buildingModelExtractionNotRun")}</p>}
  </section>;
}

function CandidateInspector({ candidate, regions, t, pending, onReview }: { candidate: BuildingExtractionCandidate; regions: BuildingRegion[]; t: ReturnType<typeof useT>; pending: boolean; onReview: (decision: "approved" | "rejected", correction?: RecordData) => void }) {
  const [name, setName] = useState(candidate.label);
  const [targetEntityId, setTargetEntityId] = useState(candidate.match?.existingId || "");
  useEffect(() => { setName(candidate.label); setTargetEntityId(candidate.match?.existingId || ""); }, [candidate.id, candidate.label, candidate.match?.existingId]);
  const propertyEntries = Object.entries(candidate.properties || {});
  const geometryLabel = candidate.geometryQuality === "anchor" ? t("buildingModelGeometryAnchor") : candidate.geometryQuality === "footprint" ? t("buildingModelGeometryFootprint") : candidate.geometryQuality === "approximate_partition" || candidate.geometryQuality === "approximate_region" ? t("buildingModelGeometryApproximateRegion") : candidate.geometryQuality === "enclosed_region" ? t("buildingModelGeometryEnclosedRegion") : candidate.geometryQuality === "assembly" ? t("buildingModelConstructionAssembly") : candidate.geometryQuality || t("buildingModelGeometryQualityUnknown");
  const sourceLayer = candidate.layerName && candidate.layerId ? `${candidate.layerName} · ${candidate.layerId}` : candidate.layerName || candidate.layerId || t("buildingModelNoSourceLayer");
  const sourceCoordinates = candidate.box ? `x ${candidate.box.x.toFixed(5)} · y ${candidate.box.y.toFixed(5)} · w ${candidate.box.width.toFixed(5)} · h ${candidate.box.height.toFixed(5)}` : "—";
  const polygonCoordinates = candidate.polygon?.map((point) => `${point.x.toFixed(5)}, ${point.y.toFixed(5)}`).join(" · ");
  const geometryLimitations = candidate.geometryLimitations || (candidate.geometryQuality === "anchor" ? t("buildingModelGeometryAnchor") : candidate.geometryQuality === "approximate_partition" || candidate.geometryQuality === "approximate_region" ? t("buildingModelGeometryApproximateRegion") : candidate.geometryQuality === "enclosed_region" ? t("buildingModelGeometryEnclosedRegion") : t("buildingModelGeometryLimitationsUnknown"));
  const sourceArea = typeof candidate.sourceArea === "number" && Number.isFinite(candidate.sourceArea) ? `${candidate.sourceArea} m²` : candidate.sourceArea && typeof candidate.sourceArea === "object" ? (() => { const area = candidate.sourceArea as RecordData; return area.value == null ? JSON.stringify(area) : `${area.value}${area.unit ? ` ${area.unit}` : ""}`; })() : typeof candidate.sourceArea === "string" ? candidate.sourceArea : undefined;
  const correction = { ...(name.trim() && name.trim() !== candidate.label ? { name: name.trim() } : {}), ...(targetEntityId ? { targetEntityId } : {}) };
  return <>
    <Callout tone="warning">{t("buildingModelCandidateWarning")}</Callout>
    <dl><dt>{t("buildingModelCandidateStatus")}</dt><dd><Badge>{t("buildingModelUnreviewedCandidate")}</Badge></dd>{candidate.groupLabel && <><dt>{t("buildingModelCandidateGroup")}</dt><dd>{candidate.groupLabel}</dd></>}<dt>{t("buildingModelGeometryQuality")}</dt><dd>{geometryLabel}</dd>{sourceArea && <><dt>{t("buildingModelSourceArea")}</dt><dd>{sourceArea}</dd></>}{candidate.algorithm && <><dt>{t("buildingModelAlgorithm")}</dt><dd>{candidate.algorithm}</dd></>}{candidate.competingLabels?.length && <><dt>{t("buildingModelCompetingLabels")}</dt><dd>{candidate.competingLabels.join(" · ")}</dd></>}{candidate.parts?.length && <><dt>{t("buildingModelGeometryParts")}</dt><dd>{candidate.parts.length}</dd></>}<dt>{t("buildingModelSourceLayer")}</dt><dd>{sourceLayer}</dd><dt>{t("buildingModelSourceCoordinates")}</dt><dd><code className="building-model-source-coordinates">{sourceCoordinates}</code>{polygonCoordinates && <small className="building-model-polygon-coordinates">{polygonCoordinates}</small>}</dd><dt>{t("buildingModelGeometryLimitations")}</dt><dd>{geometryLimitations}</dd>{candidate.entityType === "room" ? <><dt>{t("buildingModelRoomUse")}</dt><dd className={!candidate.roomUse ? "building-model-unknown" : undefined}>{candidate.roomUse || t("buildingModelUnknownValue")}</dd></> : <><dt>{t("buildingModelConstructionState")}</dt><dd className="building-model-unknown">{t("buildingModelUnknownValue")}</dd></>}<dt>{t("buildingModelMaterial")}</dt><dd className="building-model-unknown">{t("buildingModelUnknownValue")}</dd></dl>
    <div className="building-model-inspector-section"><h3>{t("buildingModelProperties")}</h3><Field label={t("buildingModelLabel")} hint={t("buildingModelCandidateCorrectionHint")}><Input value={name} onChange={(event) => setName(event.target.value)} disabled={pending} /></Field>{propertyEntries.length ? propertyEntries.map(([key, value]) => <div className="building-model-evidence-row" key={key}><span>{key}</span><small>{typeof value === "string" ? value : JSON.stringify(value)}</small></div>) : <p className="muted text-ui-xs">{t("buildingModelNoCandidateProperties")}</p>}</div>
    <div className="building-model-inspector-section"><h3>{t("buildingModelMatchExisting")}</h3><Field label={candidate.entityType === "element" ? t("buildingModelExistingElement") : t("buildingModelExistingObject")} hint={t("buildingModelMatchHint")}><NativeSelect value={targetEntityId} onChange={(event) => setTargetEntityId(event.target.value)} disabled={pending}><option value="">{t("buildingModelNoMatch")}</option>{regions.filter((region) => region.entityType === candidate.entityType).map((region) => <option key={region.id} value={region.id}>{region.label} · {region.id}</option>)}</NativeSelect></Field><Button size="sm" variant="outline" disabled={pending || !targetEntityId} onClick={() => onReview("approved", { targetEntityId })}>{t("buildingModelReconcile")}</Button></div>
    <div className="building-model-inspector-section"><h3>{t("buildingModelEvidence")}</h3>{candidate.evidence?.length ? candidate.evidence.map((item, index) => <div className="building-model-evidence-row" key={`${item.label}-${index}`}><span>{item.label || t("buildingModelSourcePage")}</span><small>{item.value || "—"} {item.page ? `· ${t("buildingModelPage")} ${item.page}` : ""}</small></div>) : <p className="muted text-ui-xs">{t("buildingModelNoEvidence")}</p>}{candidate.uncertainty != null && <p className="muted text-ui-2xs">{t("buildingModelUncertainty")}: {typeof candidate.uncertainty === "string" ? candidate.uncertainty : JSON.stringify(candidate.uncertainty)}</p>}</div>
    <div className="building-model-candidate-actions"><Button size="sm" disabled={pending} onClick={() => onReview("approved", correction)}>{t("buildingModelAcceptCandidate")}</Button><Button size="sm" variant="outline" disabled={pending} onClick={() => onReview("rejected")}>{t("buildingModelRejectCandidate")}</Button></div>
  </>;
}

function ObjectInspector({ region, sourcePage, sourceVersionId, sourceRegion, proposals, t, onPage, onSave, onMeasurementSave, pending }: { region: BuildingRegion; sourcePage: number; sourceVersionId?: string; sourceRegion?: BuildingRegion["box"]; proposals: RecordData[]; t: ReturnType<typeof useT>; onPage: (page: number) => void; onSave: (body: RecordData) => void; onMeasurementSave: (measurement: NonNullable<BuildingRegion["measurements"]>[number], value: number) => void; pending: boolean }) {
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
  return (
    <>
      <dl>
        <dt>{t("buildingModelObjectId")}</dt><dd><button type="button" className="building-model-id-copy mono" onClick={copyId} title={t("buildingModelCopyObjectId")} aria-label={`${t("buildingModelCopyObjectId")}: ${region.id}`}><span>{region.id}</span><Copy className="size-icon-sm" aria-hidden="true" />{copied && <small>{t("buildingModelCopiedObjectId")}</small>}{copyFailed && <small>{t("buildingModelCopyUnavailable")}</small>}</button></dd>
        <dt>{t("buildingModelSourcePage")}</dt><dd><button type="button" className="text-primary underline underline-offset-2" onClick={() => onPage(sourcePage)}>{t("buildingModelPage")} {sourcePage}</button></dd>
      </dl>
      <div className="building-model-inspector-section">
        <h3>{t("buildingModelProperties")}</h3>
        <Field label={t("buildingModelLabel")} hint={t("buildingModelCorrectionHint")}>
          <Input value={label} onChange={(event) => setLabel(event.target.value)} />
        </Field>
        <Button size="sm" variant="outline" disabled={pending || !label.trim() || label === region.label} onClick={() => onSave({ name: label.trim() })}>{t("buildingModelSaveCorrection")}</Button>
        {region.entityType === "room" && <Field label={t("buildingModelRoomUse")} hint={t("buildingModelRoomUseHint")}><Input defaultValue={region.roomUse || ""} onBlur={(event) => { if (sourceVersionId && event.target.value !== (region.roomUse || "")) onSave({ roomUse: event.target.value.trim() || null, evidence: [{ kind: "page", sourceVersionId, page: sourcePage, ...(region.box ? { region: region.box } : {}) }] }); }} /></Field>}
      </div>
      <div className="building-model-inspector-section">
        <h3>{t("buildingModelMeasurements")}</h3>
        {region.measurements?.length ? region.measurements.map((measurement) => (
          <Measurement key={measurement.key} measurement={measurement} t={t} onSave={(value) => onMeasurementSave(measurement, value)} pending={pending} />
        )) : <NewMeasurementForm t={t} pending={pending} onSave={(measurement, value) => onMeasurementSave({ ...measurement, evidence: sourceVersionId ? [{ kind: "page", sourceVersionId, page: sourcePage, ...(sourceRegion ? { region: sourceRegion } : {}) }] : [] }, value)} />}
      </div>
      <div className="building-model-inspector-section">
        <h3>{t("buildingModelPendingProposals")}</h3>
        {proposals.length ? proposals.map((proposal) => <div className="building-model-evidence-row" key={proposal.id}><span><Badge>{t("buildingModelPending")}</Badge> {String(proposal.payload?.value ?? proposal.payload?.proposedValue ?? "—")}</span><small>{String(proposal.payload?.reason || t("buildingModelNoReason"))} {proposal.payload?.evidence?.[0]?.page ? `· ${t("buildingModelPage")} ${proposal.payload.evidence[0].page}` : ""}</small></div>) : <p className="muted text-ui-xs">{t("buildingModelNoPendingProposals")}</p>}
      </div>
      <div className="building-model-inspector-section">
        <h3>{t("buildingModelEvidence")}</h3>
        {region.evidence?.length ? region.evidence.map((item, index) => <div className="building-model-evidence-row" key={`${item.label}-${index}`}><span>{item.label}</span><small>{item.value} · {item.source === "source-stated" ? t("buildingModelSourceStated") : item.source === "calibrated" ? t("buildingModelCalibrated") : t("buildingModelInferred")} {item.page ? `· p. ${item.page}` : ""}</small></div>) : <p className="muted text-ui-xs">{t("buildingModelNoEvidence")}</p>}
        <button type="button" className="building-model-reference" onClick={() => onPage(sourcePage)}><span>{t("buildingModelOpenSourcePage")} {sourcePage}</span><ExternalLink className="size-icon-sm" aria-hidden="true" /></button>
      </div>
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
      <Button size="sm" variant="outline" type="submit" disabled={pending || !value}>{t("buildingModelAddMeasurement")}</Button>
      <p className="muted text-ui-2xs">{t("buildingModelMeasurementMaterialHint")}</p>
    </form>
  );
}
