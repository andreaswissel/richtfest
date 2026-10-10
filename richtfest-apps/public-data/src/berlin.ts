import { z } from "zod";
import { publicFeature, type PublicFeature } from "@richtfest/shared";
import { berlinSources } from "./catalogue";

export const IMPORTER_VERSION = "berlin-wfs-1";
export function sourceFor(connector: string) {
  const source = berlinSources.find(s => s.slug === connector);
  if (!source) throw new Error("Unsupported curated connector");
  return source;
}
export function sourceUrl(connector: string, bbox: number[], crs: string) {
  const source = sourceFor(connector);
  if (crs !== "EPSG:25833") throw new Error("Unsupported source CRS");
  const url = new URL(`https://gdi.berlin.de/services/wfs/${source.service}`);
  url.search = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature", typeNames: `${source.service}:${source.layer}`, outputFormat: "application/json", srsName: crs, bbox: [...bbox, crs].join(","), count: "10000", sortBy: "gisid A" }).toString();
  return url.href;
}
export async function readBody(response: Response): Promise<Uint8Array> {
  if (!response.body) throw new Error("Source body missing");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 10_000_000) throw new Error("Source exceeds bounded partition budget");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
const collection = z.object({
  type: z.literal("FeatureCollection"), numberMatched: z.number().int().nonnegative(),
  numberReturned: z.number().int().nonnegative(),
  crs: z.object({ properties: z.object({ name: z.string() }) }),
  features: z.array(z.object({ type: z.literal("Feature"), id: z.string().min(1), properties: z.record(z.unknown()), geometry: z.object({ type: z.string(), coordinates: z.unknown() }) })).max(10000),
});
const positive = (value: unknown) => {
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};
const text = (value: unknown) => typeof value === "string" ? value : null;
export function normalize(connector: string, bytes: Uint8Array): PublicFeature[] {
  const source = sourceFor(connector), input = collection.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (!/EPSG(?::|::|\/0\/)25833$/.test(input.crs.properties.name)) throw new Error("Unexpected source CRS");
  if (input.numberMatched !== input.features.length || input.numberReturned !== input.features.length) throw new Error("Incomplete source partition");
  const result = input.features.map(f => {
    const p = f.properties;
    if (!f.id.startsWith(`${source.layer}.`)) throw new Error("Unexpected source identity");
    if (source.kind === "building") {
      return publicFeature.parse({ kind: "building", sourceId: f.id,
        geometry: f.geometry.type === "Polygon" ? { type: "MultiPolygon", coordinates: [f.geometry.coordinates] } : f.geometry,
        height: positive(p.hoehe), roof: text(p.dachart_txt), label: [text(p.strasse), text(p.hnr)].filter(Boolean).join(" ") || "Building",
        modelId: text(p.gml_id), footprintDate: text(p.grundrissaktualitaet),
      });
    }
    return publicFeature.parse({ kind: "tree", sourceId: f.id, geometry: f.geometry, height: positive(p.baumhoehe), crownDiameter: positive(p.kronedurch), species: text(p.art_dtsch) ?? "" });
  });
  if (new Set(result.map(f => f.sourceId)).size !== result.length) throw new Error("Duplicate source identities");
  // Stable order makes transport ordering irrelevant to release identity.
  return result.sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
}
