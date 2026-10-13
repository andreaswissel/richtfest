export type ProviderId = "openai" | "anthropic" | "vercel";

export const providerIds: ProviderId[] = ["openai", "anthropic", "vercel"];

export type ConnectionProviderId = ProviderId | "typesafe";
export const connectionProviderIds: ConnectionProviderId[] = [
  ...providerIds,
  "typesafe",
];
export function isConnectionProviderId(
  value: unknown,
): value is ConnectionProviderId {
  return (
    typeof value === "string" &&
    connectionProviderIds.includes(value as ConnectionProviderId)
  );
}
export type ProviderConnection = {
  provider: ConnectionProviderId;
  personal: { configured: boolean; updatedAt?: string | null };
  workspace: { configured: boolean; updatedAt?: string | null };
  server: { configured: boolean };
  effectiveSource: "personal" | "workspace" | "server" | null;
};
export type ConnectionsState = {
  encryptionConfigured: boolean;
  canManageWorkspace: boolean;
  providers: ProviderConnection[];
  /** Workspace-selected provider. Older API responses may omit this field. */
  selectedProvider?: ProviderId | null;
  provider?: ProviderId | null;
  activeProvider?: ProviderId | null;
  workspaceProvider?: ProviderId | null;
  workspaceSelectedProvider?: ProviderId | null;
  settings?: { provider?: ProviderId | null };
};

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && providerIds.includes(value as ProviderId);
}

export function getSelectedProvider(state?: ConnectionsState): ProviderId {
  const value =
    state?.selectedProvider ??
    state?.provider ??
    state?.activeProvider ??
    state?.workspaceProvider ??
    state?.workspaceSelectedProvider ??
    state?.settings?.provider;
  return isProviderId(value) ? value : "openai";
}

export function providerLabel(value: unknown) {
  if (value === "typesafe") return "TypeSafe (Jev)";
  if (value === "anthropic") return "Anthropic";
  if (value === "vercel") return "Vercel AI Gateway";
  return "OpenAI";
}
export function canEditConnection(
  state:
    | Pick<ConnectionsState, "encryptionConfigured" | "canManageWorkspace">
    | undefined,
  scope: string,
) {
  return (
    state?.encryptionConfigured === true &&
    (scope === "personal" ||
      (scope === "workspace" && state.canManageWorkspace === true))
  );
}
