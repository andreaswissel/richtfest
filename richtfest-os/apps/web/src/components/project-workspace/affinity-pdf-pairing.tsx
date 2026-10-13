import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api, list, type RecordData } from "../../api";
import { useApi, queryClient } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { NativeSelect } from "../ui/native-select";
import { Badge, Callout, Field } from "../ui/primitives";

export function AffinityPdfPairing({
  projectId,
  version,
}: {
  projectId: string;
  version: RecordData;
}) {
  const t = useT();
  const [params] = useSearchParams();
  const session = useApi("/auth/me");
  const canWrite = (
    session.data?.permissions ||
    session.data?.user?.permissions ||
    []
  ).includes("projects:write");
  const [editing, setEditing] = useState(false);
  const [fileId, setFileId] = useState("");
  const [pdfVersionId, setPdfVersionId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const files = useApi(`/projects/${projectId}/files`, editing && canWrite);
  const versions = useApi(
    `/projects/${projectId}/files/${fileId}/versions`,
    editing && canWrite && !!fileId,
  );
  const pairing = version.pdfRepresentation;
  const currentId = pairing?.pdf.versionId || null;
  const write = useMutation({
    mutationFn: (unlink: boolean) =>
      api(
        `/projects/${projectId}/source-versions/${version.id}/pdf-representation`,
        unlink
          ? { expectedPdfVersionId: currentId }
          : { pdfVersionId, expectedPdfVersionId: currentId, confirmed: true },
        unlink ? "DELETE" : "PUT",
      ),
    onSuccess: async () => {
      setEditing(false);
      setConfirmed(false);
      setPdfVersionId("");
      await queryClient.invalidateQueries();
    },
    onError: () => {
      void queryClient.invalidateQueries();
      setConfirmed(false);
    },
  });
  const pdfTarget = new URLSearchParams(params);
  if (pairing) {
    pdfTarget.set("file", pairing.pdf.fileId);
    pdfTarget.set("sourceVersion", pairing.pdf.versionId);
    pdfTarget.delete("page");
    pdfTarget.delete("artifact");
    pdfTarget.delete("revision");
  }
  const readyPdfs = list(versions.data).filter(
    (v) => v.status === "ready" && v.mimeType === "application/pdf",
  );
  return (
    <section
      className="flex min-w-0 flex-col gap-stack text-ui-sm [&_.field]:min-w-0"
      aria-label={t("affinityPdfRepresentation")}
    >
      <div className="flex flex-wrap items-center gap-stack">
        <Badge>{t(pairing ? "affinityPdfLinked" : "affinityPdfNeeded")}</Badge>
        {pairing && (
          <Link className="min-w-0 [overflow-wrap:anywhere]" to={`?${pdfTarget}`}>
            {pairing.pdf.fileName} · {t("version")} {pairing.pdf.version}
          </Link>
        )}
        {canWrite && (
          <Button
            variant="outline"
            disabled={write.isPending}
            onClick={() => {
              setEditing(!editing);
              setConfirmed(false);
              write.reset();
            }}
          >
            {t(pairing ? "affinityChangePdf" : "affinityLinkPdf")}
          </Button>
        )}
      </div>
      {editing && canWrite && (
        <>
          <Field label={t("affinityPdfFile")}>
            <NativeSelect
              className="min-w-0 max-w-full"
              value={fileId}
              disabled={write.isPending}
              onChange={(e) => {
                setFileId(e.target.value);
                setPdfVersionId("");
                setConfirmed(false);
              }}
            >
              <option value="">{t("chooseSource")}</option>
              {list(files.data, "files")
                .filter((f) => f.mimeType === "application/pdf")
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </NativeSelect>
          </Field>
          {fileId && (
            <Field label={t("version")}>
              <NativeSelect
                className="min-w-0 max-w-full"
                value={pdfVersionId}
                disabled={write.isPending}
                onChange={(e) => {
                  setPdfVersionId(e.target.value);
                  setConfirmed(false);
                }}
              >
                <option value="">{t("workspaceChooseRevision")}</option>
                {readyPdfs.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.version} · {v.mimeType}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          {fileId && versions.data && !readyPdfs.length && (
            <Callout>{t("affinityNoReadyPdf")}</Callout>
          )}
          <Link to={`/projects/${projectId}?view=sources`}>
            {t("affinityUploadPdfSources")}
          </Link>
          <label className="flex items-start gap-stack">
            <Checkbox
              checked={confirmed}
              disabled={!pdfVersionId || write.isPending}
              onCheckedChange={(value) => setConfirmed(value === true)}
            />
            <span>
              {t("affinityConfirmExport")} · {t("version")} {version.version}
            </span>
          </label>
          <div className="flex flex-wrap gap-stack">
            <Button
              disabled={
                write.isPending ||
                !confirmed ||
                !readyPdfs.some((v) => v.id === pdfVersionId) ||
                pdfVersionId === currentId
              }
              onClick={() => write.mutate(false)}
            >
              {t("affinityLinkPdf")}
            </Button>
            {pairing && (
              <Button
                variant="outline"
                disabled={write.isPending}
                onClick={() => write.mutate(true)}
              >
                {t("affinityUnlinkPdf")}
              </Button>
            )}
          </div>
          {(files.error || versions.error) && (
            <Callout tone="error">
              {(files.error || versions.error)?.message}
            </Callout>
          )}
        </>
      )}
      {write.error && <Callout tone="error">{write.error.message}</Callout>}
    </section>
  );
}
