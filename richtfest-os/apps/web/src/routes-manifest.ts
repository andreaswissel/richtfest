import {
  BookOpen,
  FolderKanban,
  CircleHelp,
  LayoutDashboard,
  Settings2,
  UserRound,
  UsersRound,
} from "lucide-react";

export const routesManifest = [
  { path: "/", key: "overview", group: "richtfest-os", icon: LayoutDashboard },
  { path: "/projects", key: "projects", group: "projects", icon: FolderKanban },
  { path: "/customers", key: "customers", group: "crm", icon: UserRound },
  {
    path: "/knowledge",
    key: "companyKnowledge",
    group: "richtfest-os",
    icon: BookOpen,
  },
  { path: "/team", key: "team", group: "richtfest-os", icon: UsersRound },
  {
    path: "/settings",
    key: "settings",
    group: "richtfest-os",
    icon: Settings2,
  },
  { path: "/help", key: "help", group: "richtfest-os", icon: CircleHelp },
] as const;
export const performanceRoutes = [
  "/",
  "/projects",
  "/customers",
  "/team",
  "/knowledge",
  "/knowledge/:draftId",
  "/projects/:id",
  "/projects/:id?view=location",
  "/projects/:id?view=analytics",
  "/settings",
  "/settings/models",
  "/settings/agents",
  "/settings/security",
  "/help",
];
