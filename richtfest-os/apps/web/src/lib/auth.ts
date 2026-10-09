import {
  base64URLStringToBuffer,
  bufferToBase64URLString,
  WebAuthnAbortService,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

export class AuthClientLoadError extends Error {}

export const getAuthClient = async () => {
  try {
    return (await import("./auth-client")).authClient;
  } catch (cause) {
    throw new AuthClientLoadError("Sign-in could not load", { cause });
  }
};
export function authResult<T>(result: {
  data?: T | null;
  error?: { message?: string } | null;
}): T {
  if (result.error)
    throw new Error(result.error.message || "Authentication request failed");
  return result.data as T;
}
export function supportsPasskeys(
  environment: {
    isSecureContext?: boolean;
    PublicKeyCredential?: unknown;
  } = globalThis,
): boolean {
  return (
    environment.isSecureContext === true &&
    typeof environment.PublicKeyCredential !== "undefined"
  );
}

type ConditionalWebAuthnEnvironment = {
  isSecureContext?: boolean;
  PublicKeyCredential?: {
    isConditionalMediationAvailable?: () => Promise<boolean>;
  };
  navigator?: {
    credentials?: {
      get?: unknown;
    };
  };
};

export function supportsConditionalPasskeys(
  environment: ConditionalWebAuthnEnvironment = globalThis,
): boolean {
  return (
    supportsPasskeys(environment) &&
    typeof environment.PublicKeyCredential?.isConditionalMediationAvailable ===
      "function" &&
    typeof environment.navigator?.credentials?.get === "function"
  );
}

export async function conditionalPasskeysAvailable(
  environment: ConditionalWebAuthnEnvironment = globalThis,
): Promise<boolean> {
  if (!supportsConditionalPasskeys(environment)) return false;
  try {
    return await environment.PublicKeyCredential!.isConditionalMediationAvailable!();
  } catch {
    return false;
  }
}

export function isExpectedPasskeyError(error: unknown): boolean {
  if (!error) return false;
  const value =
    typeof error === "string"
      ? error
      : [
          (error as { code?: unknown }).code,
          (error as { name?: unknown }).name,
          (error as { message?: unknown }).message,
        ]
          .filter((part): part is string => typeof part === "string")
          .join(" ");
  return /auth[_ -]?cancelled|abort(?:error)?|notallowederror|not supported|unsupported|cancel/i.test(
    value,
  );
}

export function cancelPasskeyCeremony(): void {
  WebAuthnAbortService.cancelCeremony();
}

type ConditionalPasskeyResult = {
  data?: unknown | null;
  error?: { code?: string; message?: string } | null;
};

type CancellablePasskeyOptions = {
  conditional?: boolean;
  signal: AbortSignal;
  isCurrent: () => boolean;
  fetchImpl?: typeof fetch;
  credentialGetImpl?: (options: CredentialRequestOptions) => Promise<Credential | null>;
};

function conditionalPasskeyError(body: unknown, fallback: string) {
  const value = body as { code?: unknown; message?: unknown };
  return {
    data: null,
    error: {
      code: typeof value?.code === "string" ? value.code : "AUTH_FAILED",
      message:
        typeof value?.message === "string" ? value.message : fallback,
    },
  } satisfies ConditionalPasskeyResult;
}

export async function signInWithConditionalPasskey({
  signal,
  isCurrent,
  fetchImpl = fetch,
  conditional = true,
  credentialGetImpl = (options) => navigator.credentials.get(options),
}: CancellablePasskeyOptions): Promise<ConditionalPasskeyResult> {
  const optionsResponse = await fetchImpl(
    "/api/auth/passkey/generate-authenticate-options",
    { credentials: "include", signal },
  );
  const options = (await optionsResponse.json()) as PublicKeyCredentialRequestOptionsJSON & {
    code?: string;
    message?: string;
  };
  if (!optionsResponse.ok)
    return conditionalPasskeyError(options, "Passkey options were unavailable");
  if (!isCurrent())
    return {
      data: null,
      error: { code: "AUTH_CANCELLED", message: "Passkey sign-in cancelled" },
    };
  if (signal.aborted)
    return {
      data: null,
      error: { code: "AUTH_CANCELLED", message: "Passkey sign-in cancelled" },
    };

  const publicKey: PublicKeyCredentialRequestOptions = {
    ...options,
    challenge: base64URLStringToBuffer(options.challenge),
    allowCredentials: options.allowCredentials?.map((credential) => ({
      ...credential,
      id: base64URLStringToBuffer(credential.id),
      transports: credential.transports as unknown as AuthenticatorTransport[] | undefined,
    })),
  };
  const request: CredentialRequestOptions = {
    publicKey,
    signal,
  };
  if (conditional) {
    (request as CredentialRequestOptions & { mediation?: string }).mediation =
      "conditional";
    publicKey.allowCredentials = [];
  }
  const credential = await credentialGetImpl(request);
  if (!credential || signal.aborted || !isCurrent()) {
    return {
      data: null,
      error: { code: "AUTH_CANCELLED", message: "Passkey sign-in cancelled" },
    };
  }

  const publicCredential = credential as PublicKeyCredential;
  const assertion = publicCredential.response as AuthenticatorAssertionResponse;
  const response = {
    id: publicCredential.id,
    rawId: bufferToBase64URLString(publicCredential.rawId),
    response: {
      authenticatorData: bufferToBase64URLString(assertion.authenticatorData),
      clientDataJSON: bufferToBase64URLString(assertion.clientDataJSON),
      signature: bufferToBase64URLString(assertion.signature),
      userHandle: assertion.userHandle
        ? bufferToBase64URLString(assertion.userHandle)
        : undefined,
    },
    type: publicCredential.type,
    ...(publicCredential.authenticatorAttachment
      ? { authenticatorAttachment: publicCredential.authenticatorAttachment }
      : {}),
  };
  const verifyResponse = await fetchImpl(
    "/api/auth/passkey/verify-authentication",
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response }),
      signal,
    },
  );
  const verified = await verifyResponse.json();
  if (!verifyResponse.ok)
    return conditionalPasskeyError(
      verified,
      "Passkey sign-in could not be verified",
    );
  return signal.aborted || !isCurrent()
    ? {
        data: null,
        error: { code: "AUTH_CANCELLED", message: "Passkey sign-in cancelled" },
      }
    : { data: verified, error: null };
}

export type AuthAttemptGate = ReturnType<typeof createAuthAttemptGate>;

export function createAuthAttemptGate() {
  let revision = 0;
  return {
    begin() {
      return ++revision;
    },
    invalidate() {
      revision += 1;
    },
    isCurrent(attempt: number) {
      return attempt === revision;
    },
  };
}
