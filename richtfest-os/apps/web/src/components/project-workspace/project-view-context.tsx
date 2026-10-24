import { Link } from "react-router-dom";
import { MapPin } from "lucide-react";
import { parseProjectViewPath } from "@richtfest/shared/project-view-context";
import { useT } from "../../i18n";
import "./messages";

const labels = {
  workspace: "workspaceConversation",
  overview: "overview",
  location: "locationEditor",
  "building-model": "buildingModel",
  "fire-protection": "buildingFireProtection",
  details: "projectDetails",
  sources: "sources",
  inquiries: "inquiries",
  noise: "noiseNav",
  feasibility: "feasibilityNav",
  knowledge: "knowledge",
  analytics: "analytics",
} as const;

export function ProjectViewContext({
  projectId,
  path,
}: {
  projectId: string;
  path?: string;
}) {
  const t = useT();
  const context = path ? parseProjectViewPath(projectId, path) : null;
  if (!context) return null;
  return (
    <div className="project-view-context">
      <MapPin className="size-icon-sm shrink-0" aria-hidden="true" />
      <Link to={path!} title={path}>
        {t("projectAssistantContext")} · {t(labels[context.view])}
        {context.selection.page &&
          ` · ${t("buildingModelPage")} ${context.selection.page}`}
      </Link>
    </div>
  );
}
