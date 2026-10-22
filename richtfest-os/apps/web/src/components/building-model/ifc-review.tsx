import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { buildingEvidenceSchema, componentTypeSchema, doorRoleSchema, spaceTypeSchema, wallRoleSchema, type IfcBuildingPreview } from "@richtfest/shared";
import { api, list, type RecordData } from "../../api";
import { useApi } from "../../query";
import { useT } from "../../i18n";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Badge, Callout, Field } from "../ui/primitives";
import { fieldLabel, optionLabel } from "./component-properties";

const choices: Record<string, readonly string[]> = {
  spaceType: spaceTypeSchema.options, componentType: componentTypeSchema.options,
  wallRole: wallRoleSchema.options, doorRole: doorRoleSchema.options, isExternal: ["true", "false"],
};

/** Manual values and warning notes use the same versioned review contract as PDF model properties. */
export function IfcReview({ projectId, model, files, building, object, warnings }: {
  projectId: string; model: RecordData; files: RecordData[]; building: RecordData;
  object?: { id?: string; entityType: string; ifcType: string; expressId: number; name: string };
  warnings: IfcBuildingPreview["warnings"];
}) {
  const t = useT();
  const fields = object?.entityType === "room" ? ["apartmentUnit", "spaceType"] : object ? ["componentType",
    ...(/^IFCWALL/.test(object.ifcType) ? ["wallRole"] : []), ...(object.ifcType === "IFCDOOR" ? ["isExternal", "doorRole"] : [])] : [];
  const [target, setTarget] = useState(fields[0] || (warnings[0] ? `ifcReview.${warnings[0].code}` : ""));
  const warning = warnings.find(w => `ifcReview.${w.code}` === target);
  const entityId = warning ? building.id : object?.id;
  const entityType = warning ? "building" : object?.entityType;
  const property = list(model.properties).find(p => p.entityId === entityId && p.entityType === entityType && p.propertyKey === target);
  const label = (key: string) => key === "isExternal" ? t("ifcReviewExternal") : fieldLabel(key, t);
  const unnoted = warnings.filter(w => !list(model.properties).some(p => p.entityId === building.id && p.propertyKey === `ifcReview.${w.code}` && p.current?.reviewStatus === "approved")).length;
  return <Section title={t("ifcReviewTitle")}>
    <Callout>{t("ifcReviewScope")}</Callout>
    <p className="my-3 text-ui-sm">{t("ifcReviewOutstanding").replace("{count}", String(unnoted))}</p>
    {!fields.length && <p className="mb-3 text-ui-sm text-muted-foreground">{t("ifcReviewSelectObject")}</p>}
    {target && entityId && entityType && <>
      <Field label={t("ifcReviewTarget")}><NativeSelect className="w-full min-w-0 max-w-full" value={target} onChange={event => setTarget(event.target.value)}>
        {fields.length > 0 && <optgroup label={object!.name}>{fields.map(key => <option key={key} value={key}>{label(key)}</option>)}</optgroup>}
        {warnings.length > 0 && <optgroup label={t("ifcBuildingWarnings")}>{warnings.map(w => <option key={w.code} value={`ifcReview.${w.code}`}>{t(`ifcReviewWarning_${w.code}`)}</option>)}</optgroup>}
      </NativeSelect></Field>
      {warning && <p className="mt-2 text-ui-sm">{t(`ifcWarning_${warning.code}`)} ({warning.count}){warning.detail ? ` · ${warning.detail}` : ""}</p>}
      <IfcReviewEditor key={`${entityId}:${target}`}
        projectId={projectId} model={model} files={files} entityId={entityId} entityType={entityType} propertyKey={target}
        property={property} label={warning ? t("ifcReviewNote") : label(target)} />
    </>}
  </Section>;
}

