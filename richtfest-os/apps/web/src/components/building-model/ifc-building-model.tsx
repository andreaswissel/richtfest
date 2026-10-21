import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import type { IfcBuildingEntity, IfcBuildingPreview, IfcFootprint } from "@richtfest/shared";
import { api, list, type RecordData } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { NativeSelect } from "../ui/native-select";
import { Checkbox } from "../ui/checkbox";
import { Badge, Callout, Field } from "../ui/primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

type DisplayEntity = IfcBuildingEntity & { id?: string; storeyId?: string; sourceVersionId?: string };

export function IfcBuildingModel({ projectId, model, files }: { projectId: string; model?: RecordData; files: RecordData[] }) {
  const t = useT();
  const [params] = useSearchParams();
  const [fileId, setFileId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [savedVersion, setSavedVersion] = useState("");
  const [selectedStoreys, setSelectedStoreys] = useState<number[]>([]);
  const [viewStorey, setViewStorey] = useState("");
  const [selected, setSelected] = useState(params.get("entity")?.split(":")[1] || "");
  const linkedEntityId = params.get("entity")?.split(":")[1] || "";
  useEffect(() => { setSelected(linkedEntityId); setSavedVersion(""); setViewStorey(""); }, [linkedEntityId]);
  const versions = useApi(`/projects/${projectId}/files/${fileId}/versions`, !!fileId);
  const readyVersions = list(versions.data).filter(v => v.status === "ready");
  const imports = list(model?.buildings).filter(b => b.geometry?.ifcImport);
  const receipts = [...new Map(imports.map(b => [b.geometry.ifcImport.sourceVersionId, b.geometry.ifcImport])).values()];
  const linkedSource = [...list(model?.rooms), ...list(model?.elements)].find(e => e.id === linkedEntityId)?.geometry?.source?.sourceVersionId;
  const activeVersion = receipts.some(r => r.sourceVersionId === savedVersion) ? savedVersion : linkedSource || receipts[0]?.sourceVersionId;
  const preview = useMutation({
    mutationFn: () => api<IfcBuildingPreview>(`/projects/${projectId}/building-model/ifc/preview`, { sourceVersionId: versionId }),
    onSuccess: () => { setSelectedStoreys([]); setViewStorey(""); setSelected(""); },
  });
  const importModel = useMutation({
    mutationFn: () => api(`/projects/${projectId}/building-model/ifc/import`, { sourceVersionId: versionId, baseRevision: model?.model?.revision ?? 0, storeyExpressIds: selectedStoreys }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] });
      setSavedVersion(versionId); preview.reset(); setViewStorey(""); setSelected("");
    },
  });
  const pending = preview.isPending || importModel.isPending;
  const entities = useMemo<DisplayEntity[]>(() => {
    if (preview.data) return preview.data.entities;
    return (["buildings", "storeys", "rooms", "elements"] as const).flatMap((key, index) => list(model?.[key])
      .filter(row => row.geometry?.source?.kind === "ifc" && row.geometry.source.sourceVersionId === activeVersion)
      .map(row => ({ ...row, entityType: (["building", "storey", "room", "element"] as const)[index],
        expressId: row.geometry.source.expressId, globalId: row.geometry.source.globalId, ifcType: row.geometry.source.ifcType,
        buildingExpressId: 0, geometry: row.geometry.footprint ? row.geometry as IfcFootprint : null,
        sourceVersionId: row.geometry.source.sourceVersionId } as DisplayEntity)));
  }, [model, activeVersion, preview.data]);
  const storeys = entities.filter(e => e.entityType === "storey");
  const keyOf = (entity: DisplayEntity) => entity.id || String(entity.expressId);
  const focusedEntity = entities.find(e => keyOf(e) === selected);
  const storey = storeys.find(e => keyOf(e) === viewStorey) || storeys.find(e => e.id && e.id === focusedEntity?.storeyId) || storeys[0];
  const objects = entities.filter(e => ["room", "element"].includes(e.entityType) && (preview.data ? e.storeyExpressId === storey?.expressId : e.storeyId === storey?.id));
  const selectedObject = objects.find(e => keyOf(e) === selected);
  const points = objects.flatMap(e => e.geometry?.footprint.flat(2) ?? []);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, -y); maxY = Math.max(maxY, -y); }
  const warnings = preview.data?.warnings ?? receipts.find(r => r.sourceVersionId === activeVersion)?.warnings ?? [];
  const error = preview.error || importModel.error || versions.error;
  const changeSource = () => { preview.reset(); importModel.reset(); setSelectedStoreys([]); };
  return <div className="flex min-w-0 flex-col gap-section p-page">
    <Section title={t("ifcBuildingTitle")} meta={<Badge>{t("buildingModelDraft")}</Badge>}>
      <p className="text-ui-sm text-muted-foreground">{t("ifcBuildingScope")}</p>
      {error && <Callout tone="error">{error.message}</Callout>}
      <details open={!receipts.length} className="mt-3">
        <summary className="cursor-pointer text-ui font-medium">{t("ifcBuildingImport")}</summary>
        {!files.length ? <Callout>{t("ifcBuildingNoFiles")} <Link to={`/projects/${projectId}?view=sources`}>{t("files")}</Link></Callout> : <div className="mt-3 flex flex-wrap items-end gap-stack">
          <Field label={t("ifcBuildingSource")}><NativeSelect aria-label={t("ifcBuildingSource")} value={fileId} disabled={pending} onChange={e => { setFileId(e.target.value); setVersionId(""); changeSource(); }}>
            <option value="">{t("ifcBuildingChoose")}</option>{files.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}
          </NativeSelect></Field>
          <Field label={t("buildingModelVersion")}><NativeSelect aria-label={t("buildingModelVersion")} value={versionId} disabled={pending || !fileId} onChange={e => { setVersionId(e.target.value); changeSource(); }}>
            <option value="">{t("buildingModelChooseRevision")}</option>{readyVersions.map(v => <option key={v.id} value={v.id}>{t("buildingModelVersion")} {v.version}</option>)}
          </NativeSelect></Field>
          <Button variant="outline" disabled={!versionId || pending} onClick={() => { importModel.reset(); preview.mutate(); }}>{preview.isPending ? t("ifcBuildingReading") : t("ifcBuildingPreview")}</Button>
        </div>}
      </details>
      {importModel.isSuccess && <Callout>{t("ifcBuildingImported")}</Callout>}
      {preview.data && <div className="mt-3 flex flex-col gap-stack">
        <Callout>{t("ifcBuildingSelectNote")}</Callout>
        <Table><TableHeader><TableRow><TableHead>{t("buildingModelBootstrapStorey")}</TableHead><TableHead>{t("ifcBuildingRooms")}</TableHead><TableHead>{t("ifcBuildingElements")}</TableHead><TableHead>{t("ifcBuildingGeometry")}</TableHead></TableRow></TableHeader>
          <TableBody>{storeys.map(s => {
            const children = entities.filter(e => e.storeyExpressId === s.expressId && e.entityType !== "storey");
            return <TableRow key={s.expressId}><TableCell className="py-cell"><div className="flex items-center gap-stack"><Checkbox aria-label={`${t("ifcBuildingInclude")} ${s.name}`} disabled={pending} checked={selectedStoreys.includes(s.expressId)} onCheckedChange={checked => setSelectedStoreys(current => checked ? [...current, s.expressId] : current.filter(id => id !== s.expressId))} />
              <Button variant="ghost" className="h-control-sm" onClick={() => { setViewStorey(keyOf(s)); setSelected(""); }}>{s.name}</Button></div></TableCell><TableCell>{children.filter(e => e.entityType === "room").length}</TableCell><TableCell>{children.filter(e => e.entityType === "element").length}</TableCell><TableCell>{children.filter(e => e.geometry).length} / {children.length}</TableCell></TableRow>;
          })}</TableBody></Table>
      </div>}
      {warnings.length > 0 && <details open={!!preview.data} className="mt-3"><summary className="cursor-pointer text-ui font-medium">{t("ifcBuildingWarnings")} ({warnings.length})</summary>
        <ul className="mt-2 list-disc pl-5 text-ui-sm text-muted-foreground">{warnings.map((w: IfcBuildingPreview["warnings"][number]) => <li key={w.code}>{t(`ifcWarning_${w.code}`)} ({w.count}){w.detail ? ` · ${w.detail}` : ""}</li>)}</ul>
      </details>}
      {preview.data && <div className="mt-3 flex flex-wrap items-center gap-stack"><Button disabled={!selectedStoreys.length || pending} onClick={() => importModel.mutate()}>{importModel.isPending ? t("ifcBuildingImporting") : t("ifcBuildingImportSelected")}</Button><span className="text-ui-xs text-muted-foreground">{t("ifcBuildingAppendNote")}</span></div>}
    </Section>
    {!!storeys.length && <Section title={t("ifcBuildingPlan")} meta={<Badge>{preview.data ? t("ifcBuildingPreviewLabel") : t("ifcBuildingSaved")}</Badge>}>
      <div className="mb-3 flex flex-wrap gap-stack">
        {!preview.data && receipts.length > 1 && <Field label={t("ifcBuildingSource")}><NativeSelect value={activeVersion} onChange={e => { setSavedVersion(e.target.value); setViewStorey(""); setSelected(""); }}>{receipts.map(r => <option value={r.sourceVersionId} key={r.sourceVersionId}>{r.fileName}</option>)}</NativeSelect></Field>}
        <Field label={t("buildingModelBootstrapStorey")}><NativeSelect aria-label={t("buildingModelBootstrapStorey")} value={storey ? keyOf(storey) : ""} onChange={e => { setViewStorey(e.target.value); setSelected(""); }}>{storeys.map(s => <option key={keyOf(s)} value={keyOf(s)}>{s.name}</option>)}</NativeSelect></Field>
        <Field label={t("ifcBuildingObject")}><NativeSelect aria-label={t("ifcBuildingObject")} value={selectedObject ? keyOf(selectedObject) : ""} onChange={e => setSelected(e.target.value)}><option value="">{t("ifcBuildingChoose")}</option>{objects.map(e => <option key={keyOf(e)} value={keyOf(e)}>{e.name} · {e.ifcType} #{e.expressId}</option>)}</NativeSelect></Field>
      </div>
      {points.length ? <svg aria-label={t("ifcBuildingPlan")} className="h-[480px] w-full rounded-md border bg-background" viewBox={`${minX - 1} ${minY - 1} ${maxX - minX + 2} ${maxY - minY + 2}`}>
        {objects.filter(e => e.geometry).sort((a, b) => (keyOf(a) === selected ? 2 : Number(a.entityType !== "room")) - (keyOf(b) === selected ? 2 : Number(b.entityType !== "room"))).map(e => <path key={keyOf(e)} role="button" tabIndex={0} aria-label={`${e.name} · ${e.ifcType} #${e.expressId}`} aria-pressed={keyOf(e) === selected}
          d={e.geometry!.footprint.map(p => p.map(r => r.map(([x, y], i) => `${i ? "L" : "M"}${x},${-y}`).join(" ") + "Z").join(" ")).join(" ")}
          fillRule="evenodd" className={`${keyOf(e) === selected ? "fill-foreground/20 stroke-foreground" : `${e.entityType === "room" ? "fill-muted stroke-border" : "fill-foreground/30 stroke-foreground/50"} hover:fill-foreground/10 focus:fill-foreground/10`} cursor-pointer focus:outline-none`}
          strokeWidth={keyOf(e) === selected ? 2 : 0.5} vectorEffect="non-scaling-stroke" onClick={() => setSelected(keyOf(e))} onKeyDown={event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); setSelected(keyOf(e)); } }}><title>{`${e.name} · ${e.ifcType} #${e.expressId}`}</title></path>)}
      </svg> : <Callout>{t("ifcBuildingNoGeometry")}</Callout>}
      {selectedObject && <div className="mt-3 flex flex-wrap gap-stack text-ui-sm" aria-live="polite"><strong>{selectedObject.name}</strong><span>{selectedObject.ifcType} #{selectedObject.expressId}</span><span>GlobalId: {selectedObject.globalId || "—"}</span>
        <span>{t("ifcBuildingElevation")}: {selectedObject.geometry?.elevationRange.map(n => n.toFixed(2)).join(" … ") ?? "—"} m</span>
        {selectedObject.id && <Link to={`/projects/${projectId}?view=building-model&modelSource=ifc&entity=${selectedObject.entityType}:${selectedObject.id}`}>{t("ifcBuildingObjectLink")}</Link>}
      </div>}
    </Section>}
  </div>;
}
