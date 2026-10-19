import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
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
    // Plain JSON, or base64 of the JSON, optionally gzipped (a hosted variable has a length limit).
    const bytes = raw.trimStart().startsWith("{") ? null : Buffer.from(raw, "base64");
    const text = !bytes ? raw : (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8");
    const parsed = acousticNormPackSchema.safeParse(JSON.parse(text));
    // Report only the failing paths: the pack content itself stays out of logs.
    if (!parsed.success) console.error(`Acoustic norm pack is invalid: ${parsed.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
    else pack = parsed.data;
  }
  cached = { pack };
  return pack;
}