function IfcReviewEditor({ projectId, model, files, entityId, entityType, propertyKey, property, label }: {
  projectId: string; model: RecordData; files: RecordData[]; entityId: string; entityType: string;
  propertyKey: string; property?: RecordData; label: string;
}) {
  const t = useT(), client = useQueryClient();
  const current = property?.current, approved = property?.reviewed;
  const [value, setValue] = useState(current?.value == null ? "" : String(current.value));
  const [fileId, setFileId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [locator, setLocator] = useState("");
  const [attribute, setAttribute] = useState("");
  const [quote, setQuote] = useState("");
  const [note, setNote] = useState("");
  // A decision note belongs to the exact version shown, never a newly arrived proposal.
  useEffect(() => setNote(""), [current?.version, current?.reviewRevision]);
  const versions = useApi(`/projects/${projectId}/files/${fileId}/versions`, !!fileId);
  const ready = list(versions.data).filter(v => v.status === "ready");
  const version = ready.find(v => v.id === versionId);
  const isPdf = version?.mimeType === "application/pdf";
  const evidence = buildingEvidenceSchema.safeParse(isPdf
    ? { kind: "page", sourceVersionId: versionId, page: Number(locator), quote: quote.trim() }
    : { kind: "ifc", sourceVersionId: versionId, expressId: Number(locator), attribute: attribute.trim() });
  const refresh = () => client.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] });
  const write = useMutation({
    mutationFn: async (decision: "save" | "approved" | "rejected") => {
      const base = `/projects/${projectId}/building-model/properties`;
      if (decision === "save") {
        if (!evidence.success || !version) throw new Error(t("ifcReviewEvidenceRequired"));
        return api(base, { baseRevision: model.model.revision, entityType, entityId, propertyKey,
          value: propertyKey === "isExternal" ? value === "true" : value.trim(), provenance: "manual", evidence: [evidence.data] });
      }
      return api(`${base}/${property!.id}/versions/${current.version}/review`, {
        baseRevision: model.model.revision, reviewRevision: current.reviewRevision, decision, note: note.trim(),
      });
    },
    onSuccess: async () => { await refresh(); setFileId(""); setVersionId(""); setAttribute(""); setQuote(""); },
  });
  const display = (raw: unknown) => raw == null ? t("buildingModelUnknownValue") : choices[propertyKey]
    ? propertyKey === "isExternal" ? t(raw === true ? "ifcReviewExternalYes" : "ifcReviewExternalNo") : optionLabel(propertyKey, String(raw), t) : String(raw);
  const status = current?.reviewStatus === "approved" ? "buildingComponentReviewed" : current?.reviewStatus === "rejected" ? "buildingComponentRejected" : "buildingComponentUnreviewed";
  const canSave = value.trim() && evidence.success && version && (isPdf ? quote.trim() : attribute.trim());
  return <div className="mt-3 flex flex-col gap-stack">
    <dl className="grid gap-stack text-ui-sm sm:grid-cols-[max-content_1fr]">
      <dt>{t("ifcReviewConfirmed")}</dt><dd className="whitespace-pre-wrap break-words">{display(approved?.value)}</dd>
      {current && <><dt>{t("ifcReviewLatest")}</dt><dd className="whitespace-pre-wrap break-words">{display(current.value)} <Badge>{t(status)}</Badge></dd></>}
    </dl>
    {current && <div className="rounded-md border p-3 text-ui-sm">
      <p>{t("ifcReviewEvidence")}</p>
      <ul className="mt-1 break-words">{list(current.evidence).map((item, i) => <li key={i}>
        {item.sourceVersionId && <Link to={`/projects/${projectId}?sourceVersion=${item.sourceVersionId}`}>{item.sourceVersionId}</Link>} · {item.kind === "ifc" ? `#${item.expressId} · ${item.attribute}` : item.kind === "page" ? `${t("buildingModelPage")} ${item.page} · ${item.quote || ""}` : `${item.inquiryId} · ${item.entryId}`}
      </li>)}</ul>
      {current.reviewNote && <p className="mt-2 whitespace-pre-wrap">{current.reviewNote}</p>}
      {current.reviewStatus !== "approved" && current.reviewStatus !== "rejected" && <fieldset disabled={write.isPending} className="mt-3 flex flex-col gap-stack">
        <Field label={t("ifcReviewDecisionNote")}><Textarea value={note} onChange={e => setNote(e.target.value)} maxLength={2000} /></Field>
        <div className="flex gap-stack"><Button variant="outline" disabled={!note.trim()} onClick={() => write.mutate("approved")}>{t("buildingComponentApprove")}</Button>
          <Button variant="outline" disabled={!note.trim()} onClick={() => write.mutate("rejected")}>{t("buildingComponentReject")}</Button></div>
      </fieldset>}
    </div>}
    <form onSubmit={event => { event.preventDefault(); if (canSave && !write.isPending) write.mutate("save"); }}>
      <fieldset disabled={write.isPending} className="flex flex-col gap-stack">
        <Field label={label}>{choices[propertyKey]
          ? <NativeSelect required value={value} onChange={e => setValue(e.target.value)}><option value="">{t("buildingModelUnknownValue")}</option>{choices[propertyKey].map(option => <option value={option} key={option}>{display(propertyKey === "isExternal" ? option === "true" : option)}</option>)}</NativeSelect>
          : propertyKey.startsWith("ifcReview.") ? <Textarea required value={value} onChange={e => setValue(e.target.value)} maxLength={2000} rows={3} />
          : <Input required value={value} onChange={e => setValue(e.target.value)} maxLength={80} />}</Field>
        <div className="grid gap-stack sm:grid-cols-2">
          <Field label={t("ifcReviewEvidenceFile")}><NativeSelect className="w-full min-w-0 max-w-full" required value={fileId} onChange={e => { setFileId(e.target.value); setVersionId(""); }}><option value="">{t("ifcBuildingChoose")}</option>
            {files.filter(f => /\.(pdf|ifc)$/i.test(f.name || "") || ["application/pdf", "application/x-step", "application/ifc", "application/x-ifc"].includes(f.mimeType)).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</NativeSelect></Field>
          <Field label={t("buildingModelVersion")}><NativeSelect required disabled={!fileId} value={versionId} onChange={e => { setVersionId(e.target.value); setLocator(""); setAttribute(""); setQuote(""); }}><option value="">{t("buildingModelChooseRevision")}</option>{ready.map(v => <option key={v.id} value={v.id}>{v.version}</option>)}</NativeSelect></Field>
          <Field label={isPdf ? t("buildingModelPage") : t("ifcReviewExpressId")}><Input required type="number" min={1} step={1} value={locator} onChange={e => setLocator(e.target.value)} /></Field>
          {isPdf ? <Field label={t("ifcReviewQuote")}><Textarea required value={quote} onChange={e => setQuote(e.target.value)} maxLength={4000} /></Field>
            : <Field label={t("ifcReviewAttribute")}><Input required value={attribute} onChange={e => setAttribute(e.target.value)} maxLength={200} /></Field>}
        </div>
        <div><Button type="submit" disabled={!canSave || write.isPending}>{t("ifcReviewSave")}</Button></div>
      </fieldset>
    </form>
    {(write.error || versions.error) && <Callout tone="error">{(write.error || versions.error)?.message}
      <Button variant="outline" onClick={async () => { await refresh(); setValue(""); setNote(""); setFileId(""); setVersionId(""); write.reset(); }}>{t("ifcReviewReload")}</Button>
    </Callout>}
  </div>;
}
