import { z } from "zod";
import { mappedNoiseSourceSchema } from "./noise-sources";

export const environmentSurveySchema = z.object({
  id: z.string().uuid(), fileId: z.string().uuid(), versionId: z.string().uuid(), projectId: z.string().uuid(),
  connectorVersion: z.string(), cacheKey: z.string(), retrievedAt: z.string(), downloadUrl: z.string(),
  site: z.object({ siteId: z.string(), address: z.string(), latitude: z.number(), longitude: z.number(), revision: z.number() }),
  scope: z.object({ radiusMeters: z.literal(1000), bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]), purpose: z.literal("planning_context") }),
  categories: z.array(z.object({
    category: z.enum(["roads", "rail", "industry", "ground_aviation", "flightpaths", "noise_contours"]),
    status: z.enum(["findings", "no_features_in_query", "unavailable", "not_checked"]),
    featureCount: z.number().int().nonnegative(),
    observations: z.array(z.object({ id: z.string(), kind: z.string(), name: z.string().nullable() })),
    coverage: z.object({ limit: z.number(), returned: z.number(), matched: z.number().nullable(), truncated: z.boolean() }),
    sources: z.array(z.object({ url: z.string().url(), retrievedAt: z.string(), sha256: z.string().nullable() })),
    selectionPolicy: z.object({ version: z.literal(1), provider: z.literal("Fraport FRAMAP"), scope: z.literal("published_standard_day_night_Leq_contour_catalog"), rule: z.literal("latest_year_discovered_in_retrieved_provider_catalog"), selectedYear: z.number().int(), discoveredYears: z.array(z.number().int()), globalLatestClaim: z.literal(false), retrievedGeometryYears: z.array(z.number().int()), historicalPractice: z.object({ origin: z.literal("planner_guidance"), affectedYears: z.tuple([z.literal(2020), z.literal(2021), z.literal(2022), z.literal(2023)]), year: z.literal(2019), reason: z.literal("pre_COVID_historical_comparison"), automaticSelection: z.literal(false), engineeringApproval: z.literal(false) }) }).optional(),
    spatial: z.object({ status: z.enum(["checked", "unavailable"]), siteLevelDbA: z.null(), method: z.literal("published_contour_geometry_extent"), layers: z.array(z.object({ theme: z.string(), year: z.number(), period: z.enum(["day", "night"]), metric: z.literal("Leq"), srid: z.literal(8307), extent: z.tuple([z.number(), z.number(), z.number(), z.number()]), geometryCount: z.number(), publishedLevelsDbA: z.array(z.number()), levelAttributesComplete: z.boolean(), relation: z.enum(["outside_published_contour_extent", "within_extent_unresolved"]) })) }).optional(),
    catalog: z.object({ status: z.enum(["retrieved", "unavailable"]), spatialEvidence: z.literal(false), layers: z.array(z.object({ theme: z.string(), year: z.number(), period: z.enum(["day", "night"]), metric: z.literal("Leq") })) }).optional(),
    /** Roads or railways grouped from the mapped axes, nearest first (roads and rail only). */
    mapped: z.array(mappedNoiseSourceSchema).max(150).optional(),
    limitations: z.array(z.string()),
  })),
  engineeringApproval: z.literal(false), noiseMetrics: z.literal("unknown"), limitations: z.array(z.string()),
});
export type EnvironmentSurvey = z.infer<typeof environmentSurveySchema>;
