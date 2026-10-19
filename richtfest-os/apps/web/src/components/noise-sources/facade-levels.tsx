import { useState } from "react";
import { Link } from "react-router-dom";
import type { FacadeLevelSource, FacadeNoiseLevels } from "@richtfest/shared";
import { useApi } from "../../query";
import { useT } from "../../i18n";
import { Section } from "../layout";
import { Badge, Callout, Empty, Segmented, Table } from "../ui/primitives";

type T = ReturnType<typeof useT>;
const db = (value: number) => value.toFixed(1);
const unavailableKeys = {
  norm_pack_missing: "facadeLevelsNoPack", location_missing: "facadeLevelsNoLocation",
  placement_missing: "facadeLevelsNoPlacement", exterior_walls_missing: "facadeLevelsNoExterior",
} as const;
const statusKeys = {
  calculated: "facadeLevelsCalculated", imported: "facadeLevelsImported", missing_inputs: "facadeLevelsMissingInputs",
  no_geometry: "facadeLevelsNoGeometry", not_used: "facadeLevelsNotUsed",
} as const;
const issueKeys: Record<string, Parameters<T>[0]> = {
  missing_daily_traffic: "noiseInputDailyTraffic", missing_speed_limit: "noiseInputSpeedLimit", missing_rating_levels: "facadeLevelsRatingLevels",
  surface_not_defined_for_speed: "facadeLevelsSurfaceSpeed",
};
const noteKeys: Record<string, Parameters<T>[0]> = {
  standard_traffic: "facadeLevelsNoteStandardTraffic", heavy_share_split: "facadeLevelsNoteHeavyShare", reference_surface: "facadeLevelsNoteSurface",
  flat_gradient: "facadeLevelsNoteGradient", lanes_assumed: "facadeLevelsNoteLanes",
};
const defaultKeys: Record<string, Parameters<T>[0]> = { speedLimit: "facadeLevelsDefaultSpeed", laneWidth: "facadeLevelsDefaultLaneWidth", lanes: "facadeLevelsDefaultLanes" };
const limitationKeys = {
  free_propagation: "facadeLevelsLimitFree", flat_ground: "facadeLevelsLimitGround", no_reflections: "facadeLevelsLimitReflections",
  no_junction_correction: "facadeLevelsLimitJunctions", storey_height_assumed: "facadeLevelsLimitStorey",
  rail_imported_all_facades: "facadeLevelsLimitRail", turned_away_reduction: "facadeLevelsLimitTurnedAway",
  storeys_aligned_by_outline: "facadeLevelsLimitAligned", storey_plan_missing: "facadeLevelsLimitStoreyPlanMissing",
  storey_plan_not_aligned: "facadeLevelsLimitNotAligned", storey_level_missing: "facadeLevelsLimitStoreyLevel",
} as const;

const sourceLink = (projectId: string, sourceId: string) => `/projects/${projectId}?view=noise&source=${sourceId}`;

/** What went into a source's level: issues block it, notes and defaults are assumptions the planner reviews. */
function sourceBasis(source: FacadeLevelSource, t: T) {
  if (source.issues.length) return `${t("facadeLevelsMissing")}: ${source.issues.map((issue) => issueKeys[issue] ? t(issueKeys[issue]!) : issue).join(", ")}`;
  return [
    ...source.notes.map((note) => noteKeys[note] ? t(noteKeys[note]!) : note),
    ...source.defaults.map((item) => (defaultKeys[item.key] ? t(defaultKeys[item.key]!) : item.key).replace("{value}", String(item.value))),
  ].join(" · ") || "—";
}

/**
 * Road rating levels and relevant exterior noise levels per facade and storey,
 * calculated on the server from the noise sources and the placed plan. A draft:
 * every default and limitation is shown next to the numbers.
 */
