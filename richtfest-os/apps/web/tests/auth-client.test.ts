import { expect, test } from "bun:test";
import {
  authResult,
  createAuthAttemptGate,
  isExpectedPasskeyError,
  signInWithConditionalPasskey,
  supportsConditionalPasskeys,
  supportsPasskeys,
} from "../src/lib/auth";
test("WebAuthn availability requires both a secure context and browser support", () => {
  expect(
    supportsPasskeys({ isSecureContext: false, PublicKeyCredential: class {} }),
  ).toBe(false);
  expect(supportsPasskeys({ isSecureContext: true })).toBe(false);
  expect(
    supportsPasskeys({ isSecureContext: true, PublicKeyCredential: class {} }),
  ).toBe(true);
});
test("official client result errors cannot be treated as completed enrollment", () => {
  const successfulClientResponse = { data: { id: "passkey-1" }, error: null };
  const deniedClientResponse = {
    data: null,
    error: { message: "NotAllowedError" },
  };
  expect(authResult(successfulClientResponse)).toEqual({ id: "passkey-1" });
  expect(() => authResult(deniedClientResponse)).toThrow("NotAllowedError");
});

test("conditional passkey detection requires the browser mediation API", () => {
  const base = {
    isSecureContext: true,
    PublicKeyCredential: class {},
    navigator: { credentials: { get() {} } },
  };
  expect(supportsConditionalPasskeys(base)).toBe(false);
  expect(
    supportsConditionalPasskeys({
      ...base,
      PublicKeyCredential: {
        isConditionalMediationAvailable: async () => true,
      },
    }),
  ).toBe(true);
});

test("expected passkey cancellation and unsupported errors stay quiet", () => {
  expect(isExpectedPasskeyError({ code: "AUTH_CANCELLED" })).toBe(true);
  expect(isExpectedPasskeyError({ name: "AbortError" })).toBe(true);
  expect(isExpectedPasskeyError({ message: "Passkeys are unsupported" })).toBe(
    true,
  );
  expect(isExpectedPasskeyError({ message: "The server rejected the user" })).toBe(
    false,
  );
});

test("a delayed conditional attempt cannot become current after submit or unmount", () => {
  const gate = createAuthAttemptGate();
  const startup = gate.begin();
  gate.invalidate();
  expect(gate.isCurrent(startup)).toBe(false);

  const afterSubmit = gate.begin();
  gate.invalidate();
  expect(gate.isCurrent(afterSubmit)).toBe(false);
});

