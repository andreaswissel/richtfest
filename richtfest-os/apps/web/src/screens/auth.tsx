import { useMutation } from "@tanstack/react-query";
import {
  authResult,
  cancelPasskeyCeremony,
  conditionalPasskeysAvailable,
  createAuthAttemptGate,
  getAuthClient,
  isExpectedPasskeyError,
  signInWithConditionalPasskey,
  supportsConditionalPasskeys,
  supportsPasskeys,
} from "../lib/auth";

import { safeReturnTo } from "../auth-navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Badge,
  Callout,
  Field,
  Form,
} from "../components/ui/primitives";
import { list } from "../api";
import { useT } from "../i18n";
import { queryClient, useApi, useWrite } from "../query";

export function AuthLayout({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <main className="login">
      <div className="login-story">
        <Link to="/" className="brand">
          <span className="brand-symbol">R</span> richtfest
          <span className="brand-dot">.</span>
        </Link>
        <div>
          <div className="eyebrow">Richtfest OS / 01</div>
          <h1>{t("loginTitle")}</h1>
          <p>{t("loginDescription")}</p>
        </div>
        <div className="blueprint" aria-hidden="true">
          <div />
          <div />
          <div />
          <span>01 — 02 — 03</span>
        </div>
        <footer>{t("workspace")}</footer>
      </div>
      <div className="login-form">
        <div className="login-box">
          <span className="eyebrow">Richtfest OS</span>
          <h2>{title}</h2>
          {children}
        </div>
      </div>
    </main>
  );
}
function signedIn() {
  queryClient.clear();
  window.location.assign("/");
}
export function Login() {
  const t = useT();
  const identities = useApi("/auth/dev-identities");
  const readiness = useApi("/auth/delivery-readiness");
  const [method, setMethod] = useState<"magic" | "password">("magic");
  const [email, setEmail] = useState("");
  const attemptGate = useRef(createAuthAttemptGate()).current;
  const passwordRef = useRef<HTMLInputElement>(null);
  const passkeyController = useRef<AbortController | null>(null);
  const callbackURL = safeReturnTo(
    typeof location === "undefined"
      ? null
      : new URLSearchParams(location.search).get("returnTo"),
  );

  const cancelPendingPasskey = useCallback(() => {
    passkeyController.current?.abort();
    cancelPasskeyCeremony();
    attemptGate.invalidate();
  }, [attemptGate]);

  const login = useMutation({
    mutationFn: async ({
      form,
      method,
      attempt,
    }: {
      form: FormData;
      method: "magic" | "password";
      attempt: number;
    }) => {
      if (!attemptGate.isCurrent(attempt)) return null;
      const client = await getAuthClient();
      if (!attemptGate.isCurrent(attempt)) return null;
      if (method === "magic")
        return authResult(
          await client.signIn.magicLink({
            email: String(form.get("email")),
            callbackURL,
            newUserCallbackURL: "/settings/security",
            errorCallbackURL: "/login?error=invalid_link",
          }),
        );
      return authResult(
        await client.signIn.email({
          email: String(form.get("email")),
          password: String(form.get("password")),
          callbackURL,
        }),
      );
    },
    onSuccess: (_, variables) => {
      if (
        variables.method === "password" &&
        attemptGate.isCurrent(variables.attempt)
      )
        window.location.assign(callbackURL);
    },
  });

  const passkeyLogin = useMutation({
    mutationFn: async ({ attempt }: { attempt: number }) => {
      const controller = new AbortController();
      passkeyController.current = controller;
      let result;
      try {
        result = await signInWithConditionalPasskey({
          signal: controller.signal,
          conditional: false,
          isCurrent: () => attemptGate.isCurrent(attempt),
        });
      } finally {
        if (passkeyController.current === controller)
          passkeyController.current = null;
      }
      if (!attemptGate.isCurrent(attempt))
        return { attempt, stale: true, cancelled: false, data: null };
      if (result.error) {
        if (isExpectedPasskeyError(result.error))
          return { attempt, stale: false, cancelled: true, data: null };
        throw new Error(result.error.message || t("passkeyFailed"));
      }
      return { attempt, stale: false, cancelled: false, data: result.data };
    },
    onSuccess: (result) => {
      if (
        !result.stale &&
        !result.cancelled &&
        attemptGate.isCurrent(result.attempt)
      ) {
        attemptGate.invalidate();
        window.location.assign(callbackURL);
      }
    },
  });

  useEffect(() => {
    if (method !== "magic" || !supportsConditionalPasskeys()) return;
    const attempt = attemptGate.begin();
    let active = true;
    const controller = new AbortController();
    passkeyController.current = controller;

    void (async () => {
      if (!(await conditionalPasskeysAvailable())) return;
      if (!active || !attemptGate.isCurrent(attempt)) return;
      const result = await signInWithConditionalPasskey({
        signal: controller.signal,
        isCurrent: () => active && attemptGate.isCurrent(attempt),
      });
      if (!active || !attemptGate.isCurrent(attempt)) return;
      if (!result.error && result.data) {
        attemptGate.invalidate();
        window.location.assign(callbackURL);
      }
    })().catch(() => {
      if (passkeyController.current === controller)
        passkeyController.current = null;
      // Conditional mediation is an optional enhancement. Email remains the
      // fallback for browsers, credentials, or providers that decline it.
    });

    return () => {
      active = false;
      if (passkeyController.current === controller)
        passkeyController.current = null;
      controller.abort();
      cancelPasskeyCeremony();
      cancelPendingPasskey();
    };
  }, [
    attemptGate,
    callbackURL,
    cancelPendingPasskey,
    method,
  ]);

  useEffect(
    () => () => {
      passkeyController.current?.abort();
      cancelPasskeyCeremony();
      attemptGate.invalidate();
    },
    [attemptGate],
  );

  const submitLogin = (form: FormData, method: "magic" | "password") => {
    cancelPendingPasskey();
    const attempt = attemptGate.begin();
    login.mutate({ form, method, attempt });
  };

  const invokePasskey = () => {
    if (!supportsPasskeys()) return;
    cancelPendingPasskey();
    const attempt = attemptGate.begin();
    passkeyLogin.mutate({ attempt });
  };

  const togglePassword = () => {
    const nextMethod = method === "magic" ? "password" : "magic";
    cancelPendingPasskey();
    login.reset();
    setMethod(nextMethod);
  };

  useEffect(() => {
    if (method === "password") passwordRef.current?.focus();
  }, [method]);

  const developmentLogin = useWrite("/auth/dev-login", signedIn);
  return (
    <AuthLayout title={t("signIn")}>
      <Form
        label={method === "magic" ? t("sendSignInLink") : t("signIn")}
        pending={login.isPending}
        error={login.error}
        onSubmit={(form) => submitLogin(form, method)}
      >
        <Field label={t("email")}>
          <Input
            autoFocus
            required
            name="email"
            type="email"
            autoComplete="username webauthn"
            value={email}
            onChange={(event) => setEmail(event.currentTarget.value)}
          />
        </Field>
        {method === "password" && (
          <Field label={t("password")}>
            <Input
              ref={passwordRef}
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
        )}
      </Form>
      <div className="auth-help">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={togglePassword}
          >
            {method === "password" ? t("useEmailLink") : t("signInWithPassword")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!supportsPasskeys() || passkeyLogin.isPending}
            onClick={invokePasskey}
          >
            {passkeyLogin.isPending ? t("saving") : t("usePasskey")}
          </Button>
        </div>
      </div>
      {method === "password" && (
        <p className="muted auth-help">{t("passwordSignInHint")}</p>
      )}
      {passkeyLogin.error && !isExpectedPasskeyError(passkeyLogin.error) && (
        <Callout tone="error">{passkeyLogin.error.message}</Callout>
      )}
      {login.isSuccess && method === "magic" && (
        <>
          <Callout>{t("magicLinkRequested")}</Callout>
          <DeliveryStatus
            status={readiness.data?.mode || readiness.data?.status}
          />
        </>
      )}
      {!login.isSuccess && readiness.data && (
        <DeliveryStatus
          status={
            readiness.data.mode ||
            readiness.data.status ||
            (readiness.data.localPreview
              ? "local_preview"
              : readiness.data.configured
                ? "configured"
                : "unconfigured")
          }
        />
      )}
      <p className="muted auth-help">{t("inviteOnlyHint")}</p>
      {list(identities.data, "identities").length > 0 && (
        <details className="development-access">
          <summary>{t("devLogin")}</summary>
          <p className="muted">{t("devNote")}</p>
          <div className="identity-list">
            {list(identities.data, "identities").map((user) => (
              <Button
                className="identity"
                disabled={developmentLogin.isPending}
                key={user.id || user.email}
                onClick={() => developmentLogin.mutate({ email: user.email })}
              >
                <span className="avatar">{user.name?.slice(0, 1) || "R"}</span>
                <span>
                  <strong>{user.name}</strong>
                  <small>{user.email}</small>
                </span>
                {user.role && <Badge>{user.role}</Badge>}
                <span>→</span>
              </Button>
            ))}
          </div>
          {developmentLogin.error && (
            <Callout tone="error">{developmentLogin.error.message}</Callout>
          )}
        </details>
      )}
    </AuthLayout>
  );
}
export function DeliveryStatus({ status }: { status?: string }) {
  const t = useT();
  return (
    <Callout>
      {status === "resend" || status === "configured" || status === "sent"
        ? t("deliveryConfigured")
        : status === "development_outbox" || status === "local_preview" || status === "preview"
          ? t("deliveryPreview")
          : status === "unconfigured"
            ? t("deliveryUnconfigured")
            : t("deliveryUnknown")}
    </Callout>
  );
}
