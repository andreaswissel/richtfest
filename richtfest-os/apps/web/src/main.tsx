import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { App } from "./app";
import { Login } from "./screens/auth";
import { Security } from "./screens/security";
import { Team } from "./screens/team";
import { Customers, Projects } from "./screens/foundation";
import { Settings } from "./screens/settings";
import { SettingsModels } from "./screens/settings-models";
import { SettingsAgents } from "./screens/settings-agents";
import { queryClient } from "./query";
import { api } from "./api";
import { cachedFeatureEnabled } from "./feature-flags";
import { RouteError, RouteLoading } from "./components/module-recovery";
import "./index.css";

const prefetch = (path: string) => () => {
  if (queryClient.getQueryState(["/auth/me"])?.status === "success")
    void queryClient.prefetchQuery({
      queryKey: [path],
      queryFn: () => api(path),
    });
  return null;
};
const router = createBrowserRouter([
  { path: "/login", element: <Login />, errorElement: <RouteError /> },
  {
    element: <App />,
    errorElement: <RouteError />,
    hydrateFallbackElement: <App initializing />,
    children: [
      { path: "/settings/security", element: <Security /> },
      {
        path: "/settings/models",
        element: <SettingsModels />,
        loader: prefetch("/settings/ai-connections"),
      },
      {
        path: "/settings/agents",
        element: <SettingsAgents />,
        loader: prefetch("/knowledge/agent-profiles"),
      },
      { path: "/", lazy: async () => ({ Component: (await import("./screens/dashboard")).Dashboard }), loader: prefetch("/dashboard") },
      {
        path: "/knowledge/:draftId?",
        lazy: async () => ({
          Component: (await import("./screens/company-knowledge"))
            .CompanyKnowledge,
        }),
        loader: ({ params, request }) => {
          const search = new URL(request.url).searchParams;
          if (!params.draftId) {
            prefetch("/knowledge/searches")();
            const searchId = search.get("searchId");
            if (searchId) prefetch(`/knowledge/searches/${searchId}`)();
          }
          return prefetch(
            params.draftId
              ? `/knowledge/drafts/${params.draftId}`
              : `/knowledge/library?${new URLSearchParams({ category: search.get("category") || "all", status: search.get("status") || "all", q: search.get("q") || "", page: String(Math.max(0, Number(search.get("page")) || 0)) })}`,
          )();
        },
      },
      {
        path: "/projects",
        element: <Projects />,
        loader: prefetch("/projects"),
      },
      {
        path: "/projects/:id",
        errorElement: <RouteError />,
        // Keep the failed lazy match (and its error UI) in the initial render branch.
        hydrateFallbackElement: <RouteLoading />,
        lazy: async () => ({
          Component: (await import("./screens/project-workspace"))
            .ProjectWorkspace,
        }),
        loader: ({ params, request }) => {
          prefetch(`/projects/${params.id}`)();
          const search = new URL(request.url).searchParams;
          const view = search.get("view");
          if (view === "feasibility")
            prefetch(`/feasibility/projects/${params.id}/${search.get("study") === "financial" && cachedFeatureEnabled("feasibility_financial_study") ? "study" : "site-assessment"}`)();
          if (view === "analytics")
            prefetch(`/knowledge/workspaces/${params.id}/analytics?page=0`)();
          if (view === "building-model")
            prefetch(`/projects/${params.id}/building-model`)();
          if (view === "overview")
            prefetch(`/projects/${params.id}/planning`)();
          return null;
        },
      },
      {
        path: "/customers",
        element: <Customers />,
        loader: prefetch("/crm/customers"),
      },
      {
        path: "/components",
        errorElement: <RouteError />,
        hydrateFallbackElement: <RouteLoading />,
        lazy: async () => ({
          Component: (await import("./screens/components")).Components,
        }),
        loader: ({ request }) => {
          const params = new URL(request.url).searchParams;
          return prefetch(
            `/components?${new URLSearchParams({
              q: params.get("q") || "",
              category: params.get("category") || "",
              reviewStatus: params.get("reviewStatus") || "",
              offset: String(Math.max(0, Number(params.get("offset")) || 0)),
            })}`,
          )();
        },
      },
      {
        path: "/components/:id",
        errorElement: <RouteError />,
        hydrateFallbackElement: <RouteLoading />,
        lazy: async () => ({
          Component: (await import("./screens/components"))
            .ComponentDetailScreen,
        }),
        loader: ({ params }) => prefetch(`/components/${params.id}`)(),
      },
      { path: "/team", element: <Team />, loader: prefetch("/access/team") },
      {
        path: "/settings",
        element: <Settings />,
        loader: prefetch("/settings/ai-connections"),
      },
      {
        path: "/help",
        errorElement: <RouteError />,
        hydrateFallbackElement: <RouteLoading />,
        lazy: async () => ({
          Component: (await import("./screens/help")).Help,
        }),
        loader: prefetch("/support"),
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
