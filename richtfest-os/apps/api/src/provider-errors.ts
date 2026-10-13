import { redactProviderDiagnosticText, sanitizeProviderDiagnostics } from "@richtfest/knowledge/deps";

/** Extract only the provider's error envelope, never an SDK message/stack/request. */
export function providerErrorDiagnostics(error: unknown, apiKey: string, input: unknown) {
  const privateText = new Set<string>(apiKey ? [apiKey] : []);
  const visited = new WeakSet<object>();
  const collect = (value: unknown) => {
    if (typeof value === "string" && value.length >= 8) {
      privateText.add(value);
      for (const line of value.split(/\r?\n/)) if (line.trim().length >= 12) privateText.add(line.trim());
    } else if (value && typeof value === "object" && !visited.has(value)) {
      visited.add(value);
      for (const child of Object.values(value)) collect(child);
    }
  };
  collect(input);
  const redact = (value: unknown) => {
    if (typeof value !== "string") return undefined;
    for (const text of privateText) value = (value as string).split(text).join("[redacted]");
    return redactProviderDiagnosticText(value as string);
  };
  let diagnostics: ReturnType<typeof sanitizeProviderDiagnostics> = {};
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const value = current as Record<string, any>;
    const headers = value.responseHeaders ?? value.response?.headers;
    const header = (key: string) => headers instanceof Headers ? headers.get(key)
      : headers && typeof headers === "object" ? Object.entries(headers).find(([name]) => name.toLowerCase() === key)?.[1] : undefined;
    let data = value.data;
    if (!data && typeof value.responseBody === "string" && value.responseBody.length <= 65536) {
      try { data = JSON.parse(value.responseBody); } catch { /* Never retain HTML/plaintext bodies. */ }
    }
    const envelope = data && typeof data === "object" ? data : {};
    const detail = envelope.error && typeof envelope.error === "object" ? envelope.error : envelope;
    diagnostics = { ...diagnostics, ...sanitizeProviderDiagnostics({
      providerCode: redact(detail.code), providerType: redact(detail.type),
      providerMessage: redact(detail.message ?? (typeof envelope.detail === "string" ? envelope.detail : undefined)),
      providerParam: redact(detail.param),
      providerRequestId: redact(header("x-request-id") ?? header("request-id") ?? envelope.request_id),
      transportCode: value.code,
    }) };
    current = value.cause;
  }
  return diagnostics;
}

/** Error reads are size- and time-bounded, even when an injected transport ignores abort. */
export async function readProviderError(response: Response, apiKey: string, input: unknown) {
  const reader = response.body?.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let data: unknown;
  try {
    data = await Promise.race([
      (async () => {
        if (!reader) return undefined;
        const decoder = new TextDecoder();
        let bytes = 0, text = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 65536) return undefined;
          text += decoder.decode(value, { stream: true });
        }
        return JSON.parse(text + decoder.decode());
      })(),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1000); }),
    ]);
  } catch { /* Preserve status and request ID even if the body cannot be decoded. */ }
  finally {
    clearTimeout(timer);
    void reader?.cancel().catch(() => undefined);
  }
  const diagnostics = providerErrorDiagnostics({ data, responseHeaders: response.headers }, apiKey, input);
  return { ...diagnostics, providerMessage: diagnostics.providerMessage ?? "The provider supplied no readable structured error message." };
}
