import { lazy, Suspense, type ComponentProps } from "react";
import { useT } from "../../i18n";
import { ModuleLoadBoundary } from "../module-recovery";

const OpenUI = lazy(() => import("./openui"));

/** Isolate an unavailable renderer without unmounting the surrounding workspace. */
export function LazyOpenUI(props: ComponentProps<typeof OpenUI>) {
  const t = useT();
  return (
    <ModuleLoadBoundary>
      <Suspense fallback={<span>{t("loading")}</span>}>
        <OpenUI {...props} />
      </Suspense>
    </ModuleLoadBoundary>
  );
}
