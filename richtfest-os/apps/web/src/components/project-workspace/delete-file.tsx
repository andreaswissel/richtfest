import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, type RecordData } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Callout } from "../ui/primitives";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";

export function DeleteFile({
  projectId,
  fileId,
  name,
  onDeleted,
}: {
  projectId: string;
  fileId: string;
  name: string;
  onDeleted?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const session = useApi("/auth/me");
  const canDelete = (
    session.data?.permissions ||
    session.data?.user?.permissions ||
    []
  ).includes("projects:write");
  const remove = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/files/${fileId}`, undefined, "DELETE"),
    onSuccess: async () => {
      setOpen(false);
      onDeleted?.();
      const projectPath = `/projects/${projectId}`;
      const filesPath = `${projectPath}/files`;
      const lists = {
        predicate: (query: { queryKey: readonly unknown[] }) =>
          query.queryKey[0] === projectPath || query.queryKey[0] === filesPath,
      };
      await queryClient.cancelQueries(lists);
      queryClient.setQueryData<RecordData[]>([filesPath], (current) =>
        current?.filter((file) => file.id !== fileId),
      );
      queryClient.setQueryData<RecordData>([projectPath], (current) =>
        current
          ? {
              ...current,
              files: current.files?.filter(
                (file: RecordData) => file.id !== fileId,
              ),
            }
          : current,
      );
      // Mark detail caches stale without refetching the source that just disappeared.
      await queryClient.invalidateQueries({ refetchType: "none" });
      await queryClient.invalidateQueries(lists);
    },
  });
  if (!canDelete) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!remove.isPending) {
          setOpen(next);
          remove.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" aria-label={`${t("deleteFile")}: ${name}`}>
          {t("deleteFile")}
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={!remove.isPending}>
        <DialogHeader>
          <DialogTitle>{t("deleteFile")}</DialogTitle>
          <DialogDescription className="break-words">{name}</DialogDescription>
        </DialogHeader>
        <p className="text-ui-sm">{t("deleteFileWarning")}</p>
        {remove.error && <Callout tone="error">{remove.error.message}</Callout>}
        <DialogFooter>
          <Button
            variant="outline"
            autoFocus
            disabled={remove.isPending}
            onClick={() => setOpen(false)}
          >
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? t("deletingFile") : t("deleteFile")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
