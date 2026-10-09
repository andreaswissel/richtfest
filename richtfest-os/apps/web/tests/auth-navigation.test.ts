import { expect, test } from "bun:test";
import { safeReturnTo } from "../src/auth-navigation";
test("sign-in return path rejects external and ambiguous URLs", () => {
  for (const value of [
    null,
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/\nevil.test",
  ])
    expect(safeReturnTo(value)).toBe("/");
  expect(safeReturnTo("/projects/123?tab=sources#latest")).toBe(
    "/projects/123?tab=sources#latest",
  );
});
