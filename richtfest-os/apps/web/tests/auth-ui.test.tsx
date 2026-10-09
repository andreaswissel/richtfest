import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Login } from "../src/screens/auth";
import { Team } from "../src/screens/team";

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
