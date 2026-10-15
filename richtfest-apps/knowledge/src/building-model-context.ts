import { buildingDeepLink, buildingEntityRefSchema } from "@richtfest/shared";
import type { AppDeps } from "./deps";

/** Selection is only a hint: Projects reauthorizes the exact object in this project. */
export function selectedBuildingObject(projectId: string, text: string) {
  const prefix = buildingDeepLink(projectId, "room", "").slice(0, -5);
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`${escaped}(building|storey|room|element):([0-9a-f-]{36})(?=$|[\\s&#)\\]])`, "i"));
  const selected = match && buildingEntityRefSchema.safeParse({ entityType: match[1], entityId: match[2] });
  return selected && selected.success ? selected.data : undefined;
}

export async function buildingContextForRun(d: AppDeps, run: { projectId: string; goal: string }) {
  return d.buildingModelContext?.(run.projectId, selectedBuildingObject(run.projectId, run.goal));
}
