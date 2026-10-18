import type { TrafficCountRecord } from "@richtfest/shared";
import { csvRows, dbfRecords, decodeLatin9, germanNumber, plainNumber, shpGeometries, utmToLonLat, xlsxRows, zipEntries, zipRead, type ShapeGeometry } from "./traffic-count-files";

/**
 * Traffic counts that are only published as files. Each source names its
 * files, licence and how specific its records are; its parser turns the files
 * into normalised records (Kfz/24h, heavy vehicles/24h, RLS-19 hourly values
 * where published) with WGS84 geometry. Nothing is interpolated or inferred:
 * rows without a count or a position are skipped and counted.
 */
export const IMPORTER_VERSION = "traffic-counts-1";

export type CountFile = { url: string; bytes: Buffer };
export type ParsedCount = {
  release: string; year: number; stationId: string; road: string | null; roadClass: string | null; name: string | null;
  sourceUrl: string; kind: TrafficCountRecord["kind"]; geometry: TrafficCountRecord["geometry"];
  dailyTraffic: number; heavyVehicles: number | null; hourly: TrafficCountRecord["hourly"];
};
export type CountSource = {
  id: string; label: string; publisher: string; licence: string; attribution: string; pageUrl: string;
  files: string[]; intervalDays: number; specificity: number;
  /** Yields a record per usable row and null per skipped row (no count, no position). */
  parse: (files: CountFile[]) => AsyncGenerator<ParsedCount | null>;
};

const noHourly: TrafficCountRecord["hourly"] = { day: null, night: null, heavyShareDay: null, heavyShareNight: null, p1Day: null, p2Day: null, p1Night: null, p2Night: null };
/** "L593", "B 4", "A  1", "S 177", "K5 (HS)" -> "L 593", "B 4", "A 1", "S 177", "K 5"; other text is not a designation. District qualifiers in brackets are dropped. */
export function normaliseRoad(value: string | null | undefined): string | null {
  const m = /^\s*([ABLKS])\s*0*(\d{1,4})\s*([A-Za-z]{0,2})\s*(\([^)]*\)?)?\s*$/.exec(value ?? "");
  return m ? `${m[1]} ${m[2]}${m[3]}` : null;
}
const count = (value: number | null) => value !== null && value > 0 && value < 1_000_000 ? Math.round(value) : null;
const share = (value: number | null) => value !== null && value >= 0 && value <= 100 ? value : null;
const hourly = (value: number | null) => value !== null && value >= 0 && value < 100_000 ? value : null;
/** Germany with a margin; anything else is a coordinate error in the source row. */
const inGermany = ([lon, lat]: [number, number]) => lon > 5.5 && lon < 15.5 && lat > 47.0 && lat < 55.2;
const point = (coordinates: [number, number]): TrafficCountRecord["geometry"] | null => inGermany(coordinates) ? { type: "Point", coordinates } : null;
/** Unique, stable station ids: a repeated source id gets "#2", "#3" in file order. */
const uniqueIds = () => { const seen = new Map<string, number>(); return (id: string) => { const n = (seen.get(id) ?? 0) + 1; seen.set(id, n); return n === 1 ? id : `${id}#${n}`; }; };

// --- BASt: automatic permanent count stations, annual results ---

