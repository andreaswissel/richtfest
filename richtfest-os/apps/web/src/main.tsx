import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { App } from "./app";
import { Login } from "./screens/auth";
import { Security } from "./screens/security";
import { Team } from "./screens/team";
import { Customers, Dashboard, Projects } from "./screens/foundation";
import { Settings } from "./screens/settings";
import { SettingsModels } from "./screens/settings-models";
import { SettingsAgents } from "./screens/settings-agents";
import { queryClient } from "./query";
import { api } from "./api";
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
  { path: "/login", element: <Login /> },
  {
    element: <App />,
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
      {
        path: "/help",
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
