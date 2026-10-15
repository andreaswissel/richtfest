import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ExteriorNoiseFact } from "@richtfest/shared";
import { ApiError, api } from "../../api";
import { useQuery } from "@tanstack/react-query";
import { useApi, useWrite, queryClient } from "../../query";
import { useT } from "../../i18n";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { NativeSelect } from "../ui/native-select";
import { Badge, Callout, Field, Modal } from "../ui/primitives";
import { ArrowRight, Check, ChevronRight, Eye, FileText } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import "./acoustic-input-review.css";

type ReviewField = Pick<
  ExteriorNoiseFact,
  "roomId" | "target" | "id" | "field"
> & {
  key: string;
  value: string | number | boolean | null;
  candidates: ExteriorNoiseFact[];
  status: "missing" | "conflict" | "extracted" | "resolved";
  type: "number" | "boolean" | "string";
  options?: string[];
};
type VisualMapping =
  | { candidateKey: string; decision: "confirmed"; roomId: string }
  | { candidateKey: string; decision: "rejected" };
type VisualAreaReview =
  | {
      candidateKey: string;
      observationKey: string;
      decision: "approved";
      roomId: string;
    }
  | {
      candidateKey: string;
      observationKey: string;
      decision: "rejected";
    };
type Review = {
  revisionId: string;
  fields: ReviewField[];
  blockers: string[];
  sourceNotes: string[];
  input: {
    inventory: {
      roomId: string;
      provenance: ExteriorNoiseFact["provenance"];
    }[];
  } | null;
  visualCandidates?: {
    candidateKey: string;
    apartmentLabel: string | null;
    roomLabel: string | null;
    mapping: string;
    reviewStatus: "unreviewed";
    mappingDecision: "confirmed" | "rejected" | null;
    confirmedRoomId: string | null;
    floorAreaObservation?: {
      valueM2: number;
      basis: "explicitly_printed";
      reviewStatus: "unreviewed";
    };
    floorAreaObservationKey?: string | null;
    floorAreaDecision?: "approved" | "rejected" | null;
    floorAreaActive?: boolean;
    confirmedFloorAreaM2?: number | null;
    floorAreaRoomId?: string | null;
    provenance: {
      kind: "visual_inspection";
      versionId: string;
      page: number;
      crop: { x: number; y: number; width: number; height: number } | null;
      receiptId: string;
      imageHash: string;
    };
  }[];
  inventoryEvidence: {
    roomId: string;
    provenance: ExteriorNoiseFact["provenance"];
  }[];
  inventoryConfirmation: { at: string } | null;
};
type VisualCandidate = NonNullable<Review["visualCandidates"]>[number];

