import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { locationImageVersion, type LocationContext } from "@richtfest/shared";

/** Shared image cache for site viewers; object URLs belong to each mounted viewer. */
export function useSiteImage(projectId: string, context: LocationContext | null, path: string, enabled: boolean, error: string) {
  const version = context ? locationImageVersion(context) : "";
  const query = useQuery({
    queryKey: [`/projects/${projectId}/location/${path}`, version],
    queryFn: async () => {
      const response = await fetch(`/api/projects/${projectId}/location/${path}?v=${encodeURIComponent(version)}`, { credentials: "include" });
      if (!response.ok) throw new Error(error);
      return response.blob();
    },
    enabled: enabled && !!context,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
    meta: { persist: false },
  });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = query.data ? URL.createObjectURL(query.data) : null;
    setUrl(next);
    return () => { if (next) URL.revokeObjectURL(next); };
  }, [query.data]);
  return { ...query, url };
}
