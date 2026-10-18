import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { DocumentTypeProposal } from "@richtfest/shared";
import { documentTypeLabel } from "../inquiries/labels";
import { api, uploadFile } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Checkbox } from "../ui/checkbox";
import { Badge, Callout, Field, Segmented } from "../ui/primitives";
export type EvidenceSource = {
  fileId: string;
  versionId: string;
  name: string;
  version: number;
  status: string;
  pages: number;
  documentTypeProposal?: DocumentTypeProposal;
};
type ProposalValue = {
  key: string;
  value: number | string;
  page: number;
  quote: string;
  reason: string;
  evidenceKind: "text" | "image";
};
type Proposal = {
  id: string;
  versionId: string;
  provider: string;
  status: string;
  payload: {
    constraints: ProposalValue[];
    planningFacts: ProposalValue[];
    limitations: string[];
  } | null;
  dispositions: Record<string, { decision: string }>;
  error: string | null;
};
export type AdoptedEvidence = {
  collection: "constraints" | "planningFacts";
  constraint: {
    key: string;
    value: {
      value: number | string;
      source: string;
      sourceDate: null;
      kind: "assessment";
      reviewed: false;
    };
  } | null;
};
export function SiteEvidencePanel({
  projectId,
  disabled,
  onAdopt,
}: {
  projectId: string;
  disabled: boolean;
  onAdopt: (v: AdoptedEvidence) => void;
}) {
  const t = useT(),
    label = (key: string) => t(`siteEvidence${key}` as Parameters<typeof t>[0]),
    path = `/feasibility/projects/${projectId}/evidence`;
  const query = useApi(path),
    data = query.data as
      | {
          sources: EvidenceSource[];
          proposals: Proposal[];
          canWrite: boolean;
          canInterpret: boolean;
        }
      | undefined;
  const [sourceId, setSourceId] = useState(""),
    [provider, setProvider] = useState("openai"),
    [pages, setPages] = useState("1"),
    [visual, setVisual] = useState(false),
    [url, setUrl] = useState("");
  const filePicker = useRef<HTMLInputElement>(null);
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const header = new TextDecoder().decode(await file.slice(0, 1024).arrayBuffer());
      if (!file.size || !header.includes("%PDF-"))
        throw new Error(label("InvalidPdf"));
      const form = new FormData();
      form.set("file", new File([file], file.name, { type: "application/pdf", lastModified: file.lastModified }));
      const result = await uploadFile<{ id: string; version: number }>(`/projects/${projectId}/files`, form, { workflow: "site_assessment" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/files`] }),
        queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}`] }),
        queryClient.invalidateQueries({ queryKey: [path], refetchType: "none" }),
      ]);
      if (currentProject.current !== projectId) return;
      const refreshed = await query.refetch();
      const source = (refreshed.data?.sources as EvidenceSource[] | undefined)?.find(
        (item) => item.fileId === result.id && item.version === result.version,
      );
      if (!source) throw new Error(label("UploadedRefreshFailed"));
      if (currentProject.current === projectId) {
        setSourceId(source.versionId);
        setPages("1");
      }
    },
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: [path] });
  const importing = useMutation({
    mutationFn: () => api(`${path}/import`, { url }, "POST"),
    onSuccess: refresh,
  });
  const interpret = useMutation({
    mutationFn: () =>
      api(
        `${path}/interpret`,
        {
          versionId: sourceId,
          pages: pages.split(",").map(Number),
          provider,
          visual,
        },
        "POST",
      ),
    onSuccess: refresh,
  });
  const review = useMutation({
    mutationFn: ({
      id,
      collection,
      index,
      decision,
    }: {
      id: string;
      collection: "constraints" | "planningFacts";
      index: number;
      decision: "adopted" | "rejected";
    }) =>
      api<AdoptedEvidence>(
        `${path}/proposals/${id}/review`,
        { collection, index, decision },
        "POST",
      ),
    onSuccess: (r) => {
      if (r.constraint) onAdopt(r);
      void refresh();
    },
  });
  const selected = data?.sources?.find((s) => s.versionId === sourceId),
    pageNumbers = pages.split(",").map(Number),
    validPages =
      pageNumbers.length > 0 &&
      pageNumbers.length <= 8 &&
      pageNumbers.every(
        (n) =>
          Number.isInteger(n) &&
          n > 0 &&
          (!selected?.pages || n <= selected.pages),
      ) &&
      (!visual || pageNumbers.length === 1);
  const processingSource = selected && ["queued", "running"].includes(selected.status);
  useEffect(() => {
    if (!processingSource) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      if (++attempts >= 24) window.clearInterval(timer);
      void query.refetch();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [projectId, selected?.versionId, processingSource, query.refetch]);
  const typeProposal = selected?.documentTypeProposal;
  return (
    <details className="site-secondary">
      <summary className="text-ui-sm">
        {label("Title")} · {data?.sources?.length ?? 0}
      </summary>
      <div className="site-evidence-controls">
        {query.error && <Callout tone="error">{query.error.message}</Callout>}
        <input
          ref={filePicker}
          type="file"
          accept="application/pdf,.pdf"
          disabled={disabled || !data?.canWrite || upload.isPending}
          hidden
          aria-label={label("Upload")}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) upload.mutate(file);
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !data?.canWrite || upload.isPending}
          aria-busy={upload.isPending}
          onClick={() => { upload.reset(); filePicker.current?.click(); }}
        >
          {label(upload.isPending ? "Uploading" : "Upload")}
        </Button>
        {upload.isSuccess && <p role="status" className="muted text-ui-xs">{label("Uploaded")}</p>}
        <Field label={label("ImportUrl")}>
          <Input
            value={url}
            disabled={disabled}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !url || importing.isPending}
          onClick={() => importing.mutate()}
        >
          {label("Import")}
        </Button>
        <Field label={label("Source")}>
          <NativeSelect
            value={sourceId || "_none"}
            onChange={(e) =>
              setSourceId(e.target.value === "_none" ? "" : e.target.value)
            }
          >
            <option value="_none">{label("Choose")}</option>
            {data?.sources?.map((s) => (
              <option key={s.versionId} value={s.versionId}>
                {s.name} · v{s.version}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {selected && <div className="text-ui-xs" aria-live="polite">
          <div className="inline-actions">
            <span className="muted">{label("DocumentKind")}</span>
            <strong>{typeProposal?.kind ? label(`Kind_${typeProposal.kind}`) : typeProposal?.documentType ? documentTypeLabel(typeProposal.documentType, t) : t("documentTypeUnknown")}</strong>
            {typeProposal?.status === "proposed" && <Badge variant="outline">{label("TypeUnreviewed")}</Badge>}
          </div>
          {processingSource ? <div className="inline-actions">
            <span className="muted">{label("TypeProcessing")}</span>
            <Button type="button" size="sm" variant="ghost" disabled={query.isFetching} onClick={() => void query.refetch()}>{label("RefreshSource")}</Button>
          </div> : selected.status === "failed" ? <p className="muted">{label("TypeFailed")}</p> : typeProposal?.status !== "proposed" ? <p className="muted">{label(typeProposal?.status === "ambiguous" ? "TypeAmbiguous" : "TypeUnknown")}</p> : null}
          {typeProposal?.evidence.slice(0, 2).map((evidence, index) => <blockquote key={index} className="muted mt-1">
            <a href={`/api/projects/${projectId}/files/${selected.fileId}/versions/${selected.version}/download?inline=1#page=${evidence.page}`} target="_blank" rel="noreferrer">{label("Page")} {evidence.page}</a>: {evidence.quote}
          </blockquote>)}
        </div>}
        <Field label={label("Pages")}>
          <Input
            value={pages}
            onChange={(e) => setPages(e.target.value)}
            aria-invalid={!validPages}
          />
        </Field>
        <Segmented
          value={provider}
          onChange={setProvider}
          items={[
            { value: "openai", label: "OpenAI" },
            { value: "anthropic", label: "Anthropic" },
          ]}
        />
        <label className="site-review text-ui-xs">
          <Checkbox
            checked={visual}
            onCheckedChange={(v) => setVisual(v === true)}
          />
          {label("Visual")}
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={
            disabled ||
            !data?.canInterpret ||
            !sourceId ||
            !validPages ||
            interpret.isPending
          }
          onClick={() => interpret.mutate()}
        >
          {label(interpret.isPending ? "Interpreting" : "Interpret")}
        </Button>
        {[upload.error, importing.error, interpret.error, review.error]
          .filter(Boolean)
          .map((error, i) => (
            <Callout key={i} tone="error">
              {error!.message}
            </Callout>
          ))}
        <p className="muted text-ui-xs">{label("Hint")}</p>
        {data?.proposals?.map((p) => (
          <div key={p.id} className="site-proposal">
            <div className="inline-actions">
              <Badge variant="outline">{label(p.status)}</Badge>
              <span className="text-ui-xs">{p.provider}</span>
            </div>
            {p.error && <Callout>{p.error}</Callout>}
            {p.payload &&
              (["constraints", "planningFacts"] as const).map((collection) =>
                p.payload?.[collection]?.map((v, index) => (
                  <div
                    key={`${collection}:${index}`}
                    className="site-proposal-row"
                  >
                    <strong className="text-ui-xs">
                      {t(`siteAssessment${v.key}` as Parameters<typeof t>[0]) ||
                        v.key}
                      : {String(v.value)}
                    </strong>
                    <blockquote className="text-ui-xs">{v.quote}</blockquote>
                    <span className="text-ui-2xs muted">
                      {(() => {
                        const source = data?.sources?.find((item) => item.versionId === p.versionId);
                        return source ? <a href={`/api/projects/${projectId}/files/${source.fileId}/versions/${source.version}/download?inline=1#page=${v.page}`} target="_blank" rel="noreferrer">{label("Page")} {v.page}</a> : <>{label("Page")} {v.page}</>;
                      })()} · {v.reason}
                    </span>
                    {p.dispositions?.[`${collection}:${index}`] ? (
                      <div className="inline-actions">
                        <Badge variant="outline">{label(p.dispositions[`${collection}:${index}`]!.decision)}</Badge>
                        {p.dispositions[`${collection}:${index}`]!.decision === "adopted" && <Button size="sm" variant="outline" disabled={disabled || review.isPending} onClick={() => review.mutate({id:p.id,collection,index,decision:"adopted"})}>{label("Reapply")}</Button>}
                      </div>
                    ) : (
                      <div className="inline-actions">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={disabled || review.isPending}
                          onClick={() =>
                            review.mutate({
                              id: p.id,
                              collection,
                              index,
                              decision: "adopted",
                            })
                          }
                        >
                          {label("Adopt")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={disabled || review.isPending}
                          onClick={() =>
                            review.mutate({
                              id: p.id,
                              collection,
                              index,
                              decision: "rejected",
                            })
                          }
                        >
                          {label("Reject")}
                        </Button>
                      </div>
                    )}
                  </div>
                )),
              )}
          </div>
        ))}
      </div>
    </details>
  );
}
