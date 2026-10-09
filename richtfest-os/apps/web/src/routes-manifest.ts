import {
  FolderKanban,
  LayoutDashboard,
  Settings2,
  UserRound,
  UsersRound,
} from "lucide-react";

export const routesManifest = [
  { path: "/", key: "overview", group: "richtfest-os", icon: LayoutDashboard },
  { path: "/projects", key: "projects", group: "projects", icon: FolderKanban },
  { path: "/customers", key: "customers", group: "crm", icon: UserRound },
  { path: "/team", key: "team", group: "richtfest-os", icon: UsersRound },
  { path: "/settings", key: "settings", group: "richtfest-os", icon: Settings2 },
] as const;
export const performanceRoutes = [
  "/",
  "/projects",
  "/customers",
  "/team",
  "/projects/:id",
  "/settings",
  "/settings/security",
];
