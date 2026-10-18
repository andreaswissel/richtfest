import type { FeatureFlagKey } from "@richtfest/shared";
import { queryClient, useApi } from "./query";

type Session = { featureFlags?: string[] } | undefined;

/** Per-user feature flags arrive with the `/auth/me` boot data; no separate request. */
export const sessionHasFeature = (session: Session, flag: FeatureFlagKey) =>
  !!session?.featureFlags?.includes(flag);

export const cachedFeatureEnabled = (flag: FeatureFlagKey) =>
  sessionHasFeature(queryClient.getQueryData<Session>(["/auth/me"]), flag);

export function useFeatureFlag(flag: FeatureFlagKey) {
  const session = useApi("/auth/me");
  return sessionHasFeature(session.isError ? undefined : (session.data as Session), flag);
}
