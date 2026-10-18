import { z } from "zod";

export const projectPhaseKeys = ["plot", "brief", "concept", "design", "permit", "execution", "tender", "handoff"] as const;
export const planningDisciplineKeys = ["coordination", "architecture", "structure", "services", "physics", "fire"] as const;
export const planningModuleKeys = ["workspace", "location", "building-model", "details", "sources", "inquiries", "noise", "feasibility", "knowledge", "analytics"] as const;
export const planningStatusKeys = ["open", "in_progress", "blocked", "in_review", "done"] as const;
export const planningKindKeys = ["deliverable", "decision", "milestone"] as const;
export type ProjectPhase = typeof projectPhaseKeys[number];
export type PlanningDiscipline = typeof planningDisciplineKeys[number];
export type PlanningModule = typeof planningModuleKeys[number];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");

export const projectPlanningItemInput = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  phase: z.enum(projectPhaseKeys),
  discipline: z.enum(planningDisciplineKeys),
  kind: z.enum(planningKindKeys),
  status: z.enum(planningStatusKeys),
  owner: z.string().trim().max(200),
  dueDate: date.nullable(),
  notes: z.string().max(10000),
  module: z.enum(planningModuleKeys),
  dependsOn: z.array(z.string().uuid()).max(100),
  archived: z.boolean(),
}).strict();
export type ProjectPlanningItem = z.infer<typeof projectPlanningItemInput>;

// One versioned aggregate per project. Selecting a phase is URL state, not a write.
export const projectPlanningInput = z.object({
  expectedRevision: z.number().int().nonnegative(),
  currentPhase: z.enum(projectPhaseKeys).nullable(),
  items: z.array(projectPlanningItemInput).max(1000),
}).strict().superRefine(({ items }, ctx) => {
  const byId = new Map(items.map(item => [item.id, item]));
  if (byId.size !== items.length) ctx.addIssue({ code: "custom", message: "Duplicate planning item ID" });
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dependency) || !visit(dependency)) return false;
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  if (items.some(item => !visit(item.id))) ctx.addIssue({ code: "custom", message: "Dependencies must reference this project's items without cycles" });
  for (const item of items) {
    if (!item.archived && item.dependsOn.some(id => byId.get(id)?.archived))
      ctx.addIssue({ code: "custom", message: "Active items cannot depend on archived items" });
  }
});

export type ProjectPlanning = {
  revision: number;
  currentPhase: ProjectPhase | null;
  items: ProjectPlanningItem[];
};