async function* bastPermanent(files: CountFile[]): AsyncGenerator<ParsedCount | null> {
  const [file] = files;
  for (const row of csvRows(decodeLatin9(file!.bytes))) {
    const dailyTraffic = count(germanNumber(row.DTV_Kfz_MobisSo_Q));
    const geometry = point([germanNumber(row.Koor_WGS84_E) ?? NaN, germanNumber(row.Koor_WGS84_N) ?? NaN]);
    if (!row.DZ_Nr || !dailyTraffic || !geometry) { yield null; continue; }
    yield {
      release: "2024", year: 2024, stationId: row.DZ_Nr, road: normaliseRoad(`${row.Str_Kl} ${row.Str_Nr}${row.Str_Zus ?? ""}`), roadClass: row.Str_Kl || null,
      name: row.DZ_Name || null, sourceUrl: file!.url, kind: "station", geometry, dailyTraffic, heavyVehicles: count(germanNumber(row.DTV_SV_MobisSo_Q)),
      // BASt publishes M_t / M_n (Kfz/h, 06–22 / 22–06) and the heavy-vehicle share p for both periods, not the RLS-19 split into Lkw1/Lkw2.
      hourly: { ...noHourly, day: hourly(germanNumber(row.Mt)), night: hourly(germanNumber(row.Mn)), heavyShareDay: share(germanNumber(row.pMt)), heavyShareNight: share(germanNumber(row.pMn)) },
    };
  }
}

// --- BASt: Straßenverkehrszählung 2021, Autobahnen and Bundesstraßen ---

async function* bastSvz(files: CountFile[]): AsyncGenerator<ParsedCount | null> {
  for (const file of files) {
    let columns: Map<string, number> | null = null;
    for await (const row of xlsxRows(file.bytes, "Zeilenformat")) {
      if (!columns) { columns = new Map(row.map((name, i) => [name.trim(), i])); for (const name of ["Str", "TKZST", "DTV", "X_Koordinate", "Y_Koordinate"]) if (!columns.has(name)) throw new Error(`SVZ column ${name} missing`); continue; }
      const cell = (name: string) => row[columns!.get(name) ?? -1] ?? "", n = (name: string) => plainNumber(cell(name));
      const dailyTraffic = count(n("DTV")), x = n("X_Koordinate"), y = n("Y_Koordinate");
      // BASt states UTM zone 32 for all of Germany; eastern states therefore have eastings above 800 km.
      const geometry = x !== null && y !== null && x > 200_000 && x < 1_000_000 && y > 5_200_000 && y < 6_150_000 ? point(utmToLonLat(32, x, y)) : null;
      if (!cell("TKZST") || !dailyTraffic || !geometry) { yield null; continue; }
      const year = Number(cell("Jahr")) || 2021, ends = [cell("Anfang"), cell("Ende")].filter(Boolean);
      const road = normaliseRoad(cell("Str"));
      yield {
        release: "2021", year, stationId: cell("TKZST"), road, roadClass: road?.[0] ?? null, name: ends.length ? ends.join(" – ") : null,
        sourceUrl: file.url, kind: "station", geometry, dailyTraffic, heavyVehicles: count(n("DTVSV")),
        hourly: { day: hourly(n("Mt")), night: hourly(n("Mn")), heavyShareDay: share(n("pt")), heavyShareNight: share(n("pn")), p1Day: share(n("pL1t")), p2Day: share(n("pL2t")), p1Night: share(n("pL1n")), p2Night: share(n("pL2n")) },
      };
    }
    if (!columns) throw new Error("SVZ worksheet is empty");
  }
}

// --- State road authorities: Shapefiles of counted sections ---

