import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, list, type RecordData } from "../api";
import { queryClient, useApi } from "../query";
import { useT } from "../i18n";
import { Page, PageHeader, Section } from "../components/layout";
import { Button } from "../components/ui/button";
import { NativeSelect } from "../components/ui/native-select";
import { Callout, Empty } from "../components/ui/primitives";
import { LoadState, ProjectTable } from "./foundation";

export function Dashboard() {
  const t = useT(), query = useApi("/dashboard");
  const data = query.data;
  return <Page>
    <PageHeader title={t("overview")} description={t("homeSubtitle")} actions={
      <Button asChild variant="default"><Link to="/projects?create=1">＋ {t("newProject")}</Link></Button>
    } />
    <LoadState query={query} />
    {data && <>
      <div className="overview-metrics">
        {[
          [t("projects"), list(data.projects).length],
          [t("assignedWork"), list(data.tasks || data.assignedTasks).length],
          [t("pendingReview"), list(data.pendingDrafts || data.pendingReview).length + list(data.reviewTasks).length],
        ].map(([label, n]) => <div className="metric-card" key={label}><span>{label}</span><strong>{n}</strong></div>)}
      </div>
      <Section title={t("projects")} meta={<Button asChild variant="link"><Link to="/projects">{t("allProjects")} ↗</Link></Button>}>
        <ProjectTable projects={list(data.projects)} />
      </Section>
      <div className="split [&>.section]:min-w-0">
        <Section title={t("assignedWork")}><TaskQueue tasks={list(data.tasks || data.assignedTasks)} /></Section>
        <Section title={t("pendingReview")}>
          {list(data.reviewTasks).length > 0 && <TaskQueue tasks={list(data.reviewTasks)} />}
          <WorkList items={list(data.pendingDrafts || data.pendingReview)} empty={list(data.reviewTasks).length ? "" : t("noReview")} knowledge />
        </Section>
      </div>
      <Section title={t("missingInfo")}><WorkList items={list(data.missingInformation || data.missingInfo)} empty={t("noMissing")} /></Section>
    </>}
  </Page>;
}

function TaskQueue({ tasks }: { tasks: RecordData[] }) {
  const t = useT();
  const me = useApi("/auth/me");
  const canWrite = (me.data?.permissions || []).includes("knowledge:write");
  const update = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api(`/knowledge/tasks/${id}`, { status }, "PATCH"),
    onSuccess: () => { void queryClient.invalidateQueries(); },
  });
  return <div className="grid min-w-0 gap-stack">
    {tasks.map(task => <div key={task.id} className="flex min-w-0 items-center justify-between gap-stack">
      <div className="grid min-w-0">
        <Link className="min-w-0 truncate" title={task.title} to={task.projectId
          ? `/projects/${task.projectId}${task.conversationId ? `?conversation=${encodeURIComponent(task.conversationId)}` : ""}`
          : "/knowledge"}>{task.title}</Link>
        <span className="truncate text-ui-xs text-muted-foreground">{task.assigneeName || (task.assigneeType === "agent" ? t("agent") : task.assigneeId || t("responsibilityUnassigned"))}</span>
      </div>
      <NativeSelect className="shrink-0" aria-label={`${t("status")}: ${task.title}`} value={task.status} disabled={!canWrite || update.isPending} onChange={event => update.mutate({ id: task.id, status: event.target.value })}>
        {["open", "in_progress", "needs_review", "completed", "cancelled"].map(status => <option key={status} value={status}>{t(`task_${status}` as never)}</option>)}
      </NativeSelect>
    </div>)}
    {!tasks.length && <Empty>{t("noWork")}</Empty>}
    {!!tasks.length && <p className="text-ui-xs text-muted-foreground">{t("taskTrackingOnly")}</p>}
    {update.error && <Callout tone="error">{update.error.message}</Callout>}
  </div>;
}

function WorkList({ items, empty, knowledge = false }: { items: RecordData[]; empty: string; knowledge?: boolean }) {
  return items.length ? <div className="work-list">
    {items.map((item, i) => <Link key={item.id || i} to={knowledge
      ? item.projectId ? `/projects/${item.projectId}?view=knowledge` : `/knowledge/${item.id}`
      : `/projects/${item.projectId}`}>
      <span>{item.title || item.name || item.message}</span><span>↗</span>
    </Link>)}
  </div> : empty ? <Empty>{empty}</Empty> : null;
}