test("conditional passkey flow consumes raw options and verifies the assertion", async () => {
  const rawOptions = {
    challenge: "Y2hhbGxlbmdl",
    rpId: "localhost",
    userVerification: "preferred",
    allowCredentials: [{ id: "aWQ", type: "public-key" as const }],
  };
  const requests: RequestInit[] = [];
  let credentialRequest: CredentialRequestOptions | undefined;
  const credential = {
    id: "credential-1",
    rawId: new Uint8Array([1]).buffer,
    response: {
      authenticatorData: new Uint8Array([2]).buffer,
      clientDataJSON: new Uint8Array([3]).buffer,
      signature: new Uint8Array([4]).buffer,
      userHandle: null,
    },
    type: "public-key",
    getClientExtensionResults: () => ({}),
  } as unknown as Credential;
  const result = await signInWithConditionalPasskey({
    signal: new AbortController().signal,
    isCurrent: () => true,
    fetchImpl: async (_input, init) => {
      requests.push(init || {});
      return new Response(
        requests.length === 1
          ? JSON.stringify(rawOptions)
          : JSON.stringify({ session: { id: "session-1" }, user: { id: "user-1" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
    credentialGetImpl: async (options) => {
      credentialRequest = options;
      return credential;
    },
  });

  const requestPublicKey = credentialRequest?.publicKey as PublicKeyCredentialRequestOptions;
  expect(requestPublicKey.allowCredentials).toEqual([]);
  expect((credentialRequest as CredentialRequestOptions & { mediation?: string }).mediation).toBe(
    "conditional",
  );
  expect(requestPublicKey.rpId).toBe("localhost");
  expect(requestPublicKey.userVerification).toBe("preferred");
  expect(requests).toHaveLength(2);
  expect(requests[1].method).toBe("POST");
  expect(result).toEqual({
    data: { session: { id: "session-1" }, user: { id: "user-1" } },
    error: null,
  });
});

test("explicit passkey flow preserves credentials and omits conditional mediation", async () => {
  const requests: RequestInit[] = [];
  let credentialRequest: CredentialRequestOptions | undefined;
  const result = await signInWithConditionalPasskey({
    conditional: false,
    signal: new AbortController().signal,
    isCurrent: () => true,
    fetchImpl: async (_input, init) => {
      requests.push(init || {});
      return new Response(
        requests.length === 1
          ? JSON.stringify({
              challenge: "Y2hhbGxlbmdl",
              allowCredentials: [{ id: "aWQ", type: "public-key" }],
            })
          : JSON.stringify({ session: { id: "session-1" } }),
        { status: 200 },
      );
    },
    credentialGetImpl: async (options) => {
      credentialRequest = options;
      return {
        id: "credential-1",
        rawId: new Uint8Array([1]).buffer,
        response: {
          authenticatorData: new Uint8Array([2]).buffer,
          clientDataJSON: new Uint8Array([3]).buffer,
          signature: new Uint8Array([4]).buffer,
          userHandle: null,
        },
        type: "public-key",
        getClientExtensionResults: () => ({}),
      } as unknown as Credential;
    },
  });

  expect((credentialRequest as CredentialRequestOptions & { mediation?: string }).mediation).toBe(
    undefined,
  );
  expect(
    (credentialRequest?.publicKey as PublicKeyCredentialRequestOptions)
      .allowCredentials,
  ).toHaveLength(1);
  expect(result.error).toBe(null);
});

test("conditional cancellation skips authentication and verification after delayed options", async () => {
  let current = true;
  let started = false;
  let requestCount = 0;
  const result = await signInWithConditionalPasskey({
    signal: new AbortController().signal,
    isCurrent: () => current,
    fetchImpl: async () => {
      requestCount += 1;
      current = false;
      return new Response(JSON.stringify({ challenge: "late" }), {
        status: 200,
      });
    },
    credentialGetImpl: async () => {
      started = true;
      throw new Error("should not start");
    },
  });

  expect(requestCount).toBe(1);
  expect(started).toBe(false);
  expect(result.error?.code).toBe("AUTH_CANCELLED");
});

test("cancelling a pending ceremony skips verification after it resolves", async () => {
  const controller = new AbortController();
  let current = true;
  let resolveCredential!: (value: Credential) => void;
  let verifyCalls = 0;
  const resultPromise = signInWithConditionalPasskey({
    signal: controller.signal,
    isCurrent: () => current,
    fetchImpl: async (_input, init) => {
      if (init?.method === "POST") verifyCalls += 1;
      return new Response(
        init?.method === "POST"
          ? JSON.stringify({ session: { id: "late" } })
          : JSON.stringify({ challenge: "Y2hhbGxlbmdl" }),
        { status: 200 },
      );
    },
    credentialGetImpl: () =>
      new Promise((resolve) => {
        resolveCredential = resolve;
      }),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  current = false;
  controller.abort();
  resolveCredential({
    id: "credential-1",
    rawId: new Uint8Array([1]).buffer,
    response: {
      authenticatorData: new Uint8Array([2]).buffer,
      clientDataJSON: new Uint8Array([3]).buffer,
      signature: new Uint8Array([4]).buffer,
      userHandle: null,
    },
    type: "public-key",
    getClientExtensionResults: () => ({}),
  } as unknown as Credential);

  const result = await resultPromise;
  expect(verifyCalls).toBe(0);
  expect(result.error?.code).toBe("AUTH_CANCELLED");
});