export function FacadeLevels({ projectId }: { projectId: string }) {
  const t = useT();
  const query = useApi(`/projects/${projectId}/exterior-noise/facade-levels`);
  const data = query.data as FacadeNoiseLevels | undefined;
  const [storey, setStorey] = useState<string | null>(null);
  if (!data) return null;
  if (!data.available) return <Section title={t("facadeLevels")}>
    <Callout>{t(unavailableKeys[data.reason])}{" "}
      {data.reason !== "norm_pack_missing" && <Link className="underline underline-offset-2" to={`/projects/${projectId}?view=location`}>{t("facadeLevelsOpenLocation")}</Link>}
    </Callout>
  </Section>;
  const storeys = [...new Map(data.facades.map((facade) => [String(facade.storey.levelIndex), facade.storey])).values()];
  const shown = storey ?? String(storeys[0]?.levelIndex ?? 0);
  const storeyName = (item: (typeof storeys)[number]) => item.name || t("facadeLevelsStorey").replace("{level}", String(item.levelIndex));
  const facades = data.facades.filter((facade) => String(facade.storey.levelIndex) === shown);
  const nameOf = new Map(data.sources.map((source) => [source.id, source.name]));
  return <Section title={t("facadeLevels")} meta={<Badge variant="outline">{t("facadeLevelsDraft")}</Badge>}>
    <p className="muted text-ui-xs">
      {t("facadeLevelsBasis").replace("{rls}", data.editions.rls19).replace("{din}", data.editions.din4109)}{" "}
      {t("facadeLevelsPlacement").replace("{file}", data.placement.fileName ?? "—").replace("{page}", String(data.placement.page))}{" "}
      {data.placement.alignmentStatus !== "reviewed" && t("facadeLevelsPlacementApproximate")}{" "}
      {data.pages.length > 1 && t("facadeLevelsAlignedPages").replace("{pages}", data.pages.slice(1)
        .map((page) => `${page.storey?.name ?? "—"} (${page.fileName ?? "—"}, ${t("facadeLevelsPage").replace("{page}", String(page.page))})`).join(", "))}
    </p>
    <h3 className="site-section-title">{t("facadeLevelsSources")}</h3>
    {data.sources.length ? <Table headers={[t("noiseSourceName"), t("facadeLevelsStatus"), t("facadeLevelsTrafficDayNight"), t("facadeLevelsLineLevel"), t("facadeLevelsAssumptions")]}
      rows={data.sources.map((source) => ({ id: source.id, cells: [
        <Link className="underline underline-offset-2" to={sourceLink(projectId, source.id)}>{source.name}</Link>,
        <Badge variant={source.status === "calculated" || source.status === "imported" ? "outline" : "secondary"}>{t(statusKeys[source.status])}</Badge>,
        <span className="text-ui-xs">{source.emission
          ? `${Math.round(source.emission.day.hourlyTraffic)} / ${Math.round(source.emission.night.hourlyTraffic)} Kfz/h · ${t("facadeLevelsTrucks")} ${source.emission.day.truck1Pct + source.emission.day.truck2Pct} / ${source.emission.night.truck1Pct + source.emission.night.truck2Pct} % · ${source.emission.speedKmh.car} km/h`
          : "—"}</span>,
        <span className="text-ui-xs">{source.emission ? `${db(source.emission.day.lineLevelDb)} / ${db(source.emission.night.lineLevelDb)} dB` : "—"}</span>,
        <span className="facade-levels-wrap text-ui-xs muted">{sourceBasis(source, t)}</span>,
      ] }))} /> : <Empty>{t("noiseSourcesEmpty")}</Empty>}
    <div className="noise-toolbar">
      <h3 className="site-section-title">{t("facadeLevelsFacades")}</h3>
      {storeys.length > 1 && <Segmented items={storeys.map((item) => ({ value: String(item.levelIndex), label: storeyName(item) }))} value={shown} onChange={setStorey} />}
    </div>
    {facades.length ? <Table headers={[t("facadeLevelsFacade"), t("facadeLevelsRatingLevelsColumn"), t("facadeLevelsLaDay"), t("facadeLevelsLaNight"), t("facadeLevelsLaSleeping"), t("facadeLevelsBasisColumn")]}
      rows={facades.map((facade) => ({ id: facade.id, sort: [facade.compass, "", String(facade.level?.dayDb ?? -1), String(facade.level?.nightDb ?? -1), String(facade.level?.sleepingDb ?? -1), facade.basis], cells: [
        <span>{facade.compass} · <span className="muted text-ui-xs">{facade.wallName} · {t("facadeLevelsHeight").replace("{height}", String(facade.receiver.heightM))}</span></span>,
        <span className="facade-levels-wrap text-ui-xs muted">{facade.sources.map((item) => `${nameOf.get(item.sourceId) ?? "—"} ${db(item.dayDb)}/${db(item.nightDb)}`).join(" · ") || "—"}</span>,
        <span className="text-ui-xs">{facade.level ? db(facade.level.dayDb) : "—"}</span>,
        <span className="text-ui-xs">{facade.level ? db(facade.level.nightDb) : "—"}</span>,
        <strong className="text-ui-xs">{facade.level ? db(facade.level.sleepingDb) : "—"}</strong>,
        <Badge variant="outline">{t(facade.basis === "calculated" ? "facadeLevelsBasisCalculated" : facade.basis === "turned_away" ? "facadeLevelsBasisTurnedAway" : "facadeLevelsBasisNone")}</Badge>,
      ] }))} /> : <Empty>{t("facadeLevelsNoFacades")}</Empty>}
    <Callout>
      <strong>{t("facadeLevelsLimitationsTitle")}</strong>{" "}
      {data.limitations.map((item) => t(limitationKeys[item]).replace("{height}", String(data.storeyHeightM))).join(" ")}
    </Callout>
  </Section>;
}
