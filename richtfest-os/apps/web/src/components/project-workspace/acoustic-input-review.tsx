import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ExteriorNoiseFact, AcousticDataset } from "@richtfest/shared";
import { useApi, useWrite, queryClient } from "../../query";
import { useT } from "../../i18n";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { NativeSelect } from "../ui/native-select";
import { Callout, Field } from "../ui/primitives";
import { ArrowRight, Check, ChevronRight, FileText } from "lucide-react";
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
type Review = {
  revisionId: string;
  input: AcousticDataset["receipt"]["input"] | null;
  fields: ReviewField[];
  blockers: string[];
  sourceNotes: string[];
  inventoryEvidence: {
    roomId: string;
    provenance: ExteriorNoiseFact["provenance"];
  }[];
  inventoryConfirmation: { at: string } | null;
};

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
    setReason("");
    setSaved(true);
    if (next.calculation) setResult(next.calculation);
  });
  const stale = base.revisionId !== data.revisionId;
  const rooms = [...new Set(base.inventoryEvidence.map((r) => r.roomId))];
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
  const ready = !!base.input?.rooms.length && !changes.length;
  const submit = (action: "save" | "calculate") => {
    setSaved(false);
    write.mutate({
      expectedRevisionId: base.revisionId,
      action,
      reason,
      changes,
      confirmInventory: confirm,
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
        if (ready && (base.inventoryConfirmation || confirm))
          submit("calculate");
        else if (changes.length || confirm) submit("save");
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
          <Field label={t("acousticInputsReason")}>
            <Input
              value={reason}
              disabled={disabled}
              placeholder={t("acousticInputsReasonPlaceholder")}
              onChange={(e) => {
                setEditingBase(base);
                setSaved(false);
                setReason(e.target.value);
              }}
              maxLength={1000}
            />
          </Field>
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
              {base.inventoryEvidence.map((entry, i) => (
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
        {!ready && (
          <Button
            type="submit"
            className="acoustic-input-action"
            disabled={
              disabled || !reason.trim() || (!changes.length && !confirm)
            }
          >
            {t("acousticInputsSave")}
            <ArrowRight className="size-icon-sm" aria-hidden="true" />
          </Button>
        )}
        {ready && (
          <Button
            type="submit"
            className="acoustic-input-action"
            disabled={
              disabled ||
              !reason.trim() ||
              !!changes.length ||
              !(base.inventoryConfirmation || confirm)
            }
          >
            {t(base.blockers.length ? "acousticInputsCalculatePartial" : "acousticInputsCalculate")}
            <ArrowRight className="size-icon-sm" aria-hidden="true" />
          </Button>
        )}
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
