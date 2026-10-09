import { getAuthClient, authResult } from "./lib/auth";
import { Login } from "./screens/auth";
import { Button } from "./components/ui/button";
import { Page, PageHeader } from "./components/layout";
import { useEffect, useLayoutEffect } from "react";
import { Outlet, Link, NavLink, useLocation } from "react-router-dom";
import { queryClient, useApi } from "./query";
import { api, ApiError } from "./api";
import { useT } from "./i18n";
import { usePreferences } from "./store";
import { routesManifest } from "./routes-manifest";
import { LoadState } from "./screens/foundation";
import { persistWorkspaceCache } from "./query-cache";
import { ArrowUpRight, BookOpen, LogOut } from "lucide-react";
export function App({ initializing = false }: { initializing?: boolean }) {
  const session = useApi("/auth/me"),
    t = useT(),
    preferences = usePreferences();
  const { pathname } = useLocation();
  const sessionUser = session.isError
    ? undefined
    : session.data?.user || session.data;
  const pending = session.isPending || initializing;
  const route = routesManifest.find((route) =>
    route.path === "/" ? pathname === "/" : pathname.startsWith(route.path),
  );
  useLayoutEffect(() => {
    if (sessionUser?.id) {
      preferences.hydrate({
        density: sessionUser.uiDensity,
        language: sessionUser.language,
        theme: sessionUser.theme,
      });
    }
  }, [
    sessionUser?.id,
    sessionUser?.uiDensity,
    sessionUser?.language,
    sessionUser?.theme,
  ]);
  useEffect(() => {
    if (sessionUser?.id && typeof indexedDB !== "undefined")
      return persistWorkspaceCache(`${sessionUser.tenantId}:${sessionUser.id}`);
  }, [sessionUser?.id, sessionUser?.tenantId]);
  useLayoutEffect(() => {
    document.documentElement.dataset.density = preferences.density;
    document.documentElement.lang = preferences.language;
    document.documentElement.classList.toggle(
      "dark",
      preferences.theme === "dark",
    );
  }, [preferences.density, preferences.language, preferences.theme]);
  if (
    (session.error instanceof ApiError && session.error.status === 401) ||
    (session.data && !session.data.user && !session.data.id)
  )
    return <Login />;
  const user = sessionUser;
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
            <strong>
              {user
                ? session.data?.workspace?.name || "Richtfest"
                : "Richtfest"}
            </strong>
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
                if (!user?.id) return;
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
          {user?.id && (
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
          )}
        </div>
      </aside>
      <div className="main-shell">
        <div className="topbar">
          {/^\/projects\/[^/]+/.test(pathname) ? (
            <Link className="back-link" to="/projects">
              ← {t("backProjects")}
            </Link>
          ) : (
            <span>{t("workspace")}</span>
          )}
        </div>
        <main id="main" aria-busy={pending}>
          {session.isError ? (
            <Page>
              <LoadState query={session} />
            </Page>
          ) : pending ? (
            <Page>
              <PageHeader title={t(route?.key || "workspace")} />
              <div role="status">
                <span className="sr-only">{t("loading")}</span>
                <div
                  aria-hidden="true"
                  className="grid gap-stack motion-safe:animate-pulse"
                >
                  <div className="h-control w-1/3 rounded-md bg-muted" />
                  <div className="h-control w-full rounded-md bg-muted" />
                  <div className="h-control w-4/5 rounded-md bg-muted" />
                </div>
              </div>
            </Page>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </div>
  );
}
