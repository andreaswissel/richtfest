import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { SourceDocumentModel } from "@richtfest/shared";
import { api, type RecordData } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Badge, Callout, Empty, Modal, Table } from "../ui/primitives";

export function SourceDocumentInspector({ projectId, source, onClose }: {
  projectId: string; source: RecordData; onClose: () => void;
}) {
  const t = useT();
  const [offset, setOffset] = useState(0);
  const session = useApi("/auth/me");
  const canWrite = (session.data?.permissions || session.data?.user?.permissions || []).includes("projects:write");
  const path = `/projects/${projectId}/source-versions/${source.versionId}/document-model`;
  const query = useQuery({ queryKey: [path, offset], queryFn: () => api<SourceDocumentModel>(`${path}?offset=${offset}&limit=1`) });
  const prepare = useMutation({
    mutationFn: () => api(`${path}/prepare`, {}),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: [path] }); },
  });
  const model = query.data;
  const page = model?.pages[0];
  const layers = model?.layers;
  const isPdf = source.mimeType === "application/pdf" || /\.pdf$/i.test(String(source.name || ""));
  const needsLayers = isPdf && model?.layersPrepared === false;
  const displayLabel = (label: string) => label.replace(/(?:\u0000|\\u0000)+$/g, "").replace(/\u0000/g, "\\u0000");
  return <Modal wide title={`${t("sourceDocumentModel")} · ${source.name}`} onClose={onClose}>
    <div className="flex min-w-0 flex-col gap-stack">
      <Callout>{t("sourceDocumentScope")}</Callout>
      {query.isPending && <p role="status">{t("loading")}</p>}
      {query.isError && <Callout tone="error">{query.error.message} <Button variant="link" onClick={() => query.refetch()}>{t("retry")}</Button></Callout>}
      {model && <>
        <div className="flex flex-wrap items-center gap-2 text-ui-sm">
          <Badge>{model.coverage.complete ? t("sourceDocumentTextPrepared") : t("sourceDocumentPartial")}</Badge>
          <span>{t("sourceDocumentPrepared")}: {model.coverage.preparedPages} / {model.coverage.totalPages ?? "?"}</span>
          <span>{t("sourceDocumentSaved")}: {model.coverage.savedPages}</span>
          <span>{t("sourceDocumentUnreadable")}: {model.coverage.unreadablePages}</span>
        </div>
        {isPdf && <section className="space-y-2">
          <h3 className="font-medium text-ui">{t("sourceDocumentLayers")}{layers?.status === "detected" ? ` · ${layers.groups.length}` : ""}</h3>
          <p className="text-ui-sm text-muted-foreground">{t(layers?.status === "detected" ? "sourceDocumentLayersDetected" : layers?.status === "none" ? "sourceDocumentLayersNone" : "sourceDocumentLayersUnavailable")}</p>
          {!!layers?.groups.length && <div className="max-h-48 overflow-auto [&_td]:whitespace-normal [&_td]:break-words [&_th]:whitespace-normal">
            <Table headers={[t("sourceDocumentLayerId"), t("name"), t("sourceDocumentGroupPath"), t("sourceDocumentVisibility")]} rows={layers.groups.map(group => ({ id: group.id, cells: [group.id, displayLabel(group.name || group.id), group.path?.length ? group.path.map(displayLabel).join(" / ") : "—", t(group.defaultVisibility === "visible" ? "sourceDocumentVisible" : group.defaultVisibility === "hidden" ? "sourceDocumentHidden" : "sourceDocumentUnknown")] }))} />
          </div>}
        </section>}
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-medium text-ui">{t("sourceDocumentBlocks")}{page ? ` · ${t("sourceDocumentPage")} ${page.page}` : ""}</h3>
            <div className="inline-actions">
              <Button variant="outline" disabled={offset === 0 || query.isFetching} onClick={() => setOffset(value => Math.max(0, value - 1))}>{t("sourceDocumentPrevious")}</Button>
              <Button variant="outline" disabled={model.nextOffset === null || query.isFetching} onClick={() => { if (model.nextOffset !== null) setOffset(model.nextOffset); }}>{t("sourceDocumentNext")}</Button>
            </div>
          </div>
          <div className="max-h-64 overflow-auto rounded-md border p-2">
            {page?.blocks.length ? page.blocks.map(block => <div key={block.id} className="border-b py-cell last:border-0">
              <p className="text-ui-2xs text-muted-foreground">{t("sourceDocumentGrid")}: {block.line}:{block.column} · {t("sourceDocumentBytes")}: {block.startByte}–{block.endByte}</p>
              <pre className="whitespace-pre-wrap break-words font-mono text-ui-sm">{block.text}</pre>
            </div>) : <Empty>{t("sourceDocumentNoBlocks")}</Empty>}
          </div>
        </section>
        {source.purpose === "project_evidence" && canWrite && (model.coverage.unpreparedPages > 0 || needsLayers) && <div>
          <p className="mb-2 text-ui-sm text-muted-foreground">{t("sourceDocumentPrepareHint")}</p>
          <Button disabled={prepare.isPending} onClick={() => prepare.mutate()}>{prepare.isPending ? t("loading") : t("sourceDocumentPrepare")}</Button>
        </div>}
      </>}
      {prepare.isError && <Callout tone="error">{prepare.error.message}</Callout>}
    </div>
  </Modal>;
}
