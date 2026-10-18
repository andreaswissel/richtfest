import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../api";
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
  return (
    <details className="site-secondary">
      <summary className="text-ui-sm">
        {label("Title")} · {data?.sources?.length ?? 0}
      </summary>
      <div className="site-evidence-controls">
        {query.error && <Callout tone="error">{query.error.message}</Callout>}
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
        {[importing.error, interpret.error, review.error]
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
