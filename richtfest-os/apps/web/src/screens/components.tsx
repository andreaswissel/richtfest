import { useState } from "react";
import "./components.css";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  componentImportInput,
  type ComponentList,
  type ComponentDetail,
  type ComponentRecord,
} from "@richtfest/shared";
import { api } from "../api";
import { queryClient } from "../query";
import { useT } from "../i18n";
import { Page, PageHeader, Section } from "../components/layout";
import { Input, Textarea } from "../components/ui/input";
import { NativeSelect } from "../components/ui/native-select";
import { Button } from "../components/ui/button";
import {
  Badge,
  Callout,
  Empty,
  Field,
  Modal,
  RowLink,
  Segmented,
  Table,
} from "../components/ui/primitives";

const categories = ["window_system", "floor_slab", "other"] as const;
const statuses = ["unreviewed", "reviewed", "rejected"] as const;
const labelKeys = {
  window_system: "componentWindow",
  floor_slab: "componentSlab",
  other: "componentOther",
  unknown: "componentUnknown",
  on_site: "componentOnSite",
  semi_precast: "componentSemiPrecast",
  precast_element: "componentPrecast",
  unreviewed: "componentUnreviewed",
  reviewed: "componentReviewed",
  rejected: "componentRejected",
} as const;
const propertyKeys = {
  slab_thickness: "componentPropSlabThickness",
  system_width: "componentPropSystemWidth",
  transport_weight_per_area: "componentPropTransportWeight",
  calculation_weight_per_area: "componentPropCalculationWeight",
  concrete_strength_class: "componentPropConcrete",
  indicative_residential_span: "componentPropSpan",
  profile_depth: "componentPropDepth",
  maximum_glazing_thickness: "componentPropGlazing",
  frame_sash_chambers: "componentPropChambers",
  seals: "componentPropSeals",
  AD_Uf_example: "componentPropADUf",
  AD_Uw_example: "componentPropADUw",
  MD_Uf_example: "componentPropMDUf",
  MD_Uw_example: "componentPropMDUw",
  precast_plate_thickness: "componentPropPlateThickness",
  plate_width: "componentPropPlateWidth",
  maximum_plate_length: "componentPropPlateLength",
  typical_precast_plate_mass_per_area: "componentPropPlateMass",
  site_work_dependencies: "componentPropSiteWork",
} as const;
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function refreshComponents() {
  return queryClient.invalidateQueries({
    predicate: (query) =>
      typeof query.queryKey[0] === "string" &&
      query.queryKey[0].startsWith("/components"),
  });
}
function RecordBadges({ record }: { record: ComponentRecord }) {
  const t = useT();
  return (
    <div className="flex flex-wrap gap-stack text-ui-sm">
      <Badge>{t(labelKeys[record.data.category])}</Badge>
      <Badge>{t(labelKeys[record.data.prefabrication])}</Badge>
      <Badge>{t(labelKeys[record.reviewStatus])}</Badge>
      <Badge>
        {t("componentRevision")} {record.revision}
      </Badge>
    </div>
  );
}
function Facts({
  record,
  inline = false,
}: {
  record: ComponentRecord;
  inline?: boolean;
}) {
  const t = useT();
  const [params] = useSearchParams();
  return (
    <dl className="grid min-w-0 text-ui-sm">
      {record.data.facts.map((fact, index) => {
        const source = record.data.sources.find((s) => s.id === fact.sourceId);
        const next = new URLSearchParams(inline ? params : undefined);
        next.set("source", fact.sourceId);
        next.set("page", String(fact.page ?? 1));
        next.set("view", "document");
        const property =
          propertyKeys[fact.property as keyof typeof propertyKeys];
        return (
          <div key={index} className="component-fact border-b py-cell min-w-0">
            <dt className="muted">
              {property ? t(property) : fact.property.replaceAll("_", " ")}
            </dt>
            <dd className="break-words font-medium">
              {typeof fact.value === "boolean"
                ? t(fact.value ? "componentTrue" : "componentFalse")
                : String(fact.value)}
              {fact.unit ? ` ${fact.unit}` : ""}
            </dd>
            <dd>
              {source && (
                <Link
                  className="underline text-ui-xs whitespace-nowrap"
                  title={`${source.title}${fact.page ? ` · ${t("componentPage")} ${fact.page}` : ""}`}
                  to={inline ? `?${next}` : `/components/${record.id}?${next}`}
                >
                  {fact.page
                    ? `${t("componentPageShort")} ${fact.page}`
                    : `${t("componentSource")} ${record.data.sources.indexOf(source) + 1}`}
                </Link>
              )}
            </dd>
            {fact.conditions && (
              <dd className="col-span-3 break-words text-ui-xs">
                <span className="muted">{t("componentConditions")}: </span>
                {fact.conditions}
              </dd>
            )}
          </div>
        );
      })}
    </dl>
  );
}
function EvidenceMetadata({ record }: { record: ComponentRecord }) {
  const t = useT();
  return (
    <>
      <details className="text-ui-sm">
        <summary className="cursor-pointer py-cell">
          {t("componentWarnings")} ({record.data.warnings.length})
        </summary>
        {record.data.warnings.length ? (
          <ul className="list-disc pl-4 grid gap-stack">
            {record.data.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t("componentNoWarnings")}</p>
        )}
      </details>
      <details className="text-ui-sm">
        <summary className="cursor-pointer py-cell">
          {t("componentSources")} ({record.data.sources.length})
        </summary>
        {record.data.sources.map((source) => (
          <div className="grid gap-stack border-b py-cell" key={source.id}>
            <a
              className="underline break-words"
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {source.title}
            </a>
            <dl className="grid gap-stack">
              <div>
                <dt className="muted">{t("componentEdition")}</dt>
                <dd>{source.edition ?? t("componentNotSupplied")}</dd>
              </div>
              <div>
                <dt className="muted">{t("componentRetrieved")}</dt>
                <dd>{source.retrievedOn}</dd>
              </div>
              <div>
                <dt className="muted">{t("componentChecksum")}</dt>
                <dd className="break-all">
                  {source.sha256 ?? t("componentNotSupplied")}
                </dd>
              </div>
              <div>
                <dt className="muted">{t("componentPageCount")}</dt>
                <dd>{source.pages ?? t("componentNotSupplied")}</dd>
              </div>
            </dl>
            <p>{source.note}</p>
          </div>
        ))}
      </details>
    </>
  );
}
export function Components() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const [importOpen, setImportOpen] = useState(false);
  const q = params.get("q") || "",
    category = params.get("category") || "",
    reviewStatus = params.get("reviewStatus") || "";
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const path = `/components?${new URLSearchParams({ q, category, reviewStatus, offset: String(offset) })}`;
  const query = useQuery({
    queryKey: [path],
    queryFn: () => api<ComponentList>(path),
  });
  const selectedId = params.get("selected");
  const cached = queryClient
    .getQueriesData<ComponentList>({
      predicate: (item) =>
        typeof item.queryKey[0] === "string" &&
        item.queryKey[0].startsWith("/components?"),
    })
    .flatMap(([, data]) => data?.items ?? []);
  const selected =
    query.data?.items.find((item) => item.id === selectedId) ??
    cached.find((item) => item.id === selectedId);
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    if (key !== "offset") next.delete("offset");
    setParams(next, { replace: key === "q" });
  };
  const importer = useMutation({
    mutationFn: async (file: File | null) => {
      if (!file) return api("/components/import-starter", {});
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error(t("componentInvalidJson"));
      }
      const validated = componentImportInput.safeParse(parsed);
      if (!validated.success)
        throw new Error(
          validated.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        );
      return api("/components/import", validated.data);
    },
    onSuccess: refreshComponents,
  });
  const template = useMutation({
    mutationFn: async () =>
      download(await api("/components/starter"), "components-starter.json"),
  });
  return (
    <div className="components-screen">
      <Page>
        <PageHeader
          title={t("components")}
          description={t("componentCatalogHint")}
          actions={
            query.data?.canImport && (
              <Button onClick={() => setImportOpen(true)}>
                {t("componentImport")}
              </Button>
            )
          }
        />
        <div className="flex flex-wrap items-end gap-stack">
          <Field label={t("componentSearch")}>
            <Input
              value={q}
              onChange={(event) => change("q", event.target.value)}
            />
          </Field>
          <Field label={t("componentCategory")}>
            <NativeSelect
              value={category}
              onChange={(event) => change("category", event.target.value)}
            >
              <option value="">{t("componentAll")}</option>
              {categories.map((value) => (
                <option key={value} value={value}>
                  {t(labelKeys[value])}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t("componentReviewStatus")}>
            <NativeSelect
              value={reviewStatus}
              onChange={(event) => change("reviewStatus", event.target.value)}
            >
              <option value="">{t("componentAll")}</option>
              {statuses.map((value) => (
                <option key={value} value={value}>
                  {t(labelKeys[value])}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        {query.isPending && <p role="status">{t("loading")}</p>}
        {query.error && (
          <Callout tone="error">
            {query.error.message}
            <Button variant="link" onClick={() => query.refetch()}>
              {t("retry")}
            </Button>
          </Callout>
        )}
        <div
          className={`grid min-w-0 gap-section ${selected ? "xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" : ""}`}
        >
          <Section title={t("components")}>
            {query.data &&
              (query.data.items.length ? (
                <Table
                  headers={[
                    t("name"),
                    t("componentCategory"),
                    t("componentReviewStatus"),
                  ]}
                  rows={query.data.items.map((record) => {
                    const next = new URLSearchParams(params);
                    next.set("selected", record.id);
                    return {
                      id: record.id,
                      sort: [
                        record.data.name,
                        record.data.category,
                        record.reviewStatus,
                      ],
                      cells: [
                        <div
                          className="whitespace-normal break-words"
                          aria-current={
                            selectedId === record.id ? "true" : undefined
                          }
                        >
                          <RowLink to={`/components?${next}`}>
                            {record.data.name}
                          </RowLink>
                          <div className="muted text-ui-xs">
                            {record.data.manufacturer}
                          </div>
                        </div>,
                        <div className="grid gap-1 whitespace-normal">
                          <span>{t(labelKeys[record.data.category])}</span>
                          <span className="muted text-ui-xs">
                            {t(labelKeys[record.data.prefabrication])}
                          </span>
                        </div>,
                        <Badge>{t(labelKeys[record.reviewStatus])}</Badge>,
                      ],
                    };
                  })}
                />
              ) : (
                <Empty>{t("componentEmpty")}</Empty>
              ))}
            {query.data && (
              <div className="flex gap-stack">
                <Button
                  variant="outline"
                  disabled={offset === 0}
                  onClick={() => change("offset", "0")}
                >
                  {t("componentFirstPage")}
                </Button>
                <Button
                  variant="outline"
                  disabled={query.data.nextOffset === null}
                  onClick={() =>
                    change("offset", String(query.data!.nextOffset))
                  }
                >
                  {t("componentNextPage")}
                </Button>
              </div>
            )}
          </Section>
          {selected && (
            <aside
              className="min-w-0 border-t pt-4 xl:border-t-0 xl:border-l xl:pl-4 xl:pt-0 grid content-start gap-stack"
              aria-label={t("componentInspector")}
            >
              <div className="flex items-start justify-between gap-stack">
                <div>
                  <h2 className="font-medium text-ui-lg">
                    {selected.data.name}
                  </h2>
                  <p className="muted text-ui-sm">
                    {selected.data.manufacturer}
                  </p>
                </div>
                <Button variant="ghost" onClick={() => change("selected", "")}>
                  {t("close")}
                </Button>
              </div>
              <RecordBadges record={selected} />
              <Button asChild variant="outline">
                <Link to={`/components/${selected.id}`}>
                  {t("componentOpenRecord")}
                </Link>
              </Button>
              <Section title={t("componentScope")}>
                <p className="text-ui-sm">{selected.data.scopeNote}</p>
              </Section>
              <Section title={t("componentFacts")}>
                <Facts record={selected} />
              </Section>
              <EvidenceMetadata record={selected} />
            </aside>
          )}
        </div>
        {importOpen && (
          <Modal
            title={t("componentImport")}
            onClose={() => setImportOpen(false)}
          >
            <p className="text-ui-sm muted">{t("componentImportHint")}</p>
            <div className="flex flex-wrap gap-stack">
              <Button
                disabled={importer.isPending}
                onClick={() => importer.mutate(null)}
              >
                {t("componentImportStarter")}
              </Button>
              <Button
                variant="outline"
                disabled={template.isPending}
                onClick={() => template.mutate()}
              >
                {t("componentTemplate")}
              </Button>
            </div>
            <Field label={t("componentImportJson")}>
              <Input
                type="file"
                accept=".json,application/json"
                disabled={importer.isPending}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) importer.mutate(file);
                  event.target.value = "";
                }}
              />
            </Field>
            {(importer.error || template.error) && (
              <Callout tone="error">
                {(importer.error || template.error)?.message}
              </Callout>
            )}
            {importer.isSuccess && (
              <Callout>{t("componentImportSuccess")}</Callout>
            )}
          </Modal>
        )}
      </Page>
    </div>
  );
}

export function ComponentDetailScreen() {
  const { id } = useParams();
  const path = `/components/${id}`;
  const query = useQuery({
    queryKey: [path],
    queryFn: () => api<ComponentDetail>(path),
  });
  const t = useT();
  const [params, setParams] = useSearchParams();
  const current = query.data?.component;
  const record =
    query.data?.history.find(
      (item) => item.revisionId === params.get("revision"),
    ) ?? current;
  const source =
    record?.data.sources.find((item) => item.id === params.get("source")) ??
    record?.data.sources[0];
  const firstPage =
    record?.data.facts.find((fact) => fact.sourceId === source?.id && fact.page)
      ?.page ?? 1;
  const page = Math.min(
    source?.pages ?? 1,
    Math.max(1, Math.floor(Number(params.get("page")) || firstPage)),
  );
  const document = query.data?.documents?.find(
    (item) =>
      source?.sha256 &&
      item.sha256 === source.sha256 &&
      item.pages === source.pages,
  );
  const pdf =
    record && source
      ? `/api/components/${record.id}/revisions/${record.revisionId}/sources/${encodeURIComponent(source.id)}/pdf#page=${page}&view=FitH&toolbar=0&navpanes=0`
      : "";
  const view = params.get("view") === "document" ? "document" : "facts";
  const change = (values: Record<string, string>) => {
    const next = new URLSearchParams(params);
    Object.entries(values).forEach(([key, value]) => next.set(key, value));
    setParams(next);
  };
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const response = await fetch(pdf.split("#")[0], {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/pdf" },
        body: file,
      });
      const result = await response.json();
      if (!response.ok || result.error)
        throw new Error(result.message || t("componentPdfUploadFailed"));
      return result.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [path] }),
  });
  return (
    <div className="components-screen">
      <Page>
        <nav aria-label={t("componentBreadcrumb")} className="text-ui-sm">
          <Link className="underline" to="/components">
            {t("components")}
          </Link>
          {record && <> / {record.data.name}</>}
        </nav>
        {query.isPending && <p role="status">{t("loading")}</p>}
        {query.error && (
          <Callout tone="error">
            {query.error.message}
            <Button variant="link" onClick={() => query.refetch()}>
              {t("retry")}
            </Button>
          </Callout>
        )}
        {record && current && query.data && (
          <>
            <PageHeader
              title={record.data.name}
              description={record.data.manufacturer}
              actions={
                <Button
                  variant="ghost"
                  onClick={() =>
                    download(
                      {
                        records: [
                          {
                            data: current.data,
                            expectedRevisionId: current.revisionId,
                          },
                        ],
                      },
                      `${current.data.key}-revision-${current.revision}.json`,
                    )
                  }
                >
                  {t("componentDownloadCurrent")}
                </Button>
              }
            />
            <div className="flex flex-wrap gap-stack items-center">
              <RecordBadges record={record} />
              <span className="muted text-ui-sm">
                {record.revisionId === current.revisionId
                  ? t("componentCurrent")
                  : t("componentHistorical")}
              </span>
            </div>
            <div className="lg:hidden">
              <Segmented
                value={view}
                onChange={(value) => change({ view: value })}
                items={[
                  { value: "facts", label: t("componentFacts") },
                  { value: "document", label: t("componentDocument") },
                ]}
              />
            </div>
            <div className="grid min-w-0 gap-section lg:grid-cols-[minmax(0,11fr)_minmax(0,9fr)] items-start">
              <div
                className={`${view === "document" ? "grid" : "hidden"} lg:grid min-w-0 gap-stack lg:sticky lg:top-4`}
              >
                <Field label={t("componentSource")}>
                  <NativeSelect
                    className="w-full"
                    value={source?.id ?? ""}
                    onChange={(event) => {
                      upload.reset();
                      change({ source: event.target.value, page: "" });
                    }}
                  >
                    {record.data.sources.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                {source && (
                  <>
                    <div className="flex flex-wrap items-center gap-stack text-ui-sm">
                      <a
                        className="underline"
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t("componentOpenOriginal")}
                      </a>
                      {document && (
                        <a
                          className="underline"
                          href={pdf}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t("componentOpenSavedPdf")}
                        </a>
                      )}
                    </div>
                    {document ? (
                      <>
                        <div className="flex flex-wrap items-end gap-stack">
                          <Button
                            variant="outline"
                            disabled={page <= 1}
                            onClick={() => change({ page: String(page - 1) })}
                          >
                            {t("componentPreviousPage")}
                          </Button>
                          <Field
                            label={`${t("componentPage")} / ${source.pages}`}
                          >
                            <Input
                              className="w-20"
                              aria-label={t("componentPage")}
                              type="number"
                              min={1}
                              max={source.pages ?? undefined}
                              value={page}
                              onChange={(event) =>
                                change({
                                  page: String(
                                    Math.min(
                                      source.pages ?? 1,
                                      Math.max(
                                        1,
                                        Number(event.target.value) || 1,
                                      ),
                                    ),
                                  ),
                                })
                              }
                            />
                          </Field>
                          <Button
                            variant="outline"
                            disabled={page >= (source.pages ?? 1)}
                            onClick={() => change({ page: String(page + 1) })}
                          >
                            {t("componentNextPage")}
                          </Button>
                        </div>
                        <iframe
                          key={`${record.revisionId}:${source.id}:${page}`}
                          title={source.title}
                          src={pdf}
                          className="w-full h-[65dvh] lg:h-[72dvh] rounded border bg-muted"
                        />
                        <p className="muted text-ui-xs">
                          {t("componentPdfFallback")}
                        </p>
                      </>
                    ) : (
                      <div className="grid content-center gap-stack rounded border bg-muted/30 p-page min-h-64">
                        <h2 className="font-medium text-ui-lg">
                          {t(
                            source.sha256 && source.pages
                              ? "componentMissingPdf"
                              : "componentExternalSource",
                          )}
                        </h2>
                        <p className="text-ui-sm">
                          {t(
                            source.sha256 && source.pages
                              ? "componentPdfUploadHint"
                              : "componentFingerprintHint",
                          )}
                        </p>
                        {query.data.canImport &&
                          record.revisionId === current.revisionId &&
                          source.sha256 &&
                          source.pages && (
                            <Field label={t("componentUploadPdf")}>
                              <Input
                                type="file"
                                accept=".pdf,application/pdf"
                                disabled={upload.isPending}
                                onChange={(event) => {
                                  const file = event.target.files?.[0];
                                  if (file) upload.mutate(file);
                                  event.target.value = "";
                                }}
                              />
                            </Field>
                          )}
                        {record.revisionId !== current.revisionId && (
                          <p className="muted text-ui-sm">
                            {t("componentHistoricalReview")}
                          </p>
                        )}
                        <p className="muted text-ui-xs">
                          {t("componentPdfReviewUnchanged")}
                        </p>
                      </div>
                    )}
                  </>
                )}
                {upload.isPending && (
                  <p role="status">{t("componentPdfUploading")}</p>
                )}
                {upload.error && (
                  <Callout tone="error">{upload.error.message}</Callout>
                )}
                {upload.isSuccess && (
                  <Callout>{t("componentPdfAttached")}</Callout>
                )}
              </div>
              <div
                className={`${view === "facts" ? "grid" : "hidden"} lg:grid min-w-0 gap-section`}
              >
                <Section title={t("componentScope")}>
                  <p className="text-ui-sm">{record.data.scopeNote}</p>
                </Section>
                <Section title={t("componentFacts")}>
                  <Facts record={record} inline />
                </Section>
                <Callout>{t("componentUnknownCommercial")}</Callout>
                <EvidenceMetadata record={record} />
                <details className="text-ui-sm">
                  <summary className="cursor-pointer py-cell">
                    {t("componentHistory")}
                  </summary>
                  <div className="flex flex-wrap gap-stack">
                    {[
                      current,
                      ...query.data.history.filter(
                        (item) => item.revisionId !== current.revisionId,
                      ),
                    ].map((item) => {
                      const next = new URLSearchParams(params);
                      next.set("revision", item.revisionId);
                      next.delete("source");
                      next.delete("page");
                      return (
                        <Link
                          key={item.revisionId}
                          className={`rounded border px-2 py-cell ${record.revisionId === item.revisionId ? "bg-muted" : ""}`}
                          to={`?${next}`}
                          onClick={() => upload.reset()}
                          aria-current={
                            record.revisionId === item.revisionId
                              ? "true"
                              : undefined
                          }
                        >
                          {t("componentRevision")} {item.revision}
                          {item.revisionId === current.revisionId
                            ? ` · ${t("componentCurrent")}`
                            : ""}
                        </Link>
                      );
                    })}
                  </div>
                  <p className="muted break-all py-cell">
                    {record.revisionId} · {record.createdAt}
                  </p>
                  {record.reviewNote && <p>{record.reviewNote}</p>}
                  <p className="muted">
                    {t("componentReviewedAt")}:{" "}
                    {record.reviewedAt ?? t("componentNotSupplied")}
                  </p>
                </details>
                <Section title={t("componentReviewDecision")}>
                  <Callout>{t("componentReviewHint")}</Callout>
                  {record.revisionId !== current.revisionId ? (
                    <Callout>{t("componentHistoricalReview")}</Callout>
                  ) : query.data.canReview ? (
                    <Review
                      key={`${current.revisionId}:${current.reviewVersion}`}
                      record={current}
                    />
                  ) : (
                    <p className="muted">{t("componentReviewPermission")}</p>
                  )}
                </Section>
              </div>
            </div>
          </>
        )}
      </Page>
    </div>
  );
}
function Review({ record }: { record: ComponentRecord }) {
  const t = useT();
  const [status, setStatus] = useState(record.reviewStatus);
  const [note, setNote] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api(`/components/${record.id}/review`, {
        expectedRevisionId: record.revisionId,
        expectedReviewVersion: record.reviewVersion,
        status,
        note: note.trim(),
      }),
    onSuccess: refreshComponents,
  });
  return (
    <form
      className="grid gap-stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (note.trim() && !mutation.isPending) mutation.mutate();
      }}
    >
      <Field label={t("componentReviewStatus")}>
        <Segmented
          value={status}
          onChange={(value) => setStatus(value as typeof status)}
          items={statuses.map((value) => ({
            value,
            label: t(labelKeys[value]),
          }))}
        />
      </Field>
      <Field label={t("componentReviewNote")}>
        <Textarea
          required
          maxLength={2000}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      {mutation.error && (
        <Callout tone="error">{mutation.error.message}</Callout>
      )}
      {mutation.isSuccess && <Callout>{t("componentReviewSaved")}</Callout>}
      <div>
        <Button disabled={!note.trim() || mutation.isPending} type="submit">
          {t("componentSaveReview")}
        </Button>
      </div>
    </form>
  );
}
