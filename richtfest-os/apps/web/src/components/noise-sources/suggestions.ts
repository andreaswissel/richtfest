import { useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { suggestNoiseSources, type MappedNoiseSource, type NoiseSuggestion } from "@richtfest/shared";
import { api } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { useSiteGeometry, type NoiseData } from "../location/site-geometry";
import type { SiteSuggestionDomain } from "../location/site-suggestions";
import { mappedClass, mappedName } from "./labels";

export type ScreenedNoiseSource = NoiseSuggestion & {
  /** Distance from the address point; it decided inclusion when the building distance lies beyond the radius. */
  addressDistanceMeters: number | null;
};

/**
 * Richtfest's screening proposal: mapped roads and railways not added yet that lie
 * within their class radius of the building, not a norm decision.
 */
export function useNoiseSuggestions(projectId: string) {
  const { geometry } = useSiteGeometry(projectId);
  const noise = useApi(`/projects/${projectId}/noise-sources`);
  const data = noise.data as NoiseData | undefined;
  const survey = data?.survey ?? null;
  const suggestions = useMemo<ScreenedNoiseSource[]>(() => {
    const added = new Set((data?.sources ?? []).map((source) => source.mapped?.ref).filter(Boolean));
    const items = [...(survey?.roads ?? []), ...(survey?.rail ?? [])].filter((item) => !added.has(item.ref));
    // Screening errs towards inclusion: a source qualifies when the building (placed plan or official footprint)
    // or the address point lies within its radius, since an approximate placement can be off by metres.
    const building = (item: MappedNoiseSource) => geometry?.distanceTo(item.axes) ?? null;
    return suggestNoiseSources(items, (item) => {
      const distances = [building(item), item.distanceMeters].filter((value): value is number => value !== null);
      return distances.length ? Math.min(...distances) : null;
    })
      .map((suggestion) => ({
        ...suggestion,
        distanceMeters: Math.round(building(suggestion.item) ?? suggestion.distanceMeters),
        addressDistanceMeters: suggestion.item.distanceMeters,
      }))
      .sort((a, b) => a.distanceMeters - b.distanceMeters);
  }, [data, survey, geometry]);
  const add = useMutation({
    mutationFn: async (refs: string[]) => {
      for (const mappedRef of refs) await api(`/projects/${projectId}/noise-sources`, { mappedRef });
    },
    onSettled: () => queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).startsWith(`/projects/${projectId}/`) }),
  });
  return { available: !!survey && !!(survey.roads || survey.rail), suggestions, reference: geometry?.reference ?? null, add };
}

/** Exterior noise as a site suggestion domain for 3D location. */
export function useNoiseSiteSuggestions(projectId: string): SiteSuggestionDomain {
  const t = useT();
  const { available, suggestions, reference, add } = useNoiseSuggestions(projectId);
  return {
    key: "noise",
    title: t("noiseSuggestedShort"),
    hint: `${t("noiseSuggestedHintShort")} ${noiseReferenceText(reference, t)}`,
    link: `/projects/${projectId}?view=noise&step=sources`,
    available,
    suggestions: suggestions.map(({ item, distanceMeters, radiusMeters, addressDistanceMeters }) => ({
      id: item.ref,
      axisId: item.ref,
      title: mappedName(item, t),
      detail: mappedClass(item, t),
      distanceMeters,
      reason: noiseReasonText(distanceMeters, radiusMeters, addressDistanceMeters, t),
    })),
    accept: (ids) => add.mutate(ids),
    accepting: add.isPending,
    error: add.error,
  };
}

type T = ReturnType<typeof useT>;
export const noiseReferenceText = (reference: "plan" | "footprint" | null, t: T) =>
  reference === "plan" ? t("noiseSuggestedFromPlan") : reference === "footprint" ? t("noiseSuggestedFromFootprint") : t("noiseSuggestedFromAddress");
export const noiseReasonText = (distance: number, radius: number, addressDistance: number | null, t: T) =>
  t("noiseSuggestedWithin").replace("{radius}", String(radius))
  + (distance > radius && addressDistance !== null ? ` · ${t("noiseSuggestedByAddress").replace("{distance}", String(addressDistance))}` : "");