async function shapefile(zip: Buffer, stem: RegExp) {
  const entries = zipEntries(zip), find = (ext: string) => entries.find(entry => stem.test(entry.name) && entry.name.toLowerCase().endsWith(ext));
  const [shp, dbf, prj, cpg] = [find(".shp"), find(".dbf"), find(".prj"), find(".cpg")];
  if (!shp || !dbf || !prj) throw new Error("Shapefile parts missing");
  const projection = (await zipRead(zip, prj)).toString("latin1");
  const zone = Number(/UTM_Zone_(\d{2})N/i.exec(projection)?.[1]);
  if (!/ETRS_1989|ETRS89/i.test(projection) || (zone !== 32 && zone !== 33)) throw new Error("Unexpected shapefile projection");
  const codepage = cpg ? (await zipRead(zip, cpg)).toString("latin1").trim() : null;
  const geometries = [...shpGeometries(await zipRead(zip, shp))], records = [...dbfRecords(await zipRead(zip, dbf), codepage)];
  if (geometries.length !== records.length) throw new Error("Shapefile geometry and attribute counts differ");
  const toLonLat = (geometry: ShapeGeometry): TrafficCountRecord["geometry"] | null => {
    if (geometry?.type !== "MultiLineString") return null;
    const lines = geometry.coordinates.map(line => line.map(([x, y]) => utmToLonLat(zone, x, y)));
    return lines.every(line => line.every(inGermany)) ? { type: "MultiLineString", coordinates: lines } : null;
  };
  return records.map((record, i) => ({ record, geometry: toLonLat(geometries[i]!) }));
}
const sectionCount = (base: Omit<ParsedCount, "kind" | "hourly" | "geometry">, geometry: TrafficCountRecord["geometry"] | null): ParsedCount | null =>
  geometry && base.dailyTraffic ? { ...base, kind: "section", geometry, hourly: noHourly } : null;

async function* nwValues(files: CountFile[]): AsyncGenerator<ParsedCount | null> {
  const [file] = files, id = uniqueIds();
  for (const { record, geometry } of await shapefile(file!.bytes, /VERKEHRSWERTE_line\./i)) {
    if (!record) { yield null; continue; }
    // NETZSTAND "20260331190000" dates the network; the values are the SVZ 2021 results (Straßen.NRW data description).
    const network = /^(\d{4})(\d{2})(\d{2})/.exec(record.NETZSTAND ?? "");
    if (!network) throw new Error("NW Verkehrswerte without network date");
    const road = normaliseRoad(record.STRBEZ);
    yield sectionCount({
      release: `${network[1]}-${network[2]}-${network[3]}`, year: 2021, stationId: id(`${record.ABS}/${record.ABSNR}/${plainNumber(record.VSTAT) ?? ""}`), road, roadClass: record.STRKL || road?.[0] || null,
      name: record.ZSTNR ? `Zählstelle ${record.ZSTNR}${record.VWGEM ? ` (${record.VWGEM})` : ""}` : record.VWGEM || null,
      sourceUrl: file!.url, dailyTraffic: count(plainNumber(record.DTVKFZA))!, heavyVehicles: count(plainNumber(record.DTVSVA)),
    }, geometry);
  }
}

async function* niSvz(files: CountFile[]): AsyncGenerator<ParsedCount | null> {
  const [file] = files, id = uniqueIds();
  for (const { record, geometry } of await shapefile(file!.bytes, /svz_zaehlst-bereiche_2021\./i)) {
    if (!record?.zstnr) { yield null; continue; }
    const road = normaliseRoad(record.strbez);
    yield sectionCount({
      release: "2021", year: 2021, stationId: id(`${(record.strbez ?? "").replace(/\s+/g, "")}:${record.zstnr}`), road, roadClass: record.strkl || road?.[0] || null, name: `Zählstelle ${record.zstnr}`,
      sourceUrl: file!.url, dailyTraffic: count(plainNumber(record.dtv21))!, heavyVehicles: count(plainNumber(record.dtvsv21)),
    }, geometry);
  }
}

async function* snSvz(files: CountFile[]): AsyncGenerator<ParsedCount | null> {
  const [file] = files, id = uniqueIds();
  for (const { record, geometry } of await shapefile(file!.bytes, /SVZ2021\./i)) {
    if (!record?.strasse) { yield null; continue; }
    const road = normaliseRoad(record.strasse), ends = [record.vnk_name, record.nnk_name].filter(Boolean);
    yield sectionCount({
      release: "2021", year: Number(record.jahr) || 2021, stationId: id(`${record.strasse.replace(/\s+/g, "")}:${record.vnk}-${record.nnk}:${record.vst}`), road, roadClass: record.klasse || road?.[0] || null,
      name: ends.length ? ends.join(" – ") : null, sourceUrl: file!.url, dailyTraffic: count(plainNumber(record.dtv_kfzges))!, heavyVehicles: count(plainNumber(record.dtv_sv)),
    }, geometry);
  }
}

