import { z } from "zod";
import { planningDisciplineKeys, projectPhaseKeys } from "./project-planning";

export const projectViewKeys = ["workspace", "overview", "location", "building-model", "fire-protection", "analytics", "details", "sources", "inquiries", "noise", "feasibility", "knowledge"] as const;
export type ProjectView = typeof projectViewKeys[number];

// Only route identifiers and finite UI choices, never search text or instructions.
const selectionSchema = z.object({
  entity: z.string().regex(/^(building|storey|room|element):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).optional(),
  sourceVersion: z.string().uuid().optional(),
  page: z.string().regex(/^[1-9]\d{0,5}$/).optional(),
  storey: z.string().uuid().optional(),
  candidate: z.string().uuid().optional(),
  file: z.string().uuid().optional(),
  artifact: z.string().uuid().optional(),
  revision: z.string().uuid().optional(),
  planningItem: z.string().uuid().optional(),
  inquiry: z.string().uuid().optional(),
  source: z.string().uuid().optional(),
  study: z.enum(["site", "financial"]).optional(),
  modelState: z.enum(["existing", "demolition", "proposed"]).optional(),
  modelSource: z.enum(["pdf", "ifc"]).optional(),
  modelView: z.enum(["2d", "3d"]).optional(),
  sourceSelection: z.literal("manual").optional(),
  perspective: z.enum(["coordinator", "planner", "nerd"]).optional(),
  panel: z.enum(["artifacts", "documents"]).optional(),
  overlay: z.literal("fire").optional(),
  buildingScope: z.enum(["building", "surroundings"]).optional(),
  floorFocus: z.enum(["0", "1"]).optional(),
  roomFocus: z.enum(["0", "1"]).optional(),
  phase: z.enum(projectPhaseKeys).optional(),
  discipline: z.enum(planningDisciplineKeys).optional(),
  planningFilter: z.enum(["all", "open", "review"]).optional(),
}).strict();

export type ProjectViewContext = {
  path: string;
  projectId: string;
  view: ProjectView;
  selection: z.infer<typeof selectionSchema>;
};

/** Canonical bounded link. Invalid browser state is omitted; invalid project IDs return "". */
export function buildProjectViewPath(projectId: string, search: URLSearchParams): string {
  if (!z.string().uuid().safeParse(projectId).success) return "";
  const view = z.enum(projectViewKeys).safeParse(search.get("view"));
  const params = new URLSearchParams({ view: view.success ? view.data : "workspace" });
  const prefix = `/projects/${projectId}?`;
  for (const [key, schema] of Object.entries(selectionSchema.shape)) {
    if (search.getAll(key).length !== 1) continue;
    const parsed = schema.safeParse(search.get(key));
    if (!parsed.success || parsed.data === undefined) continue;
    params.set(key, parsed.data);
    if (prefix.length + params.toString().length > 1000) params.delete(key);
  }
  return prefix + params.toString();
}

/** Strict same-project parser; a route is a selection hint, not authority/evidence. */
export function parseProjectViewPath(projectId: string, path: string): ProjectViewContext | null {
  if (!z.string().uuid().safeParse(projectId).success || path.length > 1000) return null;
  const prefix = `/projects/${projectId}`;
  if (path !== prefix && !path.startsWith(`${prefix}?`)) return null;
  if (/[#\s\\]/.test(path)) return null;
  const params = new URLSearchParams(path.slice(prefix.length + 1));
  const values: Record<string, string> = {};
  for (const [key, value] of params) {
    if (params.getAll(key).length !== 1) return null;
    if (key !== "view") {
      if (!Object.hasOwn(selectionSchema.shape, key)) return null;
      values[key] = value;
    }
  }
  const view = z.enum(projectViewKeys).safeParse(params.get("view") ?? "workspace");
  const selection = selectionSchema.safeParse(values);
  if (!view.success || !selection.success) return null;
  return { path: buildProjectViewPath(projectId, params), projectId, view: view.data, selection: selection.data };
}
