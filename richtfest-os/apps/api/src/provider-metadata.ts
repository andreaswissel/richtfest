import { createHash } from "node:crypto";
export const metadataHash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const appRevision = (): string | null => process.env.RAILWAY_GIT_COMMIT_SHA || null;
/** Keep model input and replay identity stable after JSONB round trips. */
export const serializeProviderInput = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
