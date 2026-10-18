import { useEffect, useRef, useState } from "react";
import type {
  PlanOverlay,
  GeometryPoint,
} from "@richtfest/shared/site-geometry-model";
import { useApi } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DateInput } from "../ui/date-input";
import { NativeSelect } from "../ui/native-select";
import { Checkbox } from "../ui/checkbox";
import { Callout, Field } from "../ui/primitives";
import type { EvidenceSource } from "./site-evidence-panel";
import type { PdfEvidenceRenderer } from "../building-model/pdf-evidence-renderer";
import "../building-model/building-model.css";

const EMPTY_LAYERS: Record<string, boolean> = {};

export function usePlanRaster(projectId: string, overlay: PlanOverlay | null) {
  const sources = useApi(`/feasibility/projects/${projectId}/evidence`),
    [image, setImage] = useState<string | null>(null);
  const source = (
    sources.data as { sources: EvidenceSource[] } | undefined
  )?.sources?.find((s) => s.versionId === overlay?.fileVersionId);
  useEffect(() => {
    let active = true;
    let doc: any;
    setImage(null);
    if (source && overlay)
      void import("pdfjs-dist")
        .then(async (pdfjs) => {
          pdfjs.GlobalWorkerOptions.workerSrc = new URL(
            "pdfjs-dist/build/pdf.worker.min.mjs",
            import.meta.url,
          ).toString();
          if (!active) return;
          doc = await pdfjs.getDocument({
            url: `/api/projects/${projectId}/files/${source.fileId}/versions/${source.version}/download?inline=1`,
          }).promise;
          if (!active) { await doc.destroy(); return; }
          const page = await doc.getPage(overlay.page);
          if (!active) return;
          const natural = page.getViewport({ scale: 1 });
          const scale = Math.min(1.5, 4096 / Math.max(natural.width, natural.height), Math.sqrt(8_000_000 / (natural.width * natural.height)));
          const viewport = page.getViewport({ scale }),
            canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({
            canvasContext: canvas.getContext("2d")!,
            viewport,
          }).promise;
          if (active) setImage(canvas.toDataURL());
        })
        .catch(() => { if (active) setImage(null); });
    return () => {
      active = false;
      void doc?.destroy();
    };
  }, [source?.versionId, overlay?.page, projectId]);
  return image;
}
export function SitePlanAlignment({
  projectId,
  overlay,
  disabled,
  pickedSite,
  onRequestSite,
  onChange,
}: {
  projectId: string;
  overlay: PlanOverlay | null;
  disabled: boolean;
  pickedSite: GeometryPoint | null;
  onRequestSite: () => void;
  onChange: (value: PlanOverlay | null) => void;
}) {
  const t = useT(),
    label = (key: string) => t(`sitePlan${key}` as Parameters<typeof t>[0]),
    query = useApi(`/feasibility/projects/${projectId}/evidence`),
    sources =
      (query.data as { sources: EvidenceSource[] } | undefined)?.sources ?? [];
  const [sourceId, setSourceId] = useState(overlay?.fileVersionId ?? ""),
    [page, setPage] = useState(overlay?.page ?? 1),
    [imagePoint, setImagePoint] = useState<GeometryPoint | null>(null),
    [points, setPoints] = useState<PlanOverlay["controlPoints"]>([]),
    [Renderer, setRenderer] = useState<typeof PdfEvidenceRenderer>();
  const source = sources.find((s) => s.versionId === sourceId);
  useEffect(() => {
    void import("../building-model/pdf-evidence-renderer").then((module) =>
      setRenderer(() => module.PdfEvidenceRenderer),
    );
  }, []);
  const lastPick = useRef<GeometryPoint | null>(null);
  useEffect(() => {
    if (!pickedSite || pickedSite === lastPick.current || !imagePoint) return;
    lastPick.current = pickedSite;
    const next = [...points, { image: imagePoint, site: pickedSite }];
    setImagePoint(null);
    if (next.length === 3) {
      onChange({
        fileVersionId: sourceId,
        page,
        controlPoints: next,
        opacity: 0.55,
        source: `${source?.name ?? sourceId}, p. ${page}`,
        sourceDate: null,
        reviewed: false,
      });
      setPoints([]);
    } else setPoints(next);
  }, [pickedSite]);
  return (
    <details className="site-secondary">
      <summary className="text-ui-sm">{label("Title")}</summary>
      <div className="site-plan-alignment">
        <Callout>{label("Hint")}</Callout>
        <Field label={label("Source")}>
          <NativeSelect
            value={sourceId || "_none"}
            disabled={disabled}
            onChange={(e) => {
              setSourceId(e.target.value);
              setPage(1);
              setPoints([]);
              setImagePoint(null);
              lastPick.current = pickedSite;
            }}
          >
            <option value="_none">{label("Choose")}</option>
            {sources.map((s) => (
              <option value={s.versionId} key={s.versionId}>
                {s.name} · v{s.version}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={label("Page")}>
          <Input
            type="number"
            min={1}
            max={source?.pages || undefined}
            value={page}
            disabled={disabled}
            onChange={(e) => {
              const n = e.target.valueAsNumber;
              if (Number.isInteger(n) && n > 0) {
                setPage(n);
                setPoints([]);
                setImagePoint(null);
                lastPick.current = pickedSite;
              }
            }}
          />
        </Field>
        {source && Renderer && (
          <div className="site-plan-picker">
            <Renderer
              projectId={projectId}
              evidence={{
                fileId: source.fileId,
                fileName: source.name,
                version: source.version,
                pageCount: source.pages,
              }}
              page={page}
              regions={[]}
              layerVisibility={EMPTY_LAYERS}
              onLayers={() => {}}
              onSelect={() => {}}
              tool={disabled ? "pan" : "measure"}
              onPlanPick={(point) => {
                setImagePoint([point.x, point.y]);
                onRequestSite();
              }}
              labels={{
                empty: label("Empty"),
                loading: label("Loading"),
                region: label("Region"),
                zoom: label("Zoom"),
                zoomIn: label("ZoomIn"),
                zoomOut: label("ZoomOut"),
                fit: label("Fit"),
              }}
            />
          </div>
        )}
        <p className="text-ui-xs">
          {imagePoint ? label("PickMap") : label("PickPlan")} · {points.length}
          /3
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            setPoints([]);
            setImagePoint(null);
          }}
        >
          {label("Restart")}
        </Button>
        {overlay && (
          <>
            <Field label={label("Opacity")}>
              <Input
                type="range"
                disabled={disabled}
                min={0}
                max={1}
                step={0.05}
                value={overlay.opacity}
                onChange={(e) =>
                  onChange({ ...overlay, opacity: Number(e.target.value) })
                }
              />
            </Field>
            <Field label={label("Date")}>
              <DateInput
                disabled={disabled}
                value={overlay.sourceDate}
                onValueChange={(sourceDate) =>
                  onChange({ ...overlay, sourceDate, reviewed: false })
                }
              />
            </Field>
            <label className="site-review text-ui-xs">
              <Checkbox
                disabled={disabled || !overlay.sourceDate}
                checked={overlay.reviewed}
                onCheckedChange={(v) =>
                  onChange({ ...overlay, reviewed: v === true })
                }
              />
              {label("Reviewed")}
            </label>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onChange(null)}
            >
              {label("Remove")}
            </Button>
          </>
        )}
      </div>
    </details>
  );
}
