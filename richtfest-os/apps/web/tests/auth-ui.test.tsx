import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Login } from "../src/screens/auth";
import { Team } from "../src/screens/team";
import { App } from "../src/app";
import { Security } from "../src/screens/security";
import { AuthClientLoadError } from "../src/lib/auth";

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
  const configured = render(<Login />, "/auth/delivery-readiness", {
    configured: true,
    mode: "resend",
  });
  expect(configured).toContain("Email delivery is configured");
  expect(configured).not.toContain("has not confirmed");
  const preview = render(<Login />, "/auth/delivery-readiness", {
    configured: false,
    mode: "development_outbox",
  });
  expect(preview).toContain("Local email preview is enabled");
  expect(preview).not.toContain("has not confirmed");
  const missing = render(<Login />, "/auth/delivery-readiness", {
    configured: false,
    mode: "unconfigured",
  });
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

test("account security offers recovery without claiming a failed passkey list is empty", async () => {
  for (const error of [
    new AuthClientLoadError("Sign-in could not load"),
    new Error("Server unavailable"),
  ]) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false } },
    });
    try {
      for (const queryKey of [
        ["/account/security"],
        ["security", "passkeys"],
        ["security", "sessions"],
        ["security", "current"],
      ]) {
        await client
          .fetchQuery({ queryKey, queryFn: () => Promise.reject(error) })
          .catch(() => undefined);
      }
      const html = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <Security />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      expect(html).toContain(
        error instanceof AuthClientLoadError ? "Reload app" : "Try again",
      );
      expect(html).not.toContain(error.message);
      expect(html).not.toContain("No passkeys registered.");
      expect(html).toMatch(
        /<button[^>]*disabled=""[^>]*>Sign out other sessions<\/button>/,
      );
    } finally {
      client.clear();
    }
  }
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
