import type { MappedNoiseSource } from "@richtfest/shared";
import type { useT } from "../../i18n";

type T = ReturnType<typeof useT>;

const dedicationKeys: Record<string, Parameters<T>[0]> = { "1301": "noiseRoadMotorway", "1303": "noiseRoadFederal", "1305": "noiseRoadState", "1306": "noiseRoadDistrict", "1307": "noiseRoadMunicipal", "9997": "noiseRoadPrivate", "9999": "noiseRoadOtherPublic" };
const railKeys: Record<string, Parameters<T>[0]> = { "1100": "noiseRailRailway", "1101": "noiseRailPassenger", "1102": "noiseRailFreight", "1103": "noiseRailOperational", "1104": "noiseRailSBahn", "1200": "noiseRailLightRail", "1201": "noiseRailTram", "1202": "noiseRailUBahn" };
export const roadClass = (code: string | null, t: T) => code ? (dedicationKeys[code] ? t(dedicationKeys[code]!) : code) : "—";
export const railClass = (codes: string[], t: T) => codes.length ? codes.map((code) => railKeys[code] ? t(railKeys[code]!) : code).join(", ") : "—";
export const mappedClass = (item: MappedNoiseSource, t: T) => item.kind === "road" ? roadClass(item.dedication, t) : railClass(item.categories, t);
export const mappedDetails = (item: MappedNoiseSource, t: T) => item.kind === "road"
  ? [item.traffic ? t("noiseTraffic").replace("{daily}", item.traffic.dailyTraffic.toLocaleString()).replace("{year}", String(item.traffic.year))
      + (item.traffic.heavyVehicles !== null && item.traffic.dailyTraffic > 0 ? ` · ${t("noiseHeavyShare").replace("{share}", (Math.round(item.traffic.heavyVehicles / item.traffic.dailyTraffic * 1000) / 10).toLocaleString())}` : "") : null,
    item.lanes ? t("noiseLanes").replace("{count}", String(item.lanes)) : null, item.carriagewayWidthM ? `${item.carriagewayWidthM} m` : null].filter(Boolean).join(" · ")
  : [item.name && item.routeNumbers.length ? `${t("noiseRoute")} ${item.routeNumbers.join(", ")}` : null, item.lines.join(", ") || null,
    item.tracks === "2000" ? t("noiseTracksDouble") : item.tracks === "1000" ? t("noiseTracksSingle") : null,
    item.electrified === true ? t("noiseElectrified") : item.electrified === false ? t("noiseNotElectrified") : null].filter(Boolean).join(" · ");
export const mappedName = (item: MappedNoiseSource, t: T) => item.kind === "road" ? [item.designation, item.name].filter(Boolean).join(" ") || t("noiseUnnamedRoad")
  : item.name || (item.routeNumbers.length ? `${t("noiseRoute")} ${item.routeNumbers.join(", ")}` : item.lines.join(", ") || t("noiseUnnamedRail"));
