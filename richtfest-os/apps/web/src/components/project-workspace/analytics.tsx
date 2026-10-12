import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  AgentUsageAnalytics,
  ProjectAgentAnalytics,
} from "@richtfest/shared";
import { api } from "../../api";
import { useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { Badge, Callout, Empty, RowLink, linkedRow } from "../ui/primitives";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "../ui/table";

function Cost({ usage }: { usage: AgentUsageAnalytics }) {
  const t = useT();
  const language = usePreferences((s) => s.language);
  const value = usage.estimatedCostUsd ?? usage.recordedCostUsd;
  return (
    <div className="flex flex-col items-end gap-1 tabular-nums">
      <span>
        {value === null
          ? "—"
          : value > 0 && value < 0.01
            ? `< ${new Intl.NumberFormat(language, { style: "currency", currency: "USD" }).format(0.01)}`
            : new Intl.NumberFormat(language, {
                style: "currency",
                currency: "USD",
              }).format(value)}
      </span>
      {usage.estimatedCostUsd === null && (
        <Badge className="!h-auto max-w-full !whitespace-normal text-right">
          {t(value === null ? "analyticsUnavailable" : "analyticsPartial")}
        </Badge>
      )}
    </div>
  );
}

export function ProjectAnalytics({ projectId }: { projectId: string }) {
  const t = useT();
  const language = usePreferences((s) => s.language);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const path = `/knowledge/workspaces/${projectId}/analytics?page=${page}`;
  const query = useQuery({
    queryKey: [path],
    queryFn: () => api<ProjectAgentAnalytics>(path),
    staleTime: 30_000,
  });
  const number = (value: number | null) =>
    value === null ? "—" : new Intl.NumberFormat(language).format(value);
  const date = (value: string) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime())
      ? parsed.toLocaleString(language, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "—";
  };
  const role = (value: string | null) => {
    const keys = {
      source_reviewer: "agentThreadSourceName",
      requirements_reviewer: "agentThreadRequirementsName",
      independent_reviewer: "supervisorIndependentReviewer",
      sound_insulation: "supervisorSoundInsulation",
      construction_law: "supervisorConstructionLaw",
      cost_optimizer: "supervisorCostOptimizer",
    } as const;
    return value && value in keys
      ? t(keys[value as keyof typeof keys])
      : value || t("agentThreadCoordinator");
  };
  const status = (value: string) => {
    const keys = {
      queued: "run_queued",
      running: "run_running",
      failed: "run_failed",
      cancelled: "run_cancelled",
      needs_review: "run_needs_review",
      needs_attention: "run_needs_attention",
      approved: "run_approved",
      completed: "agentRunsDone",
      unconfigured: "run_unconfigured",
    } as const;
    return value in keys ? t(keys[value as keyof typeof keys]) : value;
  };
  return (
    <Section
      title={t("analyticsRunCosts")}
      meta={
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {t("analyticsRefresh")}
        </Button>
      }
    >
      <div className="flex min-w-0 flex-col gap-stack">
        <p className="text-ui-sm text-muted-foreground">
          {t("analyticsScope")}
        </p>
        {query.isError && (
          <Callout tone="error">{t("analyticsLoadError")}</Callout>
        )}
        {query.isPending && (
          <div className="loading-line" role="status">
            {t("loading")}
          </div>
        )}
        {query.data && !query.data.runs.length && (
          <Empty>{t("analyticsEmpty")}</Empty>
        )}
        {!!query.data?.runs.length && (
          <Table className="data-table table-fixed text-ui-sm">
            <TableHeader>
              <TableRow>
                <TableHead className="w-3/5 md:w-2/5">
                  {t("analyticsRun")}
                </TableHead>
                <TableHead className="hidden md:table-cell">
                  {t("status")}
                </TableHead>
                <TableHead className="hidden md:table-cell">
                  {t("analyticsAgents")}
                </TableHead>
                <TableHead className="hidden md:table-cell">
                  {t("agentRunInputTokens")}
                </TableHead>
                <TableHead className="hidden md:table-cell">
                  {t("agentRunOutputTokens")}
                </TableHead>
                <TableHead className="w-2/5 !whitespace-normal text-right md:w-auto">
                  {t("analyticsTotal")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.runs.map((run) => (
                <Fragment key={run.id}>
                  <TableRow>
                    <TableCell className="!whitespace-normal">
                      <Button
                        variant="ghost"
                        className="!h-auto w-full justify-start !whitespace-normal text-left"
                        aria-expanded={expanded === run.id}
                        aria-controls={`analytics-${run.id}`}
                        onClick={() =>
                          setExpanded(expanded === run.id ? null : run.id)
                        }
                      >
                        {expanded === run.id ? (
                          <ChevronDown className="size-icon shrink-0" />
                        ) : (
                          <ChevronRight className="size-icon shrink-0" />
                        )}
                        <span className="min-w-0">
                          <span className="block">{run.goal}</span>
                          <span className="block text-ui-xs font-normal text-muted-foreground">
                            {run.isSupervisor
                              ? t("supervisorRole")
                              : t("agentThreadCoordinator")}{" "}
                            · {date(run.createdAt)}
                          </span>
                          <span className="block text-ui-xs font-normal text-muted-foreground md:hidden">
                            {status(run.status)}
                          </span>
                        </span>
                      </Button>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Badge className="!h-auto max-w-full !whitespace-normal">{status(run.status)}</Badge>
                    </TableCell>
                    <TableCell className="hidden tabular-nums md:table-cell">
                      {number(run.members.length)}
                    </TableCell>
                    <TableCell className="hidden tabular-nums md:table-cell">
                      {number(run.aggregate.inputTokens)}
                    </TableCell>
                    <TableCell className="hidden tabular-nums md:table-cell">
                      {number(run.aggregate.outputTokens)}
                    </TableCell>
                    <TableCell>
                      <Cost usage={run.aggregate} />
                    </TableCell>
                  </TableRow>
                  {expanded === run.id && (
                    <TableRow id={`analytics-${run.id}`}>
                      <TableCell
                        colSpan={6}
                        className="!whitespace-normal bg-muted/20"
                      >
                        <div className="flex flex-col gap-stack py-cell">
                          <div className="flex flex-wrap items-center justify-between gap-stack">
                            <h3 className="text-ui font-medium">
                              {t("analyticsBreakdown")}
                            </h3>
                            <RowLink
                              to={`/projects/${projectId}?agentRun=${run.id}`}
                            >
                              {t("analyticsOpenRun")}
                            </RowLink>
                          </div>
                          {run.aggregate.estimatedCostUsd === null && (
                            <Callout>
                              {t("analyticsIncomplete")}{" "}
                              {t("analyticsMissingAttempts")}:{" "}
                              {number(run.aggregate.missingUsageAttempts)} ·{" "}
                              {t("analyticsUnpricedCalls")}:{" "}
                              {number(run.aggregate.unpricedCalls)} ·{" "}
                              {t("analyticsUnreportedRuns")}:{" "}
                              {number(run.aggregate.unreportedRuns)}
                            </Callout>
                          )}
                          <Table className="data-table text-ui-sm">
                            <TableHeader>
                              <TableRow>
                                {[
                                  "analyticsAgent",
                                  "analyticsModels",
                                  "analyticsCalls",
                                  "agentRunInputTokens",
                                  "agentRunOutputTokens",
                                  "agentRunReasoningTokens",
                                  "analyticsCached",
                                  "analyticsOwnCost",
                                ].map((key) => (
                                  <TableHead key={key}>
                                    {t(key as "analyticsAgent")}
                                  </TableHead>
                                ))}
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {[...run.members]
                                .sort(
                                  (a, b) =>
                                    Number(b.id === run.id) -
                                    Number(a.id === run.id),
                                )
                                .map((member) => (
                                  <TableRow key={member.id} {...linkedRow}>
                                    <TableCell className="!whitespace-normal min-w-48 max-w-xs">
                                      <RowLink
                                        to={`/projects/${projectId}?agentRun=${member.id}`}
                                      >
                                        {member.id === run.id &&
                                        run.isSupervisor
                                          ? t("supervisorRole")
                                          : role(member.specialistRole)}
                                      </RowLink>
                                      <span className="block text-ui-xs text-muted-foreground">
                                        {member.goal}
                                      </span>
                                    </TableCell>
                                    <TableCell className="!whitespace-normal min-w-36 max-w-48 break-words">
                                      {member.usage.models.join(", ") || "—"}
                                    </TableCell>
                                    <TableCell>
                                      {number(member.usage.callCount)}
                                    </TableCell>
                                    <TableCell>
                                      {number(member.usage.inputTokens)}
                                    </TableCell>
                                    <TableCell>
                                      {number(member.usage.outputTokens)}
                                    </TableCell>
                                    <TableCell>
                                      {number(member.usage.reasoningTokens)}
                                    </TableCell>
                                    <TableCell>
                                      {number(member.usage.cachedInputTokens)}
                                    </TableCell>
                                    <TableCell>
                                      <Cost usage={member.usage} />
                                    </TableCell>
                                  </TableRow>
                                ))}
                            </TableBody>
                          </Table>
                          <p className="text-ui-xs text-muted-foreground">
                            {t("analyticsLegacy")}
                          </p>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )}
        {(page > 0 || query.data?.hasMore) && (
          <div className="flex items-center justify-end gap-stack">
            <Button
              variant="outline"
              disabled={!page || query.isFetching}
              onClick={() => {
                setPage(page - 1);
                setExpanded(null);
              }}
            >
              {t("analyticsNewer")}
            </Button>
            <span className="text-ui-sm">
              {t("analyticsPage")} {page + 1}
            </span>
            <Button
              variant="outline"
              disabled={!query.data?.hasMore || query.isFetching}
              onClick={() => {
                setPage(page + 1);
                setExpanded(null);
              }}
            >
              {t("analyticsOlder")}
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}
