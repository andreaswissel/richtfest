import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Login } from "../src/screens/auth";
import { Team } from "../src/screens/team";
import { App } from "../src/app";

function render(screen: React.ReactNode, path: string, data: unknown) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData([path], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>{screen}</MemoryRouter>
    </QueryClientProvider>,
  );
}
test("sign-in asks for email only without exposing a disabled development chooser", () => {
  const html = render(<Login />, "/auth/dev-identities", []);
  expect(html).toContain('type="email"');
  expect(html).not.toContain('type="password"');
  expect(html).toContain("Send sign-in link");
  expect(html).not.toContain("Local development access");
});
test("sign-in recognizes the server's email delivery modes", () => {
  const configured = render(<Login />, "/auth/delivery-readiness", { configured: true, mode: "resend" });
  expect(configured).toContain("Email delivery is configured");
  expect(configured).not.toContain("has not confirmed");
  const preview = render(<Login />, "/auth/delivery-readiness", { configured: false, mode: "development_outbox" });
  expect(preview).toContain("Local email preview is enabled");
  expect(preview).not.toContain("has not confirmed");
  const missing = render(<Login />, "/auth/delivery-readiness", { configured: false, mode: "unconfigured" });
  expect(missing).toContain("not configured");
});
test("development identity chooser appears only with explicitly returned identities", () => {
  const html = render(<Login />, "/auth/dev-identities", [
    { id: "local", name: "Local user", email: "local@example.test" },
  ]);
  expect(html).toContain("Local development access");
  expect(html).toContain("local@example.test");
});
test("team member cannot see administrative invitation or role actions", () => {
  const html = render(<Team />, "/access/team", {
    canManageTeam: false,
    members: [],
    invitations: [],
    roles: [],
  });
  expect(html).not.toContain("Create invitation");
  expect(html).not.toContain("Manage member");
});
test("authorized team administrator can open invitation creation", () => {
  const html = render(<Team />, "/access/team", {
    canManageTeam: true,
    members: [],
    invitations: [],
    roles: [],
  });
  expect(html).toContain("Create invitation");
});

test("refresh keeps navigation visible but withholds protected content until authenticated", () => {
  const screen = (
    <Routes>
      <Route element={<App />}>
        <Route path="/" element={<p>Private project content</p>} />
      </Route>
    </Routes>
  );
  const pending = render(screen, "/dashboard", {
    projects: [{ name: "Cached project" }],
  });
  expect(pending).toContain('href="/projects"');
  expect(pending).toContain('aria-busy="true"');
  expect(pending).toContain('role="status"');
  expect(pending).not.toContain("Private project content");
  expect(pending).not.toContain("Cached project");
  expect(pending).not.toContain('aria-label="Sign out"');

  const authenticated = render(screen, "/auth/me", {
    user: { id: "user-1", name: "Verified user" },
  });
  expect(authenticated).toContain("Private project content");
  expect(authenticated).toContain("Verified user");
  expect(authenticated).toContain('aria-busy="false"');
});
