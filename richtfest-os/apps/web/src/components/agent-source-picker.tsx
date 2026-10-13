import { useState } from "react";
import { list } from "../api";
import { useApi } from "../query";
import { useT } from "../i18n";
import { NativeSelect } from "./ui/native-select";
import { Callout, Field } from "./ui/primitives";

/** Mount only on explicit picker opening or report use, never on navigation. */
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
  const versions = useApi(
    `/projects/${projectId}/files/${fileId}/versions`,
    !!fileId,
  );
  return (
    <div className="flex flex-wrap gap-stack">
      <Field label={t("source")}>
        <NativeSelect
          value={fileId}
          onChange={(e) => setFileId(e.target.value)}
        >
          <option value="">{t("chooseSource")}</option>
          {list(files.data, "files").map((file) => (
            <option key={file.id} value={file.id}>
              {file.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {fileId && (
        <Field label={t("version")}>
          <NativeSelect
            value=""
            onChange={(e) => {
              const version = list(versions.data).find(
                (v) => v.id === e.target.value,
              );
              const file = list(files.data, "files").find(
                (f) => f.id === fileId,
              );
              if (version)
                onSelect({
                  id: version.id,
                  label: `${file?.name} · ${version.version}`,
                });
            }}
          >
            <option value="">{t("addSourceVersion")}</option>
            {list(versions.data).map((v) => (
              <option key={v.id} value={v.id}>
                {v.version}
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
