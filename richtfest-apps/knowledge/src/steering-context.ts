import { conflict } from "./workspace";

const PREFIX = "richtfest-steering-v1:";
const MAX_BYTES = 20_000;

/** Legacy text remains the first clarification; never reconstruct chat history. */
export function steeringInstructions(saved: string | null | undefined): string[] {
  if (!saved) return [];
  if (saved.startsWith(PREFIX)) {
    try {
      const entries: unknown = JSON.parse(saved.slice(PREFIX.length));
      if (Array.isArray(entries) && entries.every(entry => typeof entry === "string")) return entries;
    } catch { /* Preserve an unrecognized legacy value verbatim. */ }
  }
  return [saved];
}

export function appendSteering(saved: string | null | undefined, instruction: string): string {
  const entries = steeringInstructions(saved);
  // Consecutive retries add no duplicate context; later reassertions remain ordered.
  if (entries.at(-1) !== instruction) entries.push(instruction);
  const encoded = PREFIX + JSON.stringify(entries);
  if (Math.max(Buffer.byteLength(encoded, "utf8"), Buffer.byteLength(formatSteering(encoded), "utf8")) > MAX_BYTES) {
    throw conflict("Saved steering context would exceed 20,000 UTF-8 bytes. No changes were saved. Start a new run with a consolidated request and the required source selection.");
  }
  return encoded;
}

export function formatSteering(saved: string | null | undefined): string {
  const entries = steeringInstructions(saved);
  return entries.length ? "Ordered human clarifications (oldest first). Preserve prior decisions and constraints; a later explicit correction supersedes only the conflicting earlier fact. Clarifications are attributed user guidance, not measured or approved evidence.\n"
    + entries.map((entry, index) => `[Clarification ${index + 1}]\n${entry}`).join("\n\n") : "";
}
