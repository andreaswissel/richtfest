import { z } from "zod";

const point = z.tuple([z.number().finite(), z.number().finite()]);
const ring = z.array(point).min(4).refine(points => points[0][0] === points.at(-1)![0] && points[0][1] === points.at(-1)![1], "Unclosed ring");
const polygon = z.array(ring).min(1);
export const publicFeature = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("building"), sourceId: z.string().min(1),
    geometry: z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(polygon).min(1) }),
    height: z.number().positive().nullable(), roof: z.string().nullable(), label: z.string(),
    modelId: z.string().nullable(), footprintDate: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("tree"), sourceId: z.string().min(1),
    geometry: z.object({ type: z.literal("Point"), coordinates: point }),
    height: z.number().positive().nullable(), crownDiameter: z.number().positive().nullable(), species: z.string(),
  }),
]);
export type PublicFeature = z.infer<typeof publicFeature>;
export type PublicDatasetMetadata = {
  publisher: string;
  metadataUrl: string;
  licence: string;
  licenceUrl: string;
  attribution: string;
  sourceUpdatedAt: string | null;
  surveyedAt: string | null;
  declaredCadence: string;
  coverageNote: string;
};
export type PublicDataSnapshot = {
  releases: {
    id: string; partitionId: string; datasetId: string; label: string;
    metadata: PublicDatasetMetadata; sourceUrl: string; retrievedAt: string; publishedAt: string;
    features: { revisionId: string; feature: PublicFeature }[];
  }[];
};
export type PublicDataUpdate = { partitionId: string; pinnedReleaseId: string; latestReleaseId: string };

/** Bounded status read for exact project pins; source metadata belongs to the pinned release. */
export type PublicReleaseStatus = {
  releaseId: string;
  label: string;
  metadata: PublicDatasetMetadata;
  publishedAt: string;
  retrievedAt: string;
  featureCount: number;
  checksum: string;
  sourceUrl: string;
  partition: {
    id: string;
    currentReleaseId: string | null;
    enabled: boolean;
    lastCheckedAt: string | null;
    lastSuccessAt: string | null;
    nextCheckAt: string;
    error: string | null;
  };
  stale: boolean;
};
export type PublicReleaseStatusResponse = {
  items: PublicReleaseStatus[];
  canRefreshProjectContext: boolean;
};

/**
 * A published traffic count imported from a file-only source (BASt, state road
 * authorities) into the public-data catalogue. Coordinates are [longitude, latitude].
 * `station` counts are points representing a counted section; `section` counts carry the section's line geometry.
 */
export type TrafficCountRecord = {
  sourceId: string;
  /** Human label of the source, e.g. "BASt Dauerzählstellen 2024". */
  label: string;
  sourceUrl: string;
  licence: string;
  release: string;
  year: number;
  stationId: string;
  /** Normalised road designation ("A 1", "B 4a", "L 593") when the source names one. */
  road: string | null;
  name: string | null;
  kind: "station" | "section";
  /** Higher wins between sources of the same year: state sections 3, BASt permanent stations 2, BASt SVZ points 1. */
  specificity: number;
  geometry: { type: "Point"; coordinates: [number, number] } | { type: "MultiLineString"; coordinates: Array<Array<[number, number]>> };
  /** Kfz/24h (DTV) and heavy vehicles/24h (SV, buses and lorries above 3.5 t). */
  dailyTraffic: number;
  heavyVehicles: number | null;
  /** RLS-19 inputs where published: hourly vehicles day (06–22) / night (22–06) and heavy-vehicle shares in percent. */
  hourly: { day: number | null; night: number | null; heavyShareDay: number | null; heavyShareNight: number | null; p1Day: number | null; p2Day: number | null; p1Night: number | null; p2Night: number | null };
  /** SHA-256 of the source file(s) the row was imported from, and when. */
  checksum: string;
  importedAt: string;
};
