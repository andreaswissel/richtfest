import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import type {
  LocationState,
  ProjectAddress,
  PublicReleaseStatusResponse,
} from "@richtfest/shared";
import { locationMatchesAddress } from "@richtfest/shared";
import { api, ApiError } from "../../api";
import { queryClient } from "../../query";
import { useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Button } from "../ui/button";
import { Badge, Callout, Table } from "../ui/primitives";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";

export function PublicDataStatus({
  projectId,
  state,
  address,
}: {
  projectId: string;
  state: LocationState;
  address: ProjectAddress;
}) {
  const t = useT();
  const language = usePreferences((s) => s.language);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ids = state.context!.publicReleases!.map((pin) => pin.releaseId).sort();
  const path = `/projects/${projectId}/location`;
  const statusPath = `/public-data/release-status?ids=${ids.join(",")}`;
  const status = useQuery({
    queryKey: [statusPath],
    queryFn: () => api<PublicReleaseStatusResponse>(statusPath),
    enabled: open,
    staleTime: 0,
    gcTime: 60_000,
    refetchInterval: open ? 30_000 : false,
    retry: (count, error) =>
      !(error instanceof ApiError && [403, 503].includes(error.status)) &&
      count < 1,
    meta: { persist: false },
  });
  const refresh = useMutation({
    mutationFn: () =>
      api<LocationState>(`${path}/import`, {
        revision: state.revision,
        refresh: true,
      }),
    onSuccess(data) {
      queryClient.setQueryData([path], data);
      void queryClient.invalidateQueries({ queryKey: [path], exact: true });
      setConfirm(false);
    },
  });
  const date = (value: string | null) => {
    const parsed = value ? new Date(value) : null;
    return parsed && !Number.isNaN(parsed.getTime())
      ? parsed.toLocaleString(language, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : t("locationUnknown");
  };
  const rows = status.data?.items ?? [];
  const complete = rows.length === ids.length;
  const updated = rows.some(
    (row) =>
      row.partition.currentReleaseId &&
      row.partition.currentReleaseId !== row.releaseId,
  );
  const working =
    refresh.isPending ||
    ["queued", "running"].includes(state.contextJob.status);
  const canRefresh =
    status.data?.canRefreshProjectContext &&
    locationMatchesAddress(state.context!, address) &&
    !["queued", "running"].includes(state.lidarJob.status) &&
    complete &&
    rows.every((row) => row.partition.currentReleaseId) &&
    (updated || state.contextJob.status === "failed") &&
    !working &&
    !status.isFetching &&
    !status.isError;
  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        setOpen(open);
        if (!open) {
          setConfirm(false);
          refresh.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          {t("publicDataStatus")}
          {!!state.availableContextUpdates?.length && (
            <Badge>{state.availableContextUpdates.length}</Badge>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="public-data-status sm:max-w-4xl max-h-[90dvh] overflow-auto p-page text-ui gap-stack"
        showCloseButton={false}
        aria-describedby={undefined}
      >
        <div className="flex items-center justify-between gap-stack">
          <DialogTitle className="text-ui-lg">
            {t("publicDataStatus")}
          </DialogTitle>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" aria-label={t("close")}>
              <X className="size-icon" />
            </Button>
          </DialogClose>
        </div>
        <div className="grid gap-stack text-ui-sm">
          <Callout>{t("publicDataUnreviewed")}</Callout>
          {status.isPending && <p role="status">{t("loading")}</p>}
          {status.isError && (
            <Callout tone="error">
              {t(
                status.error instanceof ApiError && status.error.status === 503
                  ? "publicDataDisabled"
                  : "publicDataStatusFailed",
              )}
            </Callout>
          )}
          {!status.isError && status.data && (
            <>
              {!complete && (
                <Callout tone="error">{t("publicDataMissing")}</Callout>
              )}
              <Table
                headers={[
                  t("publicDataSource"),
                  t("publicDataPinned"),
                  t("publicDataRetrieval"),
                ]}
                rows={rows.map((row) => ({
                  id: row.releaseId,
                  sort: [
                    row.label,
                    String(row.featureCount),
                    row.partition.lastSuccessAt ?? "",
                  ],
                  cells: [
                    <div className="grid gap-stack min-w-0 max-w-xs whitespace-normal">
                      <a
                        href={row.metadata.metadataUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        {row.label}
                      </a>
                      <details>
                        <summary className="cursor-pointer">
                          {t("locationSources")}
                        </summary>
                        <dl className="grid gap-stack mt-2 text-ui-xs break-words">
                          <div>
                            <dt className="muted">
                              {t("publicDataPublisher")}
                            </dt>
                            <dd>{row.metadata.publisher}</dd>
                          </div>
                          <div>
                            <dt className="muted">{t("publicDataLicence")}</dt>
                            <dd>
                              <a
                                href={row.metadata.licenceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="underline"
                              >
                                {row.metadata.licence}
                              </a>
                            </dd>
                          </div>
                          <div>
                            <dt className="muted">
                              {t("publicDataSourceDate")}
                            </dt>
                            <dd>
                              {row.metadata.sourceUpdatedAt ??
                                t("locationUnknown")}
                            </dd>
                          </div>
                          <div>
                            <dt className="muted">{t("publicDataSurveyed")}</dt>
                            <dd>
                              {row.metadata.surveyedAt ?? t("locationUnknown")}
                            </dd>
                          </div>
                          <div>
                            <dt className="muted">{t("publicDataCoverage")}</dt>
                            <dd>{row.metadata.coverageNote}</dd>
                          </div>
                          <div>
                            <dt className="muted">
                              {t("publicDataRetrieved")}
                            </dt>
                            <dd>{date(row.retrievedAt)}</dd>
                          </div>
                          <div>
                            <dt className="muted">
                              {t("publicDataPublished")}
                            </dt>
                            <dd>{date(row.publishedAt)}</dd>
                          </div>
                          <div>
                            <dt className="muted">
                              {t("publicDataReleaseId")}
                            </dt>
                            <dd className="break-all font-mono">
                              {row.releaseId}
                            </dd>
                          </div>
                          <div>
                            <dt className="muted">SHA-256</dt>
                            <dd className="break-all font-mono">
                              {row.checksum}
                            </dd>
                          </div>
                          <div>
                            <dd>
                              <a
                                href={row.sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="underline"
                              >
                                {t("publicDataLiveSource")}
                              </a>
                            </dd>
                          </div>
                        </dl>
                      </details>
                    </div>,
                    <div className="grid gap-stack whitespace-normal">
                      <span className="sm:hidden muted text-ui-xs">
                        {t("publicDataPinned")}
                      </span>
                      <span>
                        {row.featureCount} {t("publicDataRecords")}
                      </span>
                      <Badge>
                        {t(
                          row.partition.currentReleaseId === row.releaseId
                            ? "publicDataLatest"
                            : "publicDataUpdate",
                        )}
                      </Badge>
                    </div>,
                    <div className="grid gap-stack whitespace-normal">
                      <span className="sm:hidden muted text-ui-xs">
                        {t("publicDataRetrieval")}
                      </span>
                      <Badge>
                        {t(
                          !row.partition.enabled
                            ? "publicDataPaused"
                            : row.partition.error
                              ? "publicDataFailed"
                              : row.stale
                                ? "publicDataOverdue"
                                : "publicDataChecked",
                        )}
                      </Badge>
                      <span className="text-ui-xs">
                        {t("publicDataLastSuccess")}:{" "}
                        {date(row.partition.lastSuccessAt)}
                      </span>
                      <details className="text-ui-xs">
                        <summary className="cursor-pointer">
                          {t("publicDataSchedule")}
                        </summary>
                        <p>
                          {t("publicDataLastCheck")}:{" "}
                          {date(row.partition.lastCheckedAt)}
                        </p>
                        {row.partition.enabled && (
                          <p>
                            {t("publicDataNextCheck")}:{" "}
                            {date(row.partition.nextCheckAt)}
                          </p>
                        )}
                        {row.partition.error && (
                          <Callout>{t("publicDataRetained")}</Callout>
                        )}
                      </details>
                    </div>,
                  ],
                }))}
              />
            </>
          )}
          {working && <Callout>{t("publicDataRefreshing")}</Callout>}
          {(state.contextJob.status === "failed" || refresh.error) && (
            <Callout tone="error">{t("publicDataRefreshFailed")}</Callout>
          )}
          {confirm && <Callout>{t("publicDataConfirm")}</Callout>}
          <div className="flex flex-wrap justify-end gap-stack">
            {confirm ? (
              <>
                <Button
                  variant="outline"
                  disabled={refresh.isPending}
                  onClick={() => setConfirm(false)}
                >
                  {t("cancel")}
                </Button>
                <Button disabled={!canRefresh} onClick={() => refresh.mutate()}>
                  {t("publicDataAdopt")}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={status.isFetching}
                  onClick={() => void status.refetch()}
                >
                  {t(status.isError ? "retry" : "publicDataCheckStatus")}
                </Button>
                {status.data?.canRefreshProjectContext && !status.isError && (
                  <Button
                    disabled={!canRefresh}
                    onClick={() => setConfirm(true)}
                  >
                    {t("publicDataRefresh")}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
