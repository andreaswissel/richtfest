import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { ProjectPlanning } from "@richtfest/shared";
import { GripVertical, X } from "lucide-react";
import { api } from "../../api";
import { registerMessages, useT } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge, Callout, Segmented } from "../ui/primitives";
import en from "./locales/en.json";
import de from "./locales/de.json";
import "./task-panel.css";

registerMessages({ en, de });

export type PlannerTask = {
  id: string;
  title: string;
  detail: string;
  href: string;
  status: "review" | "missing";
};

export type BuildingTaskPanelProps = {
  projectId: string;
  tasks: PlannerTask[];
  activeTaskId?: string;
  review?: ReactNode;
  batch?: ReactNode;
  discipline: "physics" | "fire";
  onDiscipline: (value: "physics" | "fire") => void;
  placement: "sidebar" | "floating";
  onPlacement: (value: "sidebar" | "floating") => void;
  onClose: () => void;
};

type Position = { x: number; y: number };
const PAGE_SIZE = 6;
const phaseLabels = {
  plot: "planningPlot", brief: "planningBrief", concept: "planningConcept", design: "planningDesign",
  permit: "planningPermit", execution: "planningExecution", tender: "planningTender", handoff: "planningHandoff",
} as const;
const statusLabels = {
  open: "planningOpen", in_progress: "planningInProgress", blocked: "planningBlocked", in_review: "planningInReview", done: "planningDone",
} as const;

