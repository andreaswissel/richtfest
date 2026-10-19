import { analysePlanFile } from "./plan-extraction";
import type { WallColourLegend } from "./plan-topology";

// Worker-thread entry: one plan page per worker. The parent terminates the
// worker on abort or timeout, which also stops this computation.
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<{ path: string; page: number; colourLegend?: WallColourLegend; scaleDenominator?: number | null }>) => void) | null; postMessage(message: unknown): void };
scope.onmessage = async event => {
  try { scope.postMessage({ ok: true, result: await analysePlanFile(event.data.path, event.data.page, new AbortController().signal, { colourLegend: event.data.colourLegend, scaleDenominator: event.data.scaleDenominator }) }); }
  catch (error) { scope.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) }); }
};
