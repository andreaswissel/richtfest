import { Security } from "./screens/security";
import { getAuthClient, authResult } from "./lib/auth";
import { Team } from "./screens/team";
import { Login } from "./screens/auth";
import { Button } from "./components/ui/button";
import React, { useEffect, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserRouter,
  RouterProvider,
  Outlet,
  Link,
  NavLink,
} from "react-router-dom";
import { queryClient, useApi } from "./query";
import { api, ApiError } from "./api";
import { useT } from "./i18n";
import { usePreferences } from "./store";
import { routesManifest } from "./routes-manifest";
import {
  Customers,
  Dashboard,
  LoadState,
  Projects,
} from "./screens/foundation";
import "./index.css";
import { Settings } from "./screens/settings";
import { persistWorkspaceCache } from "./query-cache";
import { ArrowUpRight, BookOpen, LogOut } from "lucide-react";
function App() {
  const session = useApi("/auth/me"),
    t = useT(),
    preferences = usePreferences();
  const sessionUser = session.data?.user || session.data;
  useLayoutEffect(() => {
    if (sessionUser?.id) {
      preferences.hydrate({
        density: sessionUser.uiDensity,
        language: sessionUser.language,
        theme: sessionUser.theme,
      });
    }
  }, [sessionUser?.id, sessionUser?.uiDensity, sessionUser?.language, sessionUser?.theme]);
  useEffect(() => {
    if (sessionUser?.id && typeof indexedDB !== "undefined")
      return persistWorkspaceCache(`${sessionUser.tenantId}:${sessionUser.id}`);
  }, [sessionUser?.id, sessionUser?.tenantId]);
  useLayoutEffect(() => {
    document.documentElement.dataset.density = preferences.density;
    document.documentElement.lang = preferences.language;
    document.documentElement.classList.toggle("dark", preferences.theme === "dark");
  }, [preferences.density, preferences.language, preferences.theme]);
  if (session.isPending)
    return (
      <div className="boot">
        <span className="brand-symbol">R</span>
        {t("loading")}
      </div>
    );
  if (
    (session.error instanceof ApiError && session.error.status === 401) ||
    (session.data && !session.data.user && !session.data.id)
  )
    return <Login />;
  if (session.isError)
    return (
      <div className="boot">
        <LoadState query={session} />
      </div>
    );
  const user = session.data?.user || session.data;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link to="/" className="brand">
          <span className="brand-symbol">R</span> richtfest
          <span className="brand-dot">.</span>
        </Link>
        <div className="workspace-label">
          <span className="workspace-monogram">A</span>
          <div>
            <strong>{session.data?.workspace?.name || "Richtfest"}</strong>
            <small>{t("workspace")}</small>
          </div>
        </div>
        <div className="nav-label">{t("home")}</div>
        <nav aria-label={t("home")}>
          {routesManifest.map((r) => (
            <NavLink
              key={r.path}
              end={r.path === "/"}
              to={r.path}
              onMouseEnter={() => {
                const path =
                  r.path === "/"
                    ? "/dashboard"
                    : r.path === "/customers"
                      ? "/crm/customers"
                      : r.path === "/team"
                        ? "/access/team"
                        : r.path === "/settings"
                          ? "/settings/ai-connections"
                          : r.path;
                void queryClient.prefetchQuery({
                  queryKey: [path],
                  queryFn: () => api(path),
                });
              }}
            >
              <span className="nav-icon">
                <r.icon aria-hidden="true" />
              </span>
              {t(r.key)}
              <span className="nav-arrow">
                <ArrowUpRight aria-hidden="true" size={14} />
              </span>
            </NavLink>
          ))}
          <a
            href={
              import.meta.env.DEV
                ? `${location.protocol}//${location.hostname}:3000/docs/`
                : "/docs/"
            }
          >
            <span className="nav-icon">
              <BookOpen aria-hidden="true" />
            </span>
            {t("docs")}
            <span className="nav-arrow">
              <ArrowUpRight aria-hidden="true" size={14} />
            </span>
          </a>
        </nav>
        <div className="sidebar-bottom">
          <div className="user-row">
            <Link
              to="/settings/security"
              className="flex min-w-0 items-center gap-2 text-inherit no-underline"
            >
              <span className="avatar">{user?.name?.slice(0, 1) || "R"}</span>
              <span>
                <strong>{user?.name}</strong>
                <small>{user?.email}</small>
              </span>
            </Link>
            <Button
              variant="ghost"
              size="icon"
              title={t("signOut")}
              aria-label={t("signOut")}
              onClick={async () => {
                const client = await getAuthClient();
                authResult(await client.signOut());
                queryClient.clear();
                location.reload();
              }}
            >
              <LogOut aria-hidden="true" size={16} />
            </Button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <div className="topbar">
          <span>{t("workspace")}</span>
        </div>
        <main id="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
const prefetch = (path: string) => () => {
  if (queryClient.getQueryData(["/auth/me"]))
    void queryClient.prefetchQuery({
      queryKey: [path],
      queryFn: () => api(path),
    });
  return null;
};
const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  {
    element: <App />,
    children: [
      { path: "/settings/security", element: <Security /> },
      { path: "/", element: <Dashboard />, loader: prefetch("/dashboard") },
      {
        path: "/projects",
        element: <Projects />,
        loader: prefetch("/projects"),
      },
      {
        path: "/projects/:id",
        lazy: async () => ({
          Component: (await import("./screens/project-workspace"))
            .ProjectWorkspace,
        }),
        loader: ({ params }) => prefetch(`/projects/${params.id}`)(),
      },
      {
        path: "/customers",
        element: <Customers />,
        loader: prefetch("/crm/customers"),
      },
      { path: "/team", element: <Team />, loader: prefetch("/access/team") },
      {
        path: "/settings",
        element: <Settings />,
        loader: prefetch("/settings/ai-connections"),
      },
    ],
  },
]);
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
