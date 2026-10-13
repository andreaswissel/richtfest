import { useState } from "react";
import { list } from "../api";
import { useApi } from "../query";
import { useT } from "../i18n";
import { NativeSelect } from "./ui/native-select";
import { Callout, Field } from "./ui/primitives";

/** Mount only on explicit picker opening, never on navigation or mode changes. */
export function AgentSourcePicker({
  projectId,
  onSelect,
}: {
  projectId: string;
  onSelect: (source: { id: string; label: string }) => void;
}) {
  const t = useT();
  const [fileId, setFileId] = useState("");
  const files = useApi(`/projects/${projectId}/files`);
  const evidenceFiles = list(files.data, "files").filter(
    (file) =>
      file.purpose !== "reference_report" && file.purpose !== "comparison_only",
  );
  const evidenceFilesById = new Map(
    evidenceFiles.map((file) => [file.id, file]),
  );
  const selectedFile = evidenceFilesById.get(fileId);
  const versions = useApi(
    `/projects/${projectId}/files/${fileId}/versions`,
    !!selectedFile,
  );
  return (
    <div className="flex flex-wrap gap-stack">
      <Field label={t("source")}>
        <NativeSelect
          value={fileId}
          onChange={(e) => setFileId(e.target.value)}
        >
          <option value="">{t("chooseSource")}</option>
          {evidenceFiles.map((file) => (
            <option key={file.id} value={file.id}>
              {file.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {selectedFile && (
        <Field label={t("version")}>
          <NativeSelect
            value=""
            onChange={(e) => {
              if (e.target.value.startsWith("pdf:")) {
                const original = list(versions.data).find(
                  (v) => `pdf:${v.id}` === e.target.value,
                );
                const pdf = original?.pdfRepresentation?.pdf;
                if (pdf && evidenceFilesById.has(pdf.fileId))
                  onSelect({
                    id: pdf.versionId,
                    label: `${pdf.fileName} · ${pdf.version}`,
                  });
                return;
              }
              const version = list(versions.data).find(
                (v) => v.id === e.target.value,
              );
              if (version)
                onSelect({
                  id: version.id,
                  label: `${selectedFile.name} · ${version.version}`,
                });
            }}
          >
            <option value="">{t("addSourceVersion")}</option>
            {list(versions.data).map((v) => (
              <option key={v.id} value={v.id}>
                {v.version}
              </option>
            ))}
            {list(versions.data)
              .filter(
                (v) =>
                  v.pdfRepresentation &&
                  evidenceFilesById.has(v.pdfRepresentation.pdf.fileId) &&
                  /\.afpub$/i.test(selectedFile.name || ""),
              )
              .map((v) => (
                <option key={`pdf:${v.id}`} value={`pdf:${v.id}`}>
                  {t("affinityAddPdfEvidence")} ·{" "}
                  {v.pdfRepresentation.pdf.fileName} · {t("version")}{" "}
                  {v.pdfRepresentation.pdf.version} (
                  {t("affinityOriginalRevision")} {v.version})
                </option>
              ))}
          </NativeSelect>
        </Field>
      )}
      {(files.error || versions.error) && (
        <Callout tone="error">
          {(files.error || versions.error)?.message}
        </Callout>
      )}
    </div>
  );
}
