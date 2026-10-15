import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  acousticDatasetSchema,
  type AcousticScenarioInput,
} from "@richtfest/shared";
import { queryClient, useWrite } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Callout, Field } from "../ui/primitives";

type Adjustment = AcousticScenarioInput["adjustments"][number];

export function AcousticScenario({
  projectId,
  artifactId,
  revisionId,
  title,
  payload,
  approved,
  onCreated,
}: {
  projectId: string;
  artifactId: string;
  revisionId: string;
  title: string;
  payload: unknown;
  approved: boolean;
  onCreated: (artifactId: string, revisionId: string) => void;
}) {
  const t = useT();
  const parsed = useMemo(() => acousticDatasetSchema.safeParse(payload), [payload]);
  const [roomId, setRoomId] = useState("");
  const [scenarioTitle, setScenarioTitle] = useState("");
  const [reason, setReason] = useState("");
  const [edits, setEdits] = useState<
    Record<string, { edit: Omit<Adjustment, "value">; value: string }>
  >({});
  const save = useWrite(
    `/knowledge/artifacts/${artifactId}/calculation-scenarios`,
    (result) => {
      // The saved sheet is already in the response; do not blank the viewer for another fetch.
      queryClient.setQueryData([`/knowledge/artifacts/${result.artifact.id}`], {
        artifact: result.artifact, revisions: [result.revision], annotations: [],
      });
      onCreated(result.artifact.id, result.revision.id);
    },
  );
  if (!parsed.success) return null;
  const dataset = parsed.data;
  const input = dataset.receipt.input;
  const selectedId = roomId || input.inventory[0]?.roomId;
  const room = input.rooms.find((r) => r.room.id === selectedId);
  const changed = Object.values(edits);
  const numeric = (
    target: Adjustment["target"],
    id: string,
    field: Adjustment["field"],
    value: number,
    label: string,
  ) => {
    const key = JSON.stringify([selectedId, target, id, field]);
    return (
      <Field key={key} label={label}>
        <Input
          type="number"
          step={field === "count" ? "1" : "any"}
          required
          min={
            ["floorAreaM2", "areaM2"].includes(field)
              ? "0.000001"
              : field === "count"
                ? "1"
                : "0"
          }
          max={
            field === "levelDb"
              ? "150"
              : ["rwDb", "dnEWDb", "count"].includes(field)
                ? "100"
                : "1000000"
          }
          value={edits[key]?.value ?? String(value)}
          disabled={save.isPending}
          onChange={(event) =>
            setEdits((previous) => {
              const next = { ...previous };
              if (
                event.target.value !== "" &&
                Number(event.target.value) === value
              )
                delete next[key];
              else
                next[key] = {
                  edit: { roomId: selectedId!, target, id, field },
                  value: event.target.value,
                };
              return next;
            })
          }
        />
      </Field>
    );
  };
  return (
    <section className="grid gap-stack border-y py-cell">
      <h4 className="text-ui font-medium">{t("acousticScenarioTitle")}</h4>
      <p className="text-ui-xs text-muted-foreground">
        {t("acousticScenarioScope")}
      </p>
      {dataset.basedOn && (
        <Link
          className="text-ui-sm underline"
          to={`/projects/${projectId}?panel=artifacts&artifact=${dataset.basedOn.artifactId}&revision=${dataset.basedOn.revisionId}`}
        >
          {t("acousticScenarioBase")}
        </Link>
      )}
      {!approved ? (
        <Callout>{t("acousticScenarioNeedsReview")}</Callout>
      ) : (
        <details>
          <summary className="cursor-pointer text-ui-sm font-medium">
            {t("acousticScenarioEdit")}
          </summary>
          <form
            className="grid gap-stack py-cell"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                save.isPending ||
                changed.some(
                  (e) => !e.value.trim() || !Number.isFinite(Number(e.value)),
                )
              )
                return;
              save.mutate({
                expectedRevisionId: revisionId,
                title:
                  scenarioTitle.trim() ||
                  `${title.slice(0, 260)} · ${t("acousticScenarioVariant")}`,
                reason,
                adjustments: changed.map((e) => ({
                  ...e.edit,
                  value: Number(e.value),
                })),
              });
            }}
          >
            <Callout>{t("acousticScenarioNoModel")}</Callout>
            <Field label={t("acousticScenarioName")}>
              <Input
                maxLength={300}
                value={scenarioTitle}
                placeholder={`${title.slice(0, 260)} · ${t("acousticScenarioVariant")}`}
                onChange={(e) => setScenarioTitle(e.target.value)}
              />
            </Field>
            <Field label={t("acousticScenarioRoom")}>
              <NativeSelect
                value={selectedId}
                onChange={(e) => setRoomId(e.target.value)}
              >
                {input.inventory.map((item, index) => (
                  <option key={`${item.roomId}:${index}`} value={item.roomId}>
                    {item.roomId}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {!room ? (
              <Callout>{t("acousticScenarioMissing")}</Callout>
            ) : (
              <>
                {numeric(
                  "room",
                  room.room.id,
                  "floorAreaM2",
                  room.room.floorAreaM2,
                  `${t("acousticScenarioFloor")} · m²`,
                )}
                <h5 className="text-ui-sm font-medium">
                  {t("acousticScenarioFacades")}
                </h5>
                {room.facades.map((f) => (
                  <div key={f.id} className="grid gap-stack sm:grid-cols-2">
                    {numeric(
                      "facade",
                      f.id,
                      "areaM2",
                      f.areaM2,
                      `${f.id} · m²`,
                    )}
                    {numeric(
                      "noise",
                      f.id,
                      "levelDb",
                      f.noise.levelDb,
                      `${f.id} · La dB`,
                    )}
                  </div>
                ))}
                <h5 className="text-ui-sm font-medium">
                  {t("acousticScenarioElements")}
                </h5>
                {room.elements.map((e) => (
                  <div key={e.id} className="grid gap-stack sm:grid-cols-2">
                    {e.kind === "area" ? (
                      <>
                        {numeric(
                          "element",
                          e.id,
                          "areaM2",
                          e.areaM2,
                          `${e.id} · m²`,
                        )}
                        {numeric(
                          "element",
                          e.id,
                          "rwDb",
                          e.rwDb,
                          `${e.id} · Rw dB`,
                        )}
                      </>
                    ) : (
                      <>
                        {numeric(
                          "element",
                          e.id,
                          "dnEWDb",
                          e.dnEWDb,
                          `${e.id} · Dn,e,w dB`,
                        )}
                        {numeric(
                          "element",
                          e.id,
                          "count",
                          e.count,
                          `${e.id} · ${t("acousticScenarioCount")}`,
                        )}
                        {numeric(
                          "element",
                          e.id,
                          "openingAreaM2",
                          e.openingAreaM2,
                          `${e.id} · ${t("acousticScenarioOpening")} m²`,
                        )}
                      </>
                    )}
                  </div>
                ))}
              </>
            )}
            <Field label={t("acousticScenarioReason")}>
              <Input
                required
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <p className="text-ui-xs">
              {t("acousticScenarioChanges")}: {changed.length}
            </p>
            {save.error && <Callout tone="error">{save.error.message}</Callout>}
            <div className="flex flex-wrap gap-stack">
              <Button
                type="button"
                variant="outline"
                disabled={save.isPending || !changed.length}
                onClick={() => setEdits({})}
              >
                {t("acousticScenarioReset")}
              </Button>
              <Button
                type="submit"
                disabled={
                  save.isPending ||
                  !reason.trim() ||
                  changed.some(
                    (e) => !e.value.trim() || !Number.isFinite(Number(e.value)),
                  )
                }
              >
                {t("acousticScenarioCalculate")}
              </Button>
            </div>
          </form>
        </details>
      )}
    </section>
  );
}
