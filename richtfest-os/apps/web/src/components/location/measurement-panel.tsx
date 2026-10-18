import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { X } from "lucide-react";
import type {
  LocationContext,
  SceneMeasurement,
  SceneVector,
} from "@richtfest/shared";
import { useApi } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Badge, Callout, Field } from "../ui/primitives";
import { Switch } from "../ui/switch";
import { MeasurementNoiseAction } from "./site-workbench";

export function MeasurementPanel({
  projectId,
  context,
  points,
  saved,
  persisted,
  sceneDirty,
  baseRevision,
  busy,
  snap,
  onSnap,
  onClose,
  onAgain,
  onSave,
  onDelete,
}: {
  projectId: string;
  context: LocationContext;
  points: SceneVector[];
  saved?: SceneMeasurement;
  persisted: boolean;
  sceneDirty: boolean;
  baseRevision: number;
  busy: boolean;
  snap: boolean;
  onSnap: (value: boolean) => void;
  onClose: () => void;
  onAgain: () => void;
  onSave: (measurement: SceneMeasurement, revision: number) => Promise<number>;
  onDelete: (id: string, revision: number) => Promise<number>;
}) {
  const t = useT();
  const session = useApi("/auth/me");
  const canWrite = (
    session.data?.permissions ||
    session.data?.user?.permissions ||
    []
  ).includes("projects:write");
  const [id] = useState(() => saved?.id ?? crypto.randomUUID());
  const [description, setDescription] = useState(saved?.description ?? "");
  const [purpose, setPurpose] = useState<SceneMeasurement["purpose"]>(
    saved?.purpose ?? "general",
  );
  // Background refetches must not advance the revision underneath an open form.
  const [revision, setRevision] = useState(baseRevision);
  const write = useMutation({
    mutationFn: (remove: boolean) =>
      remove
        ? onDelete(id, revision)
        : onSave(
            {
              id,
              description: description.trim(),
              purpose,
              points: [points[0], points[1]],
              context: saved?.context ?? {
                siteId: context.siteId,
                crs: context.crs ?? "EPSG:25833",
                origin: context.origin,
                importedAt: context.importedAt,
              },
            },
            revision,
          ),
    onSuccess: setRevision,
  });
  const stored =
    persisted &&
    saved &&
    description.trim() === saved.description &&
    purpose === saved.purpose &&
    points.every((point, i) =>
      point.every((value, axis) => value === saved.points[i][axis]),
    );
  const pending = busy || write.isPending;
  return (
    <section className="location-measurement" aria-label={t("locationMeasure")}>
      <div className="location-measurement-heading">
        <strong>{t("locationMeasure")}</strong>
        {stored && (
          <Badge variant="outline">{t("locationMeasurementSaved")}</Badge>
        )}
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("close")}
          disabled={pending}
          onClick={onClose}
        >
          <X className="size-icon-sm" />
        </Button>
      </div>
      {points.length === 2 ? (
        <>
          <dl className="location-values" role="status">
            <dt>{t("locationDistance")}</dt>
            <dd>
              <strong>
                {Math.hypot(
                  ...points[0].map((n, i) => n - points[1][i]),
                ).toFixed(2)}{" "}
                m
              </strong>
            </dd>
            <dt>{t("locationHorizontal")}</dt>
            <dd>
              {Math.hypot(
                points[0][0] - points[1][0],
                points[0][2] - points[1][2],
              ).toFixed(2)}{" "}
              m
            </dd>
            <dt>{t("locationVertical")}</dt>
            <dd>{Math.abs(points[0][1] - points[1][1]).toFixed(2)} m</dd>
          </dl>
          <Field label={t("locationMeasurementDescription")}>
            <Input
              value={description}
              maxLength={500}
              placeholder={t("locationMeasurementExample")}
              disabled={!canWrite || pending}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <Field label={t("locationMeasurementPurpose")}>
            <NativeSelect
              value={purpose}
              disabled={!canWrite || pending}
              onChange={(event) =>
                setPurpose(event.target.value as SceneMeasurement["purpose"])
              }
            >
              {(["general", "neighbor", "access", "road", "rail"] as const).map(
                (value) => (
                  <option key={value} value={value}>
                    {t(`locationMeasurementPurpose_${value}`)}
                  </option>
                ),
              )}
            </NativeSelect>
          </Field>
          {canWrite && (
            <>
              {sceneDirty && (
                <p className="muted">{t("locationMeasurementSceneDirty")}</p>
              )}
              <Button
                size="sm"
                disabled={pending || (!!stored && !sceneDirty)}
                onClick={() => write.mutate(false)}
              >
                {t(
                  sceneDirty
                    ? "locationMeasurementSaveScene"
                    : "locationMeasurementSave",
                )}
              </Button>
              {saved && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => write.mutate(true)}
                >
                  {t("locationMeasurementDelete")}
                </Button>
              )}
            </>
          )}
          {write.isError && (
            <Callout tone="error">{write.error.message}</Callout>
          )}
          {stored && (purpose === "road" || purpose === "rail") && (
            <MeasurementNoiseAction
              projectId={projectId}
              context={context}
              measurement={saved}
            />
          )}
        </>
      ) : (
        <p role="status">
          {t(
            points.length === 1
              ? "locationMeasureSecond"
              : "locationMeasureFirst",
          )}
        </p>
      )}
      <p className="muted">{t("locationMeasureHint")}</p>
      <label className="location-measurement-snap">
        <Switch size="sm" checked={snap} onCheckedChange={onSnap} />
        {t("locationMeasureSnap")}
      </label>
      {points.length === 2 && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={onAgain}
        >
          {t("locationMeasureAgain")}
        </Button>
      )}
    </section>
  );
}
