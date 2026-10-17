import { useMutation } from "@tanstack/react-query";
import type { DocumentType, DocumentTypeState } from "@richtfest/shared";
import { api } from "../api";
import { queryClient } from "../query";
import { useT } from "../i18n";
import { Button } from "./ui/button";
import { NativeSelect } from "./ui/native-select";
import { Badge } from "./ui/primitives";
import { documentTypeLabel, documentTypes } from "./inquiries/labels";

/** A source's document type: Richtfest's suggestion until a person confirms or changes it. */
export function DocumentTypeCell({ projectId, fileId, fileName, state }: { projectId: string; fileId: string; fileName: string; state?: DocumentTypeState }) {
  const t = useT();
  const save = useMutation({
    mutationFn: (documentType: DocumentType | null) => api(`/projects/${projectId}/files/${fileId}/document-type`, { documentType }, "PUT"),
    onSuccess: () => queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).startsWith(`/projects/${projectId}/`) }),
  });
  const value = state?.documentType ?? null;
  const suggested = state?.provenance === "inferred" && value;
  return <div className="inline-actions flex-nowrap">
    <NativeSelect size="sm" className="min-w-44 shrink-0" aria-label={`${t("documentType")}: ${fileName}`} value={value ?? "_none"} disabled={save.isPending} title={suggested ? state?.reason ?? undefined : undefined}
      onChange={(event) => save.mutate(event.target.value === "_none" ? null : event.target.value as DocumentType)}>
      <option value="_none">{t("documentTypeUnknown")}</option>
      {documentTypes.map((type) => <option key={type} value={type}>{documentTypeLabel(type, t)}</option>)}
    </NativeSelect>
    {suggested && <>
      <Badge variant="outline" title={state?.reason ?? undefined}>{t("documentTypeSuggested")}</Badge>
      <Button size="xs" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(value)}>{t("documentTypeConfirm")}</Button>
    </>}
  </div>;
}
