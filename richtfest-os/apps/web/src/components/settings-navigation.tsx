import { Link, useLocation } from "react-router-dom";
import { useT } from "../i18n";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

export function SettingsNavigation() {
  const t = useT();
  const { pathname } = useLocation();
  const currentPath = pathname.replace(/\/$/, "");
  const sections = [
    { path: "/settings", label: t("aiConnections") },
    { path: "/settings/models", label: t("supervisorPresets") },
    { path: "/settings/agents", label: t("agentProfilesTitle") },
    { path: "/settings/security", label: t("accountSettings") },
  ];
  return (
    <nav aria-label={t("settingsSections")}>
      <ToggleGroup
        type="single"
        value={currentPath}
        className="segmented flex-wrap"
      >
        {sections.map(({ path, label }) => (
          <ToggleGroupItem
            key={path}
            value={path}
            className="h-control-sm min-w-0 px-3 py-1 text-ui-xs text-muted-foreground"
            asChild
          >
            <Link
              to={path}
              aria-current={currentPath === path ? "page" : undefined}
            >
              {label}
            </Link>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </nav>
  );
}
