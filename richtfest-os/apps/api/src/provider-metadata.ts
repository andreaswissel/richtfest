import { createHash } from "node:crypto";
export const metadataHash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const appRevision = (): string | null => process.env.RAILWAY_GIT_COMMIT_SHA || null;
