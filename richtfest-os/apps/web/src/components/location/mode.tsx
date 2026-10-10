import { useEffect, useState, type ComponentType } from "react";
import { useT } from "../../i18n";
import { Callout } from "../ui/primitives";

/** A subview import, not a Suspense boundary around route content. */
export function LocationMode({ projectId }: { projectId: string }) {
  const t = useT();
  const [Editor, setEditor] = useState<ComponentType<{
    projectId: string;
  }> | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void import("./editor")
      .then((module) => {
        if (active) setEditor(() => module.LocationEditor);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, []);
  return Editor ? (
    <Editor key={projectId} projectId={projectId} />
  ) : (
    <Callout tone={error ? "error" : "info"}>
      {t(error ? "locationWebgl" : "locationLoading")}
    </Callout>
  );
}