/** Read-only planning list; model review actions are supplied by the workbench. */
export function BuildingTaskPanel({ projectId, tasks, activeTaskId, review, batch, discipline, onDiscipline, placement, onPlacement, onClose }: BuildingTaskPanelProps) {
  const t = useT();
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  const positionRef = useRef<Position | null>(null);
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 });
  const drag = useRef<{ pointerId: number; clientX: number; clientY: number; start: Position; dock: boolean } | null>(null);
  const [dockCue, setDockCue] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const path = `/projects/${encodeURIComponent(projectId)}/planning`;
  const planning = useQuery({ queryKey: [path], queryFn: () => api<ProjectPlanning>(path), staleTime: 30_000 });
  const saved = (planning.data?.items ?? []).filter(item => !item.archived && item.status !== "done" && item.discipline === discipline);
  const active = tasks.find(task => task.id === activeTaskId);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return tasks.filter(task => !query || `${task.title} ${task.detail}`.toLocaleLowerCase().includes(query));
  }, [tasks, search]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  useLayoutEffect(() => {
    if (!activeTaskId) return;
    const review = panel.current?.querySelector<HTMLElement>(".building-task-panel-review");
    review?.focus({ preventScroll: true });
    const body = review?.parentElement;
    if (review && body) body.scrollTop += review.getBoundingClientRect().top - body.getBoundingClientRect().top;
  }, [activeTaskId]);

  function move(next: Position) {
    const node = panel.current;
    const parent = node?.parentElement;
    if (!node || !parent) return;
    const clamped = {
      x: Math.max(0, Math.min(next.x, parent.clientWidth - node.offsetWidth)),
      y: Math.max(0, Math.min(next.y, parent.clientHeight - node.offsetHeight)),
    };
    positionRef.current = clamped;
    setPosition(previous => previous.x === clamped.x && previous.y === clamped.y ? previous : clamped);
  }

  useLayoutEffect(() => {
    drag.current = null;
    setDockCue(false);
    if (placement !== "floating") return;
    const node = panel.current;
    const parent = node?.parentElement;
    if (!node || !parent) return;
    const reclamp = () => move(positionRef.current ?? { x: parent.clientWidth - node.offsetWidth - 12, y: 12 });
    reclamp();
    const observer = new ResizeObserver(reclamp);
    observer.observe(parent);
    observer.observe(node);
    return () => observer.disconnect();
  }, [placement]);

  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (placement !== "floating" || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, start: positionRef.current ?? position, dock: false };
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    const parent = panel.current?.parentElement;
    if (!current || current.pointerId !== event.pointerId || !parent) return;
    event.preventDefault();
    event.stopPropagation();
    move({ x: current.start.x + event.clientX - current.clientX, y: current.start.y + event.clientY - current.clientY });
    const bounds = parent.getBoundingClientRect();
    current.dock = event.clientX >= bounds.right - 48 && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    setDockCue(current.dock);
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    setDockCue(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancelled) move(current.start);
    else if (current.dock) onPlacement("sidebar");
  }

  function moveWithKeys(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape" && drag.current) {
      const current = drag.current;
      drag.current = null;
      setDockCue(false);
      move(current.start);
      if (event.currentTarget.hasPointerCapture(current.pointerId)) event.currentTarget.releasePointerCapture(current.pointerId);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const step = event.shiftKey ? 40 : 10;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const current = positionRef.current ?? position;
    move({ x: current.x + delta[0]!, y: current.y + delta[1]! });
  }

  return <>
    <aside ref={panel} className="building-task-panel text-ui-sm" data-task-placement={placement} aria-labelledby={`${id}-title`}
      style={placement === "floating" ? { left: position.x, top: position.y } : undefined}>
      <header className="building-task-panel-header">
        {placement === "floating" && <Button type="button" variant="ghost" size="icon-sm" className="building-task-panel-drag"
          aria-label={t("buildingTaskMove")} title={t("buildingTaskMove")} onPointerDown={startDrag} onPointerMove={moveDrag}
          onPointerUp={event => finishDrag(event)} onPointerCancel={event => finishDrag(event, true)}
          onLostPointerCapture={event => finishDrag(event, true)} onKeyDown={moveWithKeys}>
          <GripVertical className="size-icon-sm" aria-hidden="true" />
        </Button>}
        <h2 id={`${id}-title`}>{t("buildingTaskTitle")}</h2>
        <Button type="button" variant="outline" size="sm" aria-label={t(placement === "sidebar" ? "buildingTaskFloatLabel" : "buildingTaskDockLabel")}
          onClick={() => onPlacement(placement === "sidebar" ? "floating" : "sidebar")}>
          {t(placement === "sidebar" ? "buildingTaskFloat" : "buildingTaskDock")}
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("buildingTaskClose")} title={t("buildingTaskClose")} onClick={onClose}>
          <X className="size-icon-sm" aria-hidden="true" />
        </Button>
      </header>
      <div className="building-task-panel-body">
        <Segmented aria-label={t("buildingTaskDiscipline")} value={discipline} onChange={value => { if (value === "physics" || value === "fire") { onDiscipline(value); setPage(0); } }}
          items={[{ value: "physics", label: t("planningPhysics") }, { value: "fire", label: t("planningFire") }]} />
        {batch}
        {(active || review) && <section tabIndex={-1} className="building-task-panel-section building-task-panel-review" aria-label={t("buildingTaskSelected")}>
          {active && <><h3><Link to={active.href}>{active.title}</Link></h3><p className="text-ui-xs text-muted-foreground">{active.detail}</p></>}
          {review}
        </section>}
        <section className="building-task-panel-section" aria-labelledby={`${id}-needs`}>
          <h3 id={`${id}-needs`}>{t("buildingTaskNeeds")} <span className="muted">({tasks.length})</span></h3>
          <Input type="search" value={search} aria-label={t("buildingTaskSearch")} placeholder={t("buildingTaskSearch")}
            onChange={event => { setSearch(event.target.value); setPage(0); }} />
          <p className="muted text-ui-xs">{t("buildingTaskScope")}</p>
          {!tasks.length ? <p className="muted">{t("buildingTaskNoNeeds")}</p> : !filtered.length ? <p className="muted">{t("buildingTaskNoMatches")}</p> : <>
            <ul className="building-task-panel-list">
              {visible.map(task => <li key={task.id}>
                <Link to={task.href} className="building-task-panel-link" aria-current={task.id === activeTaskId ? "true" : undefined}>
                  <span>{task.title}<small className="text-ui-xs text-muted-foreground">{task.detail}</small></span><Badge variant="outline">{t(task.status === "review" ? "buildingTaskReview" : "buildingTaskMissing")}</Badge>
                </Link>
              </li>)}
            </ul>
            <div className="building-task-panel-pagination">
              <span className="muted text-ui-xs" aria-live="polite">{t("buildingTaskCount").replace("{from}", String(currentPage * PAGE_SIZE + 1)).replace("{to}", String(currentPage * PAGE_SIZE + visible.length)).replace("{count}", String(filtered.length))}</span>
              {filtered.length > PAGE_SIZE && <>
                <Button type="button" size="sm" variant="ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} aria-label={t("buildingTaskPreviousLabel")}>{t("buildingTaskPrevious")}</Button>
                <Button type="button" size="sm" variant="ghost" disabled={(currentPage + 1) * PAGE_SIZE >= filtered.length} onClick={() => setPage(currentPage + 1)} aria-label={t("buildingTaskNextLabel")}>{t("buildingTaskNext")}</Button>
              </>}
            </div>
          </>}
        </section>
        <section className="building-task-panel-section" aria-labelledby={`${id}-saved`}>
          <h3 id={`${id}-saved`}>{t("buildingTaskSaved")}{planning.data && <span className="muted"> ({saved.length})</span>}</h3>
          {planning.isPending && <p role="status" className="muted">{t("planningLoading")}</p>}
          {planning.isError && <Callout tone="error"><p>{t("planningLoadError")}</p><Button type="button" variant="outline" size="sm" disabled={planning.isFetching} onClick={() => void planning.refetch()}>{t("planningReload")}</Button></Callout>}
          {planning.data && <>
            {planning.isError && <p className="muted text-ui-xs">{t("buildingTaskSavedStale")}</p>}
            {!saved.length && !planning.isError && <p className="muted">{t("buildingTaskNoSaved")}</p>}
            {saved.length > 0 && <ul className="building-task-panel-list building-task-panel-saved">
              {saved.map(item => <li key={item.id}>
                <Link className="building-task-panel-link" to={`/projects/${encodeURIComponent(projectId)}?${new URLSearchParams({ view: "overview", perspective: "planner", planningItem: item.id, phase: item.phase, discipline: item.discipline })}`}>
                  <span>{item.title}<small className="muted text-ui-xs">{t(phaseLabels[item.phase])}</small></span>
                  <Badge variant="outline">{t(statusLabels[item.status])}</Badge>
                </Link>
              </li>)}
            </ul>}
          </>}
        </section>
      </div>
    </aside>
    {dockCue && placement === "floating" && <div className="building-task-panel-drop-cue" role="status">{t("buildingTaskDropDock")}</div>}
  </>;
}
