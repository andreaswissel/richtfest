import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AuthClientLoadError,
  getAuthClient,
  authResult,
  supportsPasskeys,
} from "../lib/auth";
import { api } from "../api";
import { queryClient, useApi, useWrite } from "../query";
import { useT } from "../i18n";
import { usePreferences } from "../store";
import { Page, PageHeader, Section } from "../components/layout";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { SettingsNavigation } from "../components/settings-navigation";
import {
  Badge,
  Callout,
  Empty,
  Field,
  Form,
  Modal,
  Segmented,
  Table,
} from "../components/ui/primitives";

export function Security() {
  const t = useT();
  const preferences = usePreferences();
  const status = useApi("/account/security");
  const password = useWrite("/account/security/password");
  const passkeys = useQuery({
    queryKey: ["security", "passkeys"],
    queryFn: async () =>
      authResult(await (await getAuthClient()).passkey.listUserPasskeys()),
  });
  const sessions = useQuery({
    queryKey: ["security", "sessions"],
    queryFn: async () =>
      authResult(await (await getAuthClient()).listSessions()),
  });
  const current = useQuery({
    queryKey: ["security", "current"],
    queryFn: async () => authResult(await (await getAuthClient()).getSession()),
  });
  const savePreference = useMutation({
    mutationFn: (body: {
      density?: "dense" | "normal";
      language?: "en" | "de";
      theme?: "light" | "dark";
    }) => api("/account/preferences", body, "PUT"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/auth/me"] });
    },
  });
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [remove, setRemove] = useState<string | null>(null);
  const operation = useMutation({
    mutationFn: async (action: {
      kind: "add" | "rename" | "remove" | "revoke" | "others";
      id?: string;
      name?: string;
    }) => {
      const client = await getAuthClient();
      if (action.kind === "add")
        return authResult(
          await client.passkey.addPasskey({ name: action.name }),
        );
      if (action.kind === "rename")
        return authResult(
          await client.passkey.updatePasskey({
            id: action.id!,
            name: action.name!,
          }),
        );
      if (action.kind === "remove")
        return authResult(
          await client.passkey.deletePasskey({ id: action.id! }),
        );
      if (action.kind === "revoke")
        return authResult(await client.revokeSession({ token: action.id! }));
      return authResult(await client.revokeOtherSessions());
    },
    onSuccess: () => {
      setEditing(null);
      setRemove(null);
      void queryClient.invalidateQueries({ queryKey: ["security"] });
    },
  });
  const clientLoadFailed = [
    passkeys.error,
    sessions.error,
    current.error,
    operation.error,
  ].some((error) => error instanceof AuthClientLoadError);
  const settingsLoadFailed =
    status.isError || passkeys.isError || sessions.isError || current.isError;
  return (
    <Page>
      <PageHeader
        eyebrow={t("settings")}
        title={t("accountSettings")}
        description={t("accountSettingsDescription")}
      />
      <SettingsNavigation />
      <Callout>{t("enrollmentHint")}</Callout>
      {(settingsLoadFailed || clientLoadFailed) && (
        <Callout tone="error">
          <p>
            {t(
              clientLoadFailed
                ? "accountSettingsCodeLoadFailed"
                : "accountSettingsLoadFailed",
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              status.isFetching ||
              passkeys.isFetching ||
              sessions.isFetching ||
              current.isFetching
            }
            onClick={() => {
              if (clientLoadFailed) {
                window.location.reload();
                return;
              }
              void status.refetch();
              void passkeys.refetch();
              void sessions.refetch();
              void current.refetch();
            }}
          >
            {t(clientLoadFailed ? "reloadApp" : "retry")}
          </Button>
        </Callout>
      )}
      <Section title={t("preferences")}>
        {savePreference.error && (
          <Callout tone="error">{savePreference.error.message}</Callout>
        )}
        <div className="settings-row">
          <span>{t("language")}</span>
          <Segmented
            value={preferences.language}
            onChange={(v) => {
              const language = v as "en" | "de";
              preferences.setLanguage(language);
              savePreference.mutate({ language });
            }}
            items={[
              { value: "en", label: "EN" },
              { value: "de", label: "DE" },
            ]}
          />
        </div>
        <div className="settings-row">
          <span>{t("density")}</span>
          <Segmented
            value={preferences.density}
            onChange={(v) => {
              const density = v as "dense" | "normal";
              preferences.setDensity(density);
              savePreference.mutate({ density });
            }}
            items={[
              { value: "dense", label: t("dense") },
              { value: "normal", label: t("normal") },
            ]}
          />
        </div>
        <div className="settings-row">
          <span>{t("appearance")}</span>
          <Segmented
            value={preferences.theme}
            onChange={(v) => {
              const theme = v as "light" | "dark";
              preferences.setTheme(theme);
              savePreference.mutate({ theme });
            }}
            items={[
              { value: "light", label: t("light") },
              { value: "dark", label: t("dark") },
            ]}
          />
        </div>
      </Section>
      <Section title={t("password")}>
        {status.data && (
          <div className="connection-form">
            <Badge>
              {status.data.passwordConfigured
                ? t("configured")
                : t("unconfigured")}
            </Badge>
            {status.data.emailVerified === true &&
            status.data.recentlyVerified === true &&
            !status.data.passwordConfigured ? (
              <Form
                label={t("setPassword")}
                pending={password.isPending}
                error={password.error}
                onSubmit={(form) =>
                  password.mutate({ newPassword: form.get("newPassword") })
                }
              >
                <Field
                  label={t("newPassword")}
                  hint={t("passwordRequirements")}
                >
                  <Input
                    required
                    name="newPassword"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    key={password.submittedAt}
                  />
                </Field>
              </Form>
            ) : (
              <Callout>
                {t("freshSessionRequired")}{" "}
                <Link to="/login">{t("signIn")}</Link>
              </Callout>
            )}
            {password.isSuccess && (
              <Callout tone="success">{t("passwordSaved")}</Callout>
            )}
          </div>
        )}
      </Section>
      <Section title={t("passkeys")}>
        {!supportsPasskeys() && <Callout>{t("passkeyUnavailable")}</Callout>}
        <Form
          label={t("addPasskey")}
          disabled={
            !supportsPasskeys() || clientLoadFailed || !passkeys.isSuccess
          }
          pending={operation.isPending}
          onSubmit={(form) => {
            if (supportsPasskeys())
              operation.mutate({
                kind: "add",
                name: String(form.get("name") || ""),
              });
          }}
        >
          <Field label={t("passkeyName")}>
            <Input name="name" required disabled={!supportsPasskeys()} />
          </Field>
        </Form>
        {passkeys.data?.length ? (
          <Table
            headers={[t("name"), t("manage")]}
            rows={passkeys.data.map((p) => ({
              id: p.id,
              cells: [
                p.name || t("passkey"),
                <div className="inline-actions">
                  <Button
                    variant="link"
                    disabled={clientLoadFailed}
                    onClick={() => setEditing({ id: p.id, name: p.name || "" })}
                  >
                    {t("rename")}
                  </Button>
                  <Button
                    variant="link"
                    disabled={clientLoadFailed}
                    onClick={() => setRemove(p.id)}
                  >
                    {t("removePasskey")}
                  </Button>
                </div>,
              ],
            }))}
          />
        ) : (
          passkeys.isSuccess && <Empty>{t("noPasskeys")}</Empty>
        )}
      </Section>
      {operation.error && !clientLoadFailed && (
        <Callout tone="error">{operation.error.message}</Callout>
      )}
      <Section
        title={t("activeSessions")}
        meta={
          <Button
            disabled={
              operation.isPending ||
              clientLoadFailed ||
              !sessions.isSuccess ||
              !current.isSuccess
            }
            onClick={() => operation.mutate({ kind: "others" })}
          >
            {t("revokeOthers")}
          </Button>
        }
      >
        {sessions.data && (
          <Table
            headers={[t("device"), t("status")]}
            rows={sessions.data.map((s) => ({
              id: s.id,
              cells: [
                s.userAgent || t("unknownDevice"),
                current.data?.session.id === s.id ? (
                  <Badge>{t("currentSession")}</Badge>
                ) : (
                  <Button
                    variant="link"
                    disabled={
                      operation.isPending ||
                      clientLoadFailed ||
                      !current.isSuccess
                    }
                    onClick={() =>
                      operation.mutate({ kind: "revoke", id: s.token })
                    }
                  >
                    {t("revokeSession")}
                  </Button>
                ),
              ],
            }))}
          />
        )}
      </Section>
      {editing && (
        <Modal title={t("renamePasskey")} onClose={() => setEditing(null)}>
          <Form
            label={t("save")}
            pending={operation.isPending}
            error={operation.error}
            onSubmit={(f) =>
              operation.mutate({
                kind: "rename",
                id: editing.id,
                name: String(f.get("name")),
              })
            }
          >
            <Field label={t("name")}>
              <Input name="name" required defaultValue={editing.name} />
            </Field>
          </Form>
        </Modal>
      )}
      {remove && (
        <Modal title={t("removePasskey")} onClose={() => setRemove(null)}>
          <div className="form">
            <Callout>{t("removePasskeyHint")}</Callout>
            <Button
              disabled={operation.isPending}
              onClick={() => operation.mutate({ kind: "remove", id: remove })}
            >
              {t("removePasskey")}
            </Button>
          </div>
        </Modal>
      )}
    </Page>
  );
}
