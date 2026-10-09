import { expect, test } from "bun:test";
import {
  canEditConnection,
  getSelectedProvider,
  providerIds,
} from "../src/connection-policy";
test("missing encryption always fails closed, including administrators", () => {
  expect(canEditConnection(undefined, "personal")).toBe(false);
  expect(
    canEditConnection(
      { encryptionConfigured: false, canManageWorkspace: true },
      "personal",
    ),
  ).toBe(false);
  expect(
    canEditConnection(
      { encryptionConfigured: false, canManageWorkspace: true },
      "workspace",
    ),
  ).toBe(false);
});
test("members can manage personal credentials but not shared workspace credentials", () => {
  const member = { encryptionConfigured: true, canManageWorkspace: false };
  expect(canEditConnection(member, "personal")).toBe(true);
  expect(canEditConnection(member, "workspace")).toBe(false);
  expect(canEditConnection(member, "other")).toBe(false);
  expect(
    canEditConnection({ ...member, canManageWorkspace: true }, "workspace"),
  ).toBe(true);
});
test("workspace provider selection supports the gateway and defaults safely", () => {
  expect(providerIds).toEqual(["openai", "anthropic", "vercel"]);
  expect(getSelectedProvider()).toBe("openai");
  expect(
    getSelectedProvider({
      encryptionConfigured: true,
      canManageWorkspace: true,
      providers: [],
      selectedProvider: "vercel",
    }),
  ).toBe("vercel");
});