export const countSources: CountSource[] = [
  {
    id: "bast-dz-2024", label: "BASt Dauerzählstellen 2024", publisher: "Bundesanstalt für Straßenwesen (BASt)", licence: "CC BY 4.0",
    attribution: "© Bundesanstalt für Straßenwesen (BASt), CC BY 4.0", pageUrl: "https://www.bast.de/DE/Themen/Digitales/HF_1/Massnahmen/verkehrszaehlung/zaehl_node.html",
    files: ["https://www.bast.de/DE/Themen/Digitales/HF_1/Massnahmen/verkehrszaehlung/Daten/2024_1/Jawe2024.csv?view=renderTcDataExportCSV&cms_strTyp=A"],
    intervalDays: 30, specificity: 2, parse: bastPermanent,
  },
  {
    id: "bast-svz-2021", label: "BASt Straßenverkehrszählung 2021", publisher: "Bundesanstalt für Straßenwesen (BASt)", licence: "CC BY 4.0",
    attribution: "© Bundesanstalt für Straßenwesen (BASt), CC BY 4.0", pageUrl: "https://www.bast.de/DE/Publikationen/Statistik/Verkehrsdaten/Manuelle-Zaehlung.html",
    files: [
      "https://www.bast.de/DE/Publikationen/Statistik/Verkehrsdaten/2021/Autobahnen-2021.xlsx?__blob=publicationFile&v=1",
      "https://www.bast.de/DE/Publikationen/Statistik/Verkehrsdaten/2021/Bundesstrassen-2021.xlsx?__blob=publicationFile&v=1",
    ],
    intervalDays: 30, specificity: 1, parse: bastSvz,
  },
  {
    id: "nw-verkehrswerte", label: "Straßen.NRW Verkehrswerte (SVZ 2021)", publisher: "Landesbetrieb Straßenbau Nordrhein-Westfalen", licence: "dl-de/by-2-0",
    attribution: "© Straßen.NRW, dl-de/by-2-0", pageUrl: "https://www.opengeodata.nrw.de/produkte/transport_verkehr/strassennetz/",
    files: ["https://www.opengeodata.nrw.de/produkte/transport_verkehr/strassennetz/Verkehrswerte_EPSG25832_Shape.zip"],
    intervalDays: 30, specificity: 3, parse: nwValues,
  },
  {
    id: "ni-svz-2021", label: "NLStBV SVZ 2021 Zählstellenbereiche", publisher: "Niedersächsische Landesbehörde für Straßenbau und Verkehr", licence: "NLStBV Nutzungsbedingungen (attribution required)",
    attribution: "© Niedersächsische Landesbehörde für Straßenbau und Verkehr (NLStBV)", pageUrl: "https://www.strassenbau.niedersachsen.de/",
    files: ["https://map.strassenbau.niedersachsen.de/zip/DE-NI-SBV_Downloadservice_SVZ_Zaehlstellenbereiche_2021.zip"],
    intervalDays: 30, specificity: 3, parse: niSvz,
  },
  {
    id: "sn-svz-2021", label: "LASuV Sachsen SVZ 2021", publisher: "Landesamt für Straßenbau und Verkehr Sachsen", licence: "dl-de/by-2-0",
    attribution: "© Landesamt für Straßenbau und Verkehr Sachsen, dl-de/by-2-0", pageUrl: "https://www.list.smwa.sachsen.de/gdi/download/opensbv-svz.xml",
    files: ["https://www.list.smwa.sachsen.de/gdi/download/DE-SN-SBV-SVZ2021.zip"],
    intervalDays: 30, specificity: 3, parse: snSvz,
  },
];
export const countSource = (id: string) => countSources.find(source => source.id === id);
