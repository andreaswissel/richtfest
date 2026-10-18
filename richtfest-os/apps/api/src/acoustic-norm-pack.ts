import { readFileSync } from "node:fs";
import { acousticNormPackSchema, type AcousticNormPack } from "@richtfest/shared";
import { env } from "./env";

/**
 * The licensed acoustic norm pack (RLS-19 and DIN 4109 numbers). It is
 * configured per environment, never committed, and never sent to clients;
 * calculations that need it report themselves unavailable without it.
 */
let cached: { pack: AcousticNormPack | null } | null = null;

export function acousticNormPack(): AcousticNormPack | null {
  if (cached) return cached.pack;
  const raw = env.ACOUSTIC_NORM_PACK ?? (env.ACOUSTIC_NORM_PACK_PATH ? readFileSync(env.ACOUSTIC_NORM_PACK_PATH, "utf8") : null);
  let pack: AcousticNormPack | null = null;
  if (raw) {
    const text = raw.trimStart().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const parsed = acousticNormPackSchema.safeParse(JSON.parse(text));
    // Report only the failing paths: the pack content itself stays out of logs.
    if (!parsed.success) console.error(`Acoustic norm pack is invalid: ${parsed.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
    else pack = parsed.data;
  }
  cached = { pack };
  return pack;
}
