import type { ProviderFetch } from "../../richtfest-os/apps/api/src/provider-runtime";

/**
 * Synthetic OpenAI-compatible output for browser acceptance of real provider
 * streaming. This is injected into createApp; it never makes a network call.
 */
export const browserFixtureOutput = {
  summary:
    "Streaming acceptance fixture: the proposed note is still being prepared for review. The text continues in measured chunks so browser QA can scroll away, select text, and cancel while the response is arriving. No engineering calculation was performed.",
  rationale:
    "Synthetic browser fixture used to exercise the real persisted run path.",
  citations: [],
  tools: [],
  artifact: {
    title: "Browser fixture: proposed review note",
    content:
      "This synthetic note was created by the browser streaming fixture. It remains a proposed draft and has not been approved.",
    type: "draft" as const,
  },
  openui: 'root = Callout("Synthetic streaming fixture. This proposed note requires human review; no calculation was performed.")',
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export function createBrowserFixtureProviderFetch(options: {
  chunkDelayMs?: number;
  chunkSize?: number;
} = {}): ProviderFetch {
  const chunkDelayMs = options.chunkDelayMs ?? 240;
  const chunkSize = options.chunkSize ?? 12;
  const encodedOutput = JSON.stringify(browserFixtureOutput);

  return async (_url, init) => {
    if (init.signal?.aborted) throw init.signal.reason;
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (offset >= encodedOutput.length) {
          controller.enqueue(
            new TextEncoder().encode("data: [DONE]\n\n"),
          );
          controller.close();
          return;
        }
        try {
          if (chunkDelayMs > 0) await sleep(chunkDelayMs, init.signal as AbortSignal);
          const delta = encodedOutput.slice(offset, offset + chunkSize);
          offset += delta.length;
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`,
            ),
          );
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() {
        // The injected fetch honors the same signal as a provider transport.
      },
    });

    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  };
}
