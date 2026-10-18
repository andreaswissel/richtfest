import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useT } from "../i18n";
import { Button } from "./ui/button";

export function AppUpdateButton({
  className = "mb-3 w-full justify-start",
}: {
  className?: string;
}) {
  const t = useT();
  // Keep the version that this tab loaded, not the first polling response.
  const [loadedVersion] = useState(() =>
    typeof document === "undefined"
      ? null
      : document.querySelector<HTMLMetaElement>('meta[name="richtfest-build"]')
          ?.content,
  );
  const version = useQuery({
    queryKey: ["app-build-version"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/version.json", {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error("Build version unavailable");
      const data = await response.json();
      if (typeof data?.version !== "string" || !data.version)
        throw new Error("Invalid build version");
      return data.version as string;
    },
    enabled: Boolean(loadedVersion),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: "always",
    retry: false,
    meta: { persist: false },
  });

  if (!loadedVersion || !version.data || version.data === loadedVersion)
    return null;

  return (
    <Button
      variant="outline"
      className={className}
      title={t("reloadForUpdates")}
      aria-label={t("newUpdatesAvailable")}
      onClick={() => location.reload()}
    >
      <RefreshCw aria-hidden="true" className="size-icon-sm" />
      <span className="app-update-label">{t("newUpdatesAvailable")}</span>
    </Button>
  );
}