export function AcousticInputReview({
  artifactId,
  projectId,
  conversationId,
  writable,
}: {
  artifactId: string;
  projectId: string;
  conversationId?: string;
  writable: boolean;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const path = `/knowledge/conversations/${conversationId}/acoustic-inputs/${artifactId}`;
  // Historical forms add no requests to conversation navigation; load on explicit opening.
  const query = useApi(path, !!conversationId && expanded);
  if (!expanded)
    return (
      <Button
        type="button"
        variant="secondary"
        className="rounded-full px-4"
        onClick={() => setExpanded(true)}
      >
        {t("acousticInputsTitle")}
        <ArrowRight className="size-icon-sm" aria-hidden="true" />
      </Button>
    );
  if (!conversationId || query.isError)
    return <Callout>{t("acousticInputsUnavailable")}</Callout>;
  if (!query.data) return <Callout>{t("loading")}</Callout>;
  return (
    <ReviewForm
      path={path}
      data={query.data as Review}
      projectId={projectId}
      conversationId={conversationId}
      writable={writable}
    />
  );
}

function ReviewForm({
  path,
  data,
  projectId,
  conversationId,
  writable,
}: {
  path: string;
  data: Review;
  projectId: string;
  conversationId: string;
  writable: boolean;
}) {
  const t = useT();
  // Follow fresh data until editing starts; then protect that exact editing revision.
  const [editingBase, setEditingBase] = useState<Review | null>(null);
  const base = editingBase ?? data;
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    // Opening is an explicit user action; start at the questions, not at the
    // bottom edge chosen by the chat scroller when the form grows.
    const frame = requestAnimationFrame(() =>
      form.current?.scrollIntoView({ block: "start" }),
    );
    return () => cancelAnimationFrame(frame);
  }, []);
  const [room, setRoom] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState("");
  const [roomIdDrafts, setRoomIdDrafts] = useState<Record<string, string>>({});
  const [visualMappings, setVisualMappings] = useState<
    Record<string, VisualMapping>
  >({});
  const [visualAreaReviews, setVisualAreaReviews] = useState<
    Record<string, VisualAreaReview>
  >({});
  const [confirm, setConfirm] = useState(false);
  const [saved, setSaved] = useState(false);
  const [result, setResult] = useState<{
    artifact: { id: string };
    revision: { id: string };
  }>();
  const write = useWrite(path, (next) => {
    queryClient.setQueryData([path], next);
    setEditingBase(null);
    setEdits({});
    setCustom({});
    setConfirm(false);
    setRoomIdDrafts({});
    setVisualMappings({});
    setVisualAreaReviews({});
    setReason("");
    setSaved(true);
    setResult(next.calculation);
  });
  const stale = base.revisionId !== data.revisionId;
  const inventory = base.input?.inventory ?? base.inventoryEvidence;
  const rooms = [...new Set(inventory.map((r) => r.roomId))];
  const selected =
    room ||
    rooms.find((id) =>
      base.fields.some((f) => f.roomId === id && f.value === null),
    ) ||
    rooms[0];
  const visible = base.fields.filter(
    (f) => f.roomId === selected && (showAll || f.value === null),
  );
  const disabled = !writable || stale || write.isPending;
  const edit = (key: string, value: string) => {
    setEditingBase(base);
    setEdits((p) => ({ ...p, [key]: value }));
    setSaved(false);
  };
  const label = (field: string) => {
    const key = `acousticField_${field}` as Parameters<typeof t>[0];
    return t(key) || field;
  };
  const unit = (field: string) =>
    field.endsWith("M2") ? "m²" : field.endsWith("Db") ? "dB" : "";
  const clearAreaApprovalForMapping = (
    candidateKey: string,
    roomId: string | null,
  ) => {
    setVisualAreaReviews((current) => {
      const pending = current[candidateKey];
      if (
        !pending ||
        pending.decision !== "approved" ||
        pending.roomId === roomId
      )
        return current;
      const next = { ...current };
      delete next[candidateKey];
      return next;
    });
  };
  const question = (f: ReviewField) =>
    f.field === "floorAreaM2"
      ? t("acousticInputsFloorQuestion")
      : f.field === "areaM2"
        ? t("acousticInputsAreaQuestion").replace("{id}", f.id)
        : `${label(f.field)} · ${f.id}`;
  const openCount = base.fields.filter(
    (f) => f.roomId === selected && f.value === null,
  ).length;
  const source = (p: ExteriorNoiseFact["provenance"]) =>
    p.kind === "source" ? (
      <Link
        to={`/projects/${projectId}?conversation=${conversationId}&sourceVersion=${p.versionId}${p.page ? `&page=${p.page}` : ""}`}
        className="underline"
        title={p.excerpt}
      >
        {t("acousticInputsSource")}
        {p.page ? ` · ${p.page}` : ""}
      </Link>
    ) : (
      <span>{p.reason}</span>
    );
  const visualCandidates = base.visualCandidates ?? [];
  const pendingVisualMappings = Object.values(visualMappings);
  const pendingVisualAreaReviews = Object.values(visualAreaReviews);
  const changes = Object.entries(edits)
    .filter(([, value]) => value.trim() !== "")
    .map(([key, value]) => {
      const field = base.fields.find((f) => f.key === key)!;
      return {
        key,
        value:
          field.type === "number"
            ? Number(value)
            : field.type === "boolean"
              ? value === "true"
              : value,
      };
    });
  const submit = () => {
    setSaved(false);
    write.mutate({
      expectedRevisionId: base.revisionId,
      action: "save",
      reason,
      changes,
      confirmInventory: confirm,
      visualMappings: pendingVisualMappings,
      visualAreaReviews: pendingVisualAreaReviews,
    });
  };
  return (
    <form
      ref={form}
      className="acoustic-input-review min-w-0 space-y-6 py-3 text-ui"
      aria-label={t("acousticInputsTitle")}
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !reason.trim()) return;
        if (
          changes.length ||
          confirm ||
          pendingVisualMappings.length ||
          pendingVisualAreaReviews.length
        )
          submit();
      }}
    >
      <div className="space-y-2">
        <p className="font-medium">
          {openCount
            ? t(
                openCount === 1
                  ? "acousticInputsIntroOne"
                  : "acousticInputsIntro",
              )
                .replace("{room}", selected ?? "")
                .replace("{count}", String(openCount))
            : t(
                rooms.length
                  ? "acousticInputsRoomReady"
                  : "acousticInputsTitle",
              )}
        </p>
        <p className="text-ui-sm text-muted-foreground">
          {t("acousticInputsNext")}
        </p>
      </div>
      {stale && (
        <Callout>
          {t("acousticInputsStale")}{" "}
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setEditingBase(null);
              setEdits({});
              setCustom({});
              setConfirm(false);
              setRoomIdDrafts({});
              setVisualMappings({});
              setVisualAreaReviews({});
              setReason("");
              setSaved(false);
              write.reset();
            }}
          >
            {t("acousticInputsReload")}
          </Button>
        </Callout>
      )}
      {!rooms.length && <Callout>{t("acousticInputsNeedSources")}</Callout>}
      {visualCandidates.length > 0 && (
        <section className="space-y-2" aria-labelledby="acoustic-visual-candidates">
          <h3 id="acoustic-visual-candidates" className="font-medium">
            {t("acousticInputsVisualCandidates")}
          </h3>
          <Callout>{t("acousticInputsVisualCandidatesBoundary")}</Callout>
          <ul className="divide-y rounded-md border">
            {visualCandidates.map((candidate, index) => {
              const provenance = candidate.provenance;
              const pendingMapping = visualMappings[candidate.candidateKey];
              const draftRoomId =
                roomIdDrafts[candidate.candidateKey] ??
                candidate.confirmedRoomId ??
                "";
              const statusKey = pendingMapping
                ? "acousticInputsVisualMappingPending"
                : candidate.mappingDecision === "confirmed"
                  ? "acousticInputsVisualMappingConfirmed"
                  : candidate.mappingDecision === "rejected"
                    ? "acousticInputsVisualCandidateRejected"
                    : "acousticInputsVisualCandidateUnreviewed";
              const pendingAreaReview = visualAreaReviews[candidate.candidateKey];
              const areaRoomId = pendingMapping
                ? pendingMapping.decision === "confirmed"
                  ? pendingMapping.roomId
                  : null
                : candidate.mappingDecision === "confirmed"
                  ? candidate.confirmedRoomId
                  : null;
              const areaStatusKey = pendingAreaReview
                ? "acousticInputsVisualAreaPending"
                : candidate.floorAreaDecision === "approved"
                  ? candidate.floorAreaActive
                    ? "acousticInputsVisualAreaApproved"
                    : "acousticInputsVisualAreaInactive"
                  : candidate.floorAreaDecision === "rejected"
                    ? "acousticInputsVisualAreaRejected"
                    : "acousticInputsVisualAreaUnreviewed";
              return (
                <li key={`${candidate.candidateKey}:${index}`} className="space-y-2 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {[candidate.apartmentLabel, candidate.roomLabel]
                        .filter(Boolean)
                        .join(" · ") || t("acousticInputsVisualCandidateUnlabeled")}
                    </span>
                    <Badge>{t(statusKey)}</Badge>
                  </div>
                  <p className="whitespace-pre-wrap">{candidate.mapping}</p>
                  {candidate.mappingDecision === "confirmed" && !pendingMapping && (
                    <p className="text-ui-sm">
                      {t("acousticInputsVisualCanonicalRoom")}: {candidate.confirmedRoomId}
                    </p>
                  )}
                  <p className="flex flex-wrap items-center gap-x-2 text-ui-2xs text-muted-foreground">
                    <Link
                      to={`/projects/${projectId}?conversation=${conversationId}&sourceVersion=${provenance.versionId}&page=${provenance.page}`}
                      className="underline"
                    >
                      {t("acousticInputsSource")} · {t("acousticInputsPage")} {provenance.page}
                    </Link>
                    <span>{provenance.versionId}</span>
                    <span>{t("acousticInputsVisualReceipt")}: {provenance.receiptId}</span>
                    <span>{t("acousticInputsVisualImageHash")}: {provenance.imageHash}</span>
                  </p>
                  <VisualCandidateImagePreview
                    basePath={path}
                    candidate={candidate}
                  />
                  {writable && (
                    <div className="flex flex-wrap items-end gap-2">
                      <Field label={t("acousticInputsVisualCanonicalRoom")}>
                        <Input
                          value={draftRoomId}
                          disabled={disabled}
                          maxLength={200}
                          onChange={(event) => {
                            const nextRoomId = event.target.value.trim();
                            setEditingBase(base);
                            setSaved(false);
                            clearAreaApprovalForMapping(
                              candidate.candidateKey,
                              nextRoomId || null,
                            );
                            setRoomIdDrafts((current) => ({
                              ...current,
                              [candidate.candidateKey]: event.target.value,
                            }));
                          }}
                        />
                      </Field>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={disabled || !draftRoomId.trim()}
                        onClick={() => {
                          clearAreaApprovalForMapping(
                            candidate.candidateKey,
                            draftRoomId.trim(),
                          );
                          setEditingBase(base);
                          setSaved(false);
                          setVisualMappings((current) => ({
                            ...current,
                            [candidate.candidateKey]: {
                              candidateKey: candidate.candidateKey,
                              decision: "confirmed",
                              roomId: draftRoomId.trim(),
                            },
                          }));
                        }}
                      >
                        {t("acousticInputsVisualConfirmMapping")}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={disabled}
                        onClick={() => {
                          clearAreaApprovalForMapping(
                            candidate.candidateKey,
                            null,
                          );
                          setEditingBase(base);
                          setSaved(false);
                          setVisualMappings((current) => ({
                            ...current,
                            [candidate.candidateKey]: {
                              candidateKey: candidate.candidateKey,
                              decision: "rejected",
                            },
                          }));
                        }}
                      >
                        {t("acousticInputsVisualRejectCandidate")}
                      </Button>
                    </div>
                  )}
                  {candidate.floorAreaObservation && (
                    <section className="space-y-2 rounded-md border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {t("acousticInputsVisualPrintedArea")}: {String(candidate.floorAreaObservation.valueM2)} m²
                        </span>
                        <Badge>{t(areaStatusKey)}</Badge>
                      </div>
                      <p className="text-ui-sm text-muted-foreground">
                        {t("acousticInputsVisualAreaBoundary")}
                      </p>
                      {candidate.floorAreaDecision === "approved" &&
                        candidate.floorAreaActive &&
                        !pendingAreaReview && (
                        <p className="text-ui-sm">
                          {t("acousticInputsVisualAreaApprovedFor")}: {candidate.floorAreaRoomId} · {String(candidate.confirmedFloorAreaM2)} m²
                        </p>
                      )}
                      {pendingAreaReview?.decision === "approved" && (
                        <p className="text-ui-sm">
                          {t("acousticInputsVisualAreaPendingFor")}: {pendingAreaReview.roomId}
                        </p>
                      )}
                      {!areaRoomId && writable && (
                        <p className="text-ui-sm text-muted-foreground">
                          {t("acousticInputsVisualAreaNeedsRoom")}
                        </p>
                      )}
                      {writable && (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            disabled={
                              disabled ||
                              !areaRoomId ||
                              !candidate.floorAreaObservationKey
                            }
                            onClick={() => {
                              if (!areaRoomId || !candidate.floorAreaObservationKey) return;
                              setEditingBase(base);
                              setSaved(false);
                              setVisualAreaReviews((current) => ({
                                ...current,
                                [candidate.candidateKey]: {
                                  candidateKey: candidate.candidateKey,
                                  observationKey: candidate.floorAreaObservationKey!,
                                  decision: "approved",
                                  roomId: areaRoomId,
                                },
                              }));
                            }}
                          >
                            {t("acousticInputsVisualApproveArea")}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={disabled || !candidate.floorAreaObservationKey}
                            onClick={() => {
                              if (!candidate.floorAreaObservationKey) return;
                              setEditingBase(base);
                              setSaved(false);
                              setVisualAreaReviews((current) => ({
                                ...current,
                                [candidate.candidateKey]: {
                                  candidateKey: candidate.candidateKey,
                                  observationKey: candidate.floorAreaObservationKey!,
                                  decision: "rejected",
                                },
                              }));
                            }}
                          >
                            {t("acousticInputsVisualRejectArea")}
                          </Button>
                        </div>
                      )}
                    </section>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {rooms.length > 0 && (
        <>
          <div className="flex flex-wrap items-end gap-2">
            {rooms.length > 1 && (
              <Field label={t("acousticInputsRoom")}>
                <NativeSelect
                  aria-label={t("acousticInputsRoom")}
                  value={selected}
                  onChange={(e) => setRoom(e.target.value)}
                >
                  {rooms.map((id) => (
                    <option key={id} value={id}>
                      {id} ·{" "}
                      {
                        base.fields.filter(
                          (f) => f.roomId === id && f.value === null,
                        ).length
                      }{" "}
                      {t("acousticInputsOpen")}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShowAll(!showAll)}
            >
              {t(showAll ? "acousticInputsOnlyOpen" : "acousticInputsAll")}
            </Button>
          </div>
          <div className="space-y-6">
            {visible.map((f, index) => {
              const candidates = [
                ...new Map(
                  f.candidates.map((c) => [JSON.stringify(c.value), c]),
                ).values(),
              ];
              const value =
                edits[f.key] ?? (f.value === null ? "" : String(f.value));
              return (
                <fieldset key={f.key} className="min-w-0 space-y-3">
                  <legend className="mb-3 flex items-center gap-3 font-medium">
                    <span
                      className="flex h-control-sm w-control-number shrink-0 items-center justify-center rounded-full bg-muted text-ui-sm"
                      aria-hidden="true"
                    >
                      {index + 1}
                    </span>
                    {question(f)}
                  </legend>
                  {f.status === "conflict" && (
                    <>
                      <p className="text-ui-sm text-muted-foreground">
                        {t("acousticInputsConflictHint")}
                      </p>
                      <ToggleGroup
                        type="single"
                        className="acoustic-input-choices"
                        disabled={disabled}
                        aria-label={question(f)}
                        value={
                          custom[f.key]
                            ? "custom"
                            : candidates.some((c) => String(c.value) === value)
                              ? `value:${value}`
                              : ""
                        }
                        onValueChange={(choice) => {
                          if (!choice) return;
                          setCustom((p) => ({
                            ...p,
                            [f.key]: choice === "custom",
                          }));
                          edit(
                            f.key,
                            choice === "custom" ? "" : choice.slice(6),
                          );
                        }}
                      >
                        {candidates.map((c) => (
                          <ToggleGroupItem
                            key={JSON.stringify(c.value)}
                            value={`value:${String(c.value)}`}
                          >
                            <span className="font-medium">
                              {typeof c.value === "string" ||
                              typeof c.value === "boolean"
                                ? label(String(c.value))
                                : c.value}{" "}
                              {unit(f.field)}
                            </span>
                            <span className="text-ui-xs text-muted-foreground">
                              {c.provenance.kind === "source"
                                ? `${t("acousticInputsSource")}${c.provenance.page ? ` · ${t("acousticInputsPage")} ${c.provenance.page}` : ""}`
                                : t("acousticInputsHumanValue")}
                            </span>
                          </ToggleGroupItem>
                        ))}
                        <ToggleGroupItem value="custom">
                          {t("acousticInputsCustom")}
                        </ToggleGroupItem>
                      </ToggleGroup>
                    </>
                  )}
                  {(f.status !== "conflict" || custom[f.key]) && (
                    <Field
                      label={
                        f.status === "conflict"
                          ? t("acousticInputsCustom")
                          : label(f.field)
                      }
                    >
                      {f.options || f.type === "boolean" ? (
                        <NativeSelect
                          aria-label={`${f.id} · ${label(f.field)}`}
                          disabled={disabled}
                          value={value}
                          onChange={(e) => edit(f.key, e.target.value)}
                        >
                          <option value="">{t("acousticInputsChoose")}</option>
                          {(f.options ?? ["true", "false"]).map((v) => (
                            <option key={v} value={v}>
                              {label(v)}
                            </option>
                          ))}
                        </NativeSelect>
                      ) : (
                        <Input
                          aria-label={`${f.id} · ${label(f.field)}`}
                          type={f.type === "number" ? "number" : "text"}
                          step="any"
                          disabled={disabled}
                          value={value}
                          placeholder={
                            unit(f.field) === "m²"
                              ? t("acousticInputsAreaPlaceholder")
                              : t("acousticInputsValuePlaceholder")
                          }
                          onChange={(e) => edit(f.key, e.target.value)}
                        />
                      )}
                    </Field>
                  )}
                  {f.candidates.length > 0 && (
                    <details className="acoustic-input-evidence">
                      <summary>
                        <FileText className="size-icon-sm" aria-hidden="true" />
                        {t("acousticInputsEvidence")}
                        <ChevronRight
                          className="ml-auto size-icon-sm"
                          aria-hidden="true"
                        />
                      </summary>
                      <ul className="space-y-3 px-3 pt-3">
                        {f.candidates.map((candidate, i) => (
                          <li key={i} className="text-ui-sm">
                            <div className="flex flex-wrap items-center gap-2">
                              <span>{String(candidate.value)}</span> ·{" "}
                              {source(candidate.provenance)}
                            </div>
                            {candidate.provenance.kind === "source" && (
                              <p className="break-words text-muted-foreground">
                                {candidate.provenance.excerpt}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </fieldset>
              );
            })}
          </div>
          <label className="flex items-start gap-3 text-ui-sm">
            <Checkbox
              checked={!!base.inventoryConfirmation || confirm}
              disabled={disabled || !!base.inventoryConfirmation}
              onCheckedChange={(v) => {
                setEditingBase(base);
                setSaved(false);
                setConfirm(v === true);
              }}
            />
            <span>{t("acousticInputsConfirm")}</span>
          </label>
          <details className="text-ui-sm text-muted-foreground">
            <summary className="cursor-pointer">
              {t("acousticInputsInventory")}
            </summary>
            <p className="py-2">{t("acousticInputsInventoryHint")}</p>
            <ul className="space-y-1 py-2">
              {inventory.map((entry, i) => (
                <li key={i}>
                  {entry.roomId} · {source(entry.provenance)}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      {base.blockers.length > 0 && (
        <details>
          <summary className="cursor-pointer">
            {t("acousticInputsBlockers")}
          </summary>
          <ul className="space-y-1 break-words text-ui-sm">
            {base.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </details>
      )}
      {base.sourceNotes.length > 0 && (
        <details>
          <summary className="cursor-pointer">
            {t("acousticInputsNotes")}
          </summary>
          <ul className="space-y-1 break-words text-ui-sm">
            {base.sourceNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}
      {(rooms.length > 0 || visualCandidates.length > 0) && (
        <Field label={t("acousticInputsReason")}>
          <Input
            value={reason}
            disabled={disabled}
            placeholder={t("acousticInputsReasonPlaceholder")}
            onChange={(event) => {
              setEditingBase(base);
              setSaved(false);
              setReason(event.target.value);
            }}
            maxLength={1000}
          />
        </Field>
      )}
      {write.isError && (
        <Callout tone="warning">
          {t("acousticInputsSaveError")}{" "}
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              void queryClient.invalidateQueries({ queryKey: [path] })
            }
          >
            {t("acousticInputsRefresh")}
          </Button>
        </Callout>
      )}
      {saved && (
        <p role="status" className="flex items-center gap-2 text-ui-sm">
          <Check className="size-icon-sm" aria-hidden="true" />
          {t("acousticInputsSaved")}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          className="acoustic-input-action"
          disabled={
            disabled ||
            !reason.trim() ||
            (
              !changes.length &&
              !confirm &&
              !pendingVisualMappings.length &&
              !pendingVisualAreaReviews.length
            )
          }
        >
          {t("acousticInputsSave")}
          <ArrowRight className="size-icon-sm" aria-hidden="true" />
        </Button>
        <span className="text-ui-xs text-muted-foreground">
          {t("acousticInputsBoundary")}
        </span>
      </div>
      {result && (
        <Link
          className="underline"
          to={`/projects/${projectId}?conversation=${conversationId}&panel=artifacts&artifact=${result.artifact.id}&revision=${result.revision.id}`}
        >
          {t("acousticInputsOpenSheet")}
        </Link>
      )}
    </form>
  );
}

type VisualCandidateImage = {
  candidateKey: string;
  provenance: VisualCandidate["provenance"];
  image: { mediaType: string; data: string };
};

function VisualCandidateImagePreview({
  basePath,
  candidate,
}: {
  basePath: string;
  candidate: VisualCandidate;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const path = `${basePath}/visual/${encodeURIComponent(candidate.candidateKey)}`;
  const query = useQuery({
    queryKey: [path],
    queryFn: () => api<VisualCandidateImage>(path),
    enabled: open,
    retry: false,
  });
  const preview = query.data;
  const sameCrop =
    JSON.stringify(preview?.provenance.crop ?? null) ===
    JSON.stringify(candidate.provenance.crop ?? null);
  const provenanceMatches =
    preview?.candidateKey === candidate.candidateKey &&
    preview.provenance.versionId === candidate.provenance.versionId &&
    preview.provenance.page === candidate.provenance.page &&
    preview.provenance.receiptId === candidate.provenance.receiptId &&
    preview.provenance.imageHash === candidate.provenance.imageHash &&
    sameCrop;
  const imageMatches =
    provenanceMatches && preview?.image.mediaType === "image/jpeg";
  const imageSrc =
    imageMatches && preview
      ? `data:${preview.image.mediaType};base64,${preview.image.data}`
      : null;
  const crop = candidate.provenance.crop;
  const cropLabel = crop
    ? `${t("acousticInputsVisualCrop")}: ${[crop.x, crop.y, crop.width, crop.height]
        .map((value) => `${Math.round(value * 100)}%`)
        .join(" · ")}`
    : t("acousticInputsVisualFullPage");

  return (
    <>
      <Button
        type="button"
        variant="link"
        className="h-auto px-0"
        onClick={() => setOpen(true)}
      >
        <Eye className="size-icon-sm" aria-hidden="true" />
        {t("acousticInputsVisualViewImage")}
      </Button>
      {open && (
        <Modal
          wide
          title={t("acousticInputsVisualImageTitle")}
          onClose={() => setOpen(false)}
        >
          <div className="space-y-3">
            <p className="text-ui-sm text-muted-foreground">
              {t("acousticInputsVisualSourceVersion")}: {candidate.provenance.versionId} · {t("acousticInputsPage")} {candidate.provenance.page} · {cropLabel}
            </p>
            {query.isPending && <p role="status">{t("loading")}</p>}
            {query.isError && (
              <Callout tone="error">
                {query.error instanceof ApiError && query.error.status === 403
                  ? t("acousticInputsVisualImageForbidden")
                  : t("acousticInputsVisualImageUnavailable")}
                <Button variant="link" onClick={() => void query.refetch()}>
                  {t("retry")}
                </Button>
              </Callout>
            )}
            {!query.isError && preview && !imageMatches && (
              <Callout tone="error">{t("acousticInputsVisualImageMismatch")}</Callout>
            )}
            {imageSrc && (
              <img
                src={imageSrc}
                alt={`${t("acousticInputsVisualImageTitle")} · ${t("acousticInputsPage")} ${candidate.provenance.page}`}
                className="mx-auto max-h-[70vh] max-w-full rounded-md border object-contain"
              />
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
