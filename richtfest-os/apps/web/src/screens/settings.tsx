import { Link } from "react-router-dom";
import { Button } from "../components/ui/button";
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, list } from "../api";
import { queryClient, useApi } from "../query";
import { useT } from "../i18n";
import { Page, PageHeader, Section } from "../components/layout";
import { Input } from "../components/ui/input";
import {
  Badge,
  Callout,
  Field,
  Form,
  Segmented,
} from "../components/ui/primitives";
import { LoadState } from "./foundation";
import {
  canEditConnection,
  getSelectedProvider,
  isProviderId,
  providerIds,
  providerLabel,
  type ConnectionsState,
  type ProviderId,
} from "../connection-policy";
import { SupervisorPresets } from "../components/supervisor-presets";

export function Settings() {
  const t = useT();
  const query = useApi("/settings/ai-connections");
  const [scope, setScope] = useState("personal");
  const [provider, setProvider] = useState<ProviderId>("openai");
  const [activeProvider, setActiveProvider] = useState<ProviderId>("openai");
  const [key, setKey] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [saved, setSaved] = useState(false);
  const data = query.data as ConnectionsState | undefined;
  const providers = list(data?.providers);
  const selected = providers.find((p) => p.provider === provider);
  const encryptionReady = data?.encryptionConfigured === true;
  const canEdit = canEditConnection(data, scope);
  const configured =
    scope === "personal"
      ? selected?.personal?.configured
      : selected?.workspace?.configured;
  const mutation = useMutation({
    mutationFn: ({ remove = false }: { remove?: boolean }) =>
      api(
        `/settings/ai-connections/${provider}/${scope}`,
        remove ? {} : { apiKey: key },
        remove ? "DELETE" : "PUT",
      ),
    onSuccess: () => {
      setKey("");
      setConfirmRemove(false);
      setSaved(true);
      void queryClient.invalidateQueries({
        queryKey: ["/settings/ai-connections"],
      });
      void queryClient.invalidateQueries({ queryKey: ["/agent/readiness"] });
    },
  });
  const activeProviderMutation = useMutation({
    mutationFn: (nextProvider: ProviderId) =>
      api("/agent/settings", { provider: nextProvider }, "PUT"),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["/settings/ai-connections"],
      });
      void queryClient.invalidateQueries({ queryKey: ["/agent/readiness"] });
      void queryClient.invalidateQueries({ queryKey: ["/agent/presets"] });
    },
  });
  useEffect(() => {
    if (data) {
      const selectedProvider = getSelectedProvider(data);
      setActiveProvider(selectedProvider);
      if (provider !== selectedProvider) {
        setProvider(selectedProvider);
        setKey("");
        setSaved(false);
        setConfirmRemove(false);
        mutation.reset();
      }
    }
  }, [
    data?.selectedProvider,
    data?.provider,
    data?.activeProvider,
    data?.workspaceProvider,
    data?.workspaceSelectedProvider,
    data?.settings?.provider,
  ]);
  const change = (type: "scope" | "provider", value: string) => {
    if (type === "scope") setScope(value);
    else if (isProviderId(value)) setProvider(value);
    setKey("");
    setSaved(false);
    setConfirmRemove(false);
    mutation.reset();
  };
  return (
    <Page>
      <PageHeader
        eyebrow={t("settings")}
        title={t("aiConnections")}
        actions={
          <Button asChild>
            <Link to="/settings/security">{t("accountSettings")}</Link>
          </Button>
        }
        description={t("aiConnectionsDescription")}
      />
      <LoadState query={query} />
      {data && (
        <>
          {!encryptionReady && <Callout>{t("encryptionMissing")}</Callout>}
          <Section title={t("connectionStatus")}>
            <div className="provider-status-list">
              {providerIds.map((id) => {
                const row = providers.find((p) => p.provider === id);
                const source = row?.effectiveSource;
                return (
                  <div className="provider-status" key={id}>
                    <strong>{providerLabel(id)}</strong>
                    <Badge
                      tone={source && source !== "none" ? "success" : "neutral"}
                    >
                      {source && source !== "none"
                        ? t("configured")
                        : t("unconfigured")}
                    </Badge>
                    <span className="muted">
                      {t("effectiveCredential")} ·{" "}
                      {source === "personal"
                        ? t("personal")
                        : source === "workspace"
                          ? t("workspaceScope")
                          : t("noCredential")}
                    </span>
                    {activeProvider === id && (
                      <Badge tone="success">{t("activeProvider")}</Badge>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>
          <Section title={t("activeProvider")}>
            <div className="connection-form">
              <Field label={t("activeProvider")}>
                <Segmented
                  value={activeProvider}
                  onChange={(value) => {
                    if (
                      !isProviderId(value) ||
                      data.canManageWorkspace !== true
                    )
                      return;
                    setActiveProvider(value);
                    change("provider", value);
                    activeProviderMutation.mutate(value);
                  }}
                  items={providerIds.map((id) => ({
                    value: id,
                    label: providerLabel(id),
                  }))}
                />
              </Field>
              <p className="muted">{t("activeProviderHint")}</p>
              {data.canManageWorkspace !== true && (
                <Callout>{t("workspaceAdminOnly")}</Callout>
              )}
              {activeProviderMutation.error && (
                <Callout tone="error">
                  {activeProviderMutation.error.message}
                </Callout>
              )}
              {activeProviderMutation.isSuccess && (
                <Callout tone="success">{t("activeProviderSaved")}</Callout>
              )}
            </div>
          </Section>
          <Section title={t("manageConnection")}>
            <div className="connection-form">
              <Field label={t("credentialScope")}>
                <Segmented
                  value={scope}
                  onChange={(v) => change("scope", v)}
                  items={[
                    { value: "personal", label: t("personal") },
                    { value: "workspace", label: t("workspaceScope") },
                  ]}
                />
              </Field>
              <p className="muted">
                {scope === "personal"
                  ? t("personalCredentialHint")
                  : t("workspaceCredentialHint")}
              </p>
              <Field label={t("provider")}>
                <Segmented
                  value={provider}
                  onChange={(v) => change("provider", v)}
                  items={[
                    { value: "openai", label: "OpenAI" },
                    { value: "anthropic", label: "Anthropic" },
                    { value: "vercel", label: "Vercel AI Gateway" },
                  ]}
                />
              </Field>
              {scope === "workspace" && data.canManageWorkspace !== true && (
                <Callout>{t("workspaceAdminOnly")}</Callout>
              )}
              <Badge>{configured ? t("configured") : t("unconfigured")}</Badge>
              {canEdit && (
                <Form
                  label={
                    configured ? t("replaceCredential") : t("saveCredential")
                  }
                  pending={mutation.isPending}
                  error={mutation.error}
                  onSubmit={() => mutation.mutate({})}
                >
                  <Field
                    label={t("apiKey")}
                    hint={t(configured ? "apiKeyReplaceHint" : "apiKeyHint")}
                  >
                    <Input
                      type="password"
                      autoComplete="new-password"
                      name="apiKey"
                      required
                      placeholder={configured ? "••••••••••••" : undefined}
                      value={key}
                      onChange={(e) => {
                        setKey(e.target.value);
                        setSaved(false);
                      }}
                      spellCheck={false}
                    />
                  </Field>
                </Form>
              )}
              {saved && (
                <Badge tone="success" role="status">
                  {t("credentialSaved")}
                </Badge>
              )}
              {canEdit && configured && (
                <div className="remove-credential">
                  {!confirmRemove ? (
                    <Button
                      variant="link"
                      onClick={() => setConfirmRemove(true)}
                    >
                      {t("removeCredential")}
                    </Button>
                  ) : (
                    <Callout>
                      <p>{t("removeCredentialConfirm")}</p>
                      <div className="inline-actions">
                        <Button
                          disabled={mutation.isPending}
                          onClick={() => mutation.mutate({ remove: true })}
                        >
                          {t("removeCredential")}
                        </Button>
                        <Button
                          variant="link"
                          onClick={() => setConfirmRemove(false)}
                        >
                          {t("cancel")}
                        </Button>
                      </div>
                    </Callout>
                  )}
                </div>
              )}
              <p className="muted">{t("noProviderCall")}</p>
            </div>
          </Section>
          <SupervisorPresets provider={activeProvider} />
        </>
      )}
    </Page>
  );
}
