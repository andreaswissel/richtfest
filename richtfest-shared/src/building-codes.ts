/**
 * Landesbauordnungen as a versioned rule table: the figures the deterministic site tools need, per Bundesland, each
 * with the paragraph it comes from. Only rules marked `verified` (read in an official text, see `sourceNote`) and not
 * `unsupported` feed calculations; everything else is shown as "not captured" so a person enters the value instead of
 * trusting a guess. Bump BUILDING_CODES_VERSION with every change.
 */
export const BUILDING_CODES_VERSION = "lbo_2026-10-18" as const;

export const BUNDESLAENDER = ["BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH"] as const;
export type Bundesland = (typeof BUNDESLAENDER)[number];

/** `unsupported` names why the site tools cannot apply a verified rule as modelled (e.g. depths by building class). */
export type CodeRule<T> = T & { cite: string; verified: boolean; note?: string; unsupported?: string };
export type SetbackRule = CodeRule<{ factor: number; minimum: number; commercialFactor: number | null; commercialMinimum: number | null }>;
/** Abstandsflächen may extend onto public traffic, green or water areas, up to their centre where `extent` says so. */
export type PublicSpaceRule = CodeRule<{ allowed: boolean; extent: "centre" | null }>;
/** Garages and buildings without habitable rooms allowed in Abstandsflächen without their own (Nebengebäude). */
export type AncillaryRule = CodeRule<{ maxWallHeight: number; maxLengthPerBoundary: number | null; maxTotalLength: number | null }>;
/** Projections (balconies, bay windows) disregarded for the Abstandsfläche. */
export type ProjectionRule = CodeRule<{ maxWallShare: number | null; maxProjection: number; minBoundaryDistance: number | null }>;
/**
 * When a storey counts as a Vollgeschoss. `floor_below`: the top (Staffel) storey from `share` of the floor below with
 * `height`; `own_area`: any storey with `height` over `share` of its own area (no separate Staffel rule, so a recessed
 * storey of full height still counts); `every_storey`: every storey above terrain counts. `heightMeasure` says whether
 * `height` is a clear height or measured floor to floor.
 */
export type StoreyRule = CodeRule<{ basis: "floor_below" | "own_area" | "every_storey"; share: number | null; height: number | null; heightMeasure: "clear" | "storey"; equalityCounts: boolean; terrainAbove: number | null }>;

export type BuildingCode = {
  jurisdiction: Bundesland;
  name: string;
  abbreviation: string;
  /** Version of the text the rules were read from, as stated by the source. */
  stand: string | null;
  sourceUrl: string;
  /** Which official text was read, and its limits (e.g. a non-binding reading version). */
  sourceNote: string;
  setback: SetbackRule | null;
  publicSpace: PublicSpaceRule | null;
  ancillary: AncillaryRule | null;
  projections: ProjectionRule | null;
  storey: StoreyRule | null;
};
export type BuildingCodeTopic = "setback" | "publicSpace" | "ancillary" | "projections" | "storey";
export const BUILDING_CODE_TOPICS: BuildingCodeTopic[] = ["setback", "publicSpace", "ancillary", "projections", "storey"];

const centre = (cite: string, note?: string): PublicSpaceRule => ({ allowed: true, extent: "centre", cite, verified: true, ...(note ? { note } : {}) });

export const BUILDING_CODES: Record<Bundesland, BuildingCode> = {
  BW: {
    jurisdiction: "BW", name: "Landesbauordnung für Baden-Württemberg", abbreviation: "LBO BW",
    stand: "Neufassung vom 16.03.2026 (GBl. 2026 Nr. 44)",
    sourceUrl: "https://www.landtag-bw.de/resource/blob/630398/aeb954506a74608b1adc87d8afc400dd/GBl2026044.pdf",
    sourceNote: "Official Gesetzblatt republication; later amendments not checked.",
    setback: { factor: 0.4, minimum: 2.5, commercialFactor: 0.125, commercialMinimum: 2.5, cite: "LBO BW § 5 Abs. 7", verified: true, note: "0.2 H in MK, MD, MDW, MU and WB; minimum 2 m for walls up to 5 m wide." },
    publicSpace: centre("LBO BW § 5 Abs. 2", "Up to the centre only where the area can be built on from both sides."),
    ancillary: { maxWallHeight: 3, maxLengthPerBoundary: 9, maxTotalLength: 15, cite: "LBO BW § 6 Abs. 1", verified: true, note: "Wall area up to 25 m²." },
    projections: { maxWallShare: null, maxProjection: 1.5, minBoundaryDistance: 2, cite: "LBO BW § 5 Abs. 6 Nr. 2", verified: true, note: "Each projection at most 5 m wide instead of a share of the wall." },
    storey: { basis: "floor_below", share: 3 / 4, height: 2.3, heightMeasure: "storey", equalityCounts: true, terrainAbove: 1.4, cite: "LBO BW § 2 Abs. 6", verified: true },
  },
  BY: {
    jurisdiction: "BY", name: "Bayerische Bauordnung", abbreviation: "BayBO",
    stand: "Fassung vom 14.08.2007, gültig ab 01.05.2026",
    sourceUrl: "https://www.gesetze-bayern.de/Content/Document/BayBO-6",
    sourceNote: "Official portal gesetze-bayern.de; the Vollgeschoss definition kept by Art. 83 Abs. 6 read from the ministry's text of the former Art. 2 Abs. 5.",
    setback: { factor: 0.4, minimum: 3, commercialFactor: 0.2, commercialMinimum: 3, cite: "BayBO Art. 6 Abs. 5", verified: true, note: "Towns over 250,000 inhabitants may require 1 H (Art. 6 Abs. 5a)." },
    publicSpace: centre("BayBO Art. 6 Abs. 2"),
    ancillary: { maxWallHeight: 3, maxLengthPerBoundary: 9, maxTotalLength: 15, cite: "BayBO Art. 6 Abs. 7", verified: true },
    projections: { maxWallShare: 1 / 3, maxProjection: 1.5, minBoundaryDistance: 2, cite: "BayBO Art. 6 Abs. 6 Nr. 2", verified: true, note: "Each at most 5 m wide." },
    storey: { basis: "own_area", share: 2 / 3, height: 2.3, heightMeasure: "clear", equalityCounts: true, terrainAbove: null, cite: "BayBO Art. 83 Abs. 6 i. V. m. Art. 2 Abs. 5 a. F.", verified: true, note: "Storey entirely above terrain." },
  },
  BE: {
    jurisdiction: "BE", name: "Bauordnung für Berlin", abbreviation: "BauO Bln",
    stand: "zuletzt geändert durch Gesetz vom 09.07.2026 (GVBl. S. 692), in Kraft 23.07.2026",
    sourceUrl: "https://www.berlin.de/sen/stadt/_assets/service/rechtsvorschriften/bereich-bauen/synopseaendbauobln_durchgeb.pdf",
    sourceNote: "Senate synopsis of the 2026 amendment (amended column, a non-binding working aid); gesetze.berlin.de not reachable.",
    setback: { factor: 0.4, minimum: 3, commercialFactor: 0.2, commercialMinimum: 3, cite: "BauO Bln § 6 Abs. 5", verified: true, note: "3 m for building classes 1 and 2 with up to three storeys." },
    publicSpace: centre("BauO Bln § 6 Abs. 2"),
    ancillary: { maxWallHeight: 3, maxLengthPerBoundary: 9, maxTotalLength: 15, cite: "BauO Bln § 6 Abs. 8", verified: true },
    projections: { maxWallShare: 1 / 3, maxProjection: 1.5, minBoundaryDistance: 2, cite: "BauO Bln § 6 Abs. 6 Nr. 2", verified: true },
    storey: { basis: "floor_below", share: 2 / 3, height: 2.3, heightMeasure: "clear", equalityCounts: true, terrainAbove: 1.4, cite: "BauO Bln § 2 Abs. 12", verified: true },
  },
  BB: {
    jurisdiction: "BB", name: "Brandenburgische Bauordnung", abbreviation: "BbgBO",
    stand: "Bekanntmachung vom 15.11.2018, zuletzt geändert durch Gesetz vom 29.06.2026",
    sourceUrl: "https://bravors.brandenburg.de/gesetze/bbgbo_2016",
    sourceNote: "Official portal bravors.brandenburg.de.",
    setback: { factor: 0.4, minimum: 3, commercialFactor: 0.2, commercialMinimum: 3, cite: "BbgBO § 6 Abs. 5", verified: true },
    publicSpace: centre("BbgBO § 6 Abs. 2"),
    ancillary: { maxWallHeight: 3, maxLengthPerBoundary: 9, maxTotalLength: 15, cite: "BbgBO § 6 Abs. 8", verified: true, note: "Roof pitch up to 45°." },
    projections: { maxWallShare: 1 / 3, maxProjection: 2.5, minBoundaryDistance: 2, cite: "BbgBO § 6 Abs. 6 Nr. 4", verified: true, note: "Balconies up to 5 m wide may project 2 m without a share limit (Nr. 3)." },
    storey: { basis: "every_storey", share: null, height: null, heightMeasure: "clear", equalityCounts: true, terrainAbove: 1.4, cite: "BbgBO § 88 Abs. 2 i. V. m. § 2 Abs. 4 BbgBO 2008", verified: true },
  },
  HB: {
    jurisdiction: "HB", name: "Bremische Landesbauordnung", abbreviation: "BremLBO",
    stand: "BremLBO vom 29.05.2024, in Kraft 01.07.2024",
    sourceUrl: "https://www.bremische-buergerschaft.de/dokumente/wp21/land/drucksache/d21l0449.pdf",
    sourceNote: "Senate bill Drs. 21/449; promulgated Gesetzblatt text not confirmed (transparenz.bremen.de not reachable).",
    setback: { factor: 0.4, minimum: 3, commercialFactor: 0.2, commercialMinimum: 3, cite: "BremLBO § 6 Abs. 6", verified: true, note: "Only ¾ of the depth (min. 2.50 m) protects the neighbour." },
    publicSpace: centre("BremLBO § 6 Abs. 3"),
    ancillary: { maxWallHeight: 3, maxLengthPerBoundary: 9, maxTotalLength: 18, cite: "BremLBO § 6 Abs. 8", verified: true },
    projections: { maxWallShare: 1 / 3, maxProjection: 1.6, minBoundaryDistance: 2, cite: "BremLBO § 6 Abs. 7 Nr. 2", verified: true },
    storey: { basis: "floor_below", share: 2 / 3, height: 2.3, heightMeasure: "storey", equalityCounts: false, terrainAbove: 1.4, cite: "BremLBO § 2 Abs. 6", verified: true, note: "Applies to the two top storeys; height in shell dimensions." },
  },
  HH: {
    jurisdiction: "HH", name: "Hamburgische Bauordnung", abbreviation: "HBauO",
    stand: "HBauO vom 06.01.2025, anzuwenden ab 01.01.2026",
    sourceUrl: "https://www.hamburg.de/resource/blob/1120174/a1f3778eb712e7a95605fbc6872df915/hamburgische-bauordnung-hbauo-2025-nichtamtliche-lesefassung-data.pdf",
    sourceNote: "Ministry reading version (nichtamtlich), checked against the amendment synopsis; landesrecht-hamburg.de not reachable.",
    setback: { factor: 0.4, minimum: 2.5, commercialFactor: 0.2, commercialMinimum: 2.5, cite: "HBauO § 6 Abs. 5", verified: true },
    publicSpace: centre("HBauO § 6 Abs. 2", "On public green areas only within Baulinien or Baugrenzen."),
    ancillary: { maxWallHeight: 3, maxLengthPerBoundary: 9, maxTotalLength: 15, cite: "HBauO § 6 Abs. 8", verified: true },
    projections: { maxWallShare: 1 / 3, maxProjection: 1.5, minBoundaryDistance: 2.5, cite: "HBauO § 6 Abs. 6 Nr. 2", verified: true },
    storey: { basis: "floor_below", share: 2 / 3, height: 2.3, heightMeasure: "clear", equalityCounts: true, terrainAbove: 1.4, cite: "HBauO § 2 Abs. 6", verified: true },
  },
  HE: {
    jurisdiction: "HE", name: "Hessische Bauordnung", abbreviation: "HBO",
    stand: "HBO vom 28.05.2018, zuletzt geändert 14.10.2025",
    sourceUrl: "https://wirtschaft.hessen.de/sites/wirtschaft.hessen.de/files/2025-12/hbo_broschuere_stand_oktober_2025-baupaket_i-final_nach_korrektur_vom_27.11.2025.pdf",
    sourceNote: "Ministry consolidated text, Stand Oktober 2025; rv.hessenrecht.hessen.de not reachable.",
    setback: { factor: 0.4, minimum: 2.5, commercialFactor: 0.2, commercialMinimum: 2.5, cite: "HBO § 6 Abs. 5", verified: true },
    publicSpace: centre("HBO § 6 Abs. 2 Nr. 1"),
    ancillary: { maxWallHeight: 3, maxLengthPerBoundary: null, maxTotalLength: 15, cite: "HBO § 6 Abs. 10", verified: true, note: "Up to 25 m² of wall per boundary instead of a length." },
    projections: { maxWallShare: 1 / 3, maxProjection: 1.5, minBoundaryDistance: 2, cite: "HBO § 6 Abs. 6", verified: true },
    storey: { basis: "floor_below", share: 3 / 4, height: 2.3, heightMeasure: "storey", equalityCounts: false, terrainAbove: 1.4, cite: "HBO § 2 Abs. 5", verified: true },
  },
  MV: {
    jurisdiction: "MV", name: "Landesbauordnung Mecklenburg-Vorpommern", abbreviation: "LBauO M-V",
    stand: "Bekanntmachung vom 15.10.2015, Fassung gültig ab 12.06.2026",
    sourceUrl: "https://mecklenburg-vorpommern.de/sites/default/files/2026-10/LBauO_2026.pdf",
    sourceNote: "Ministry reading version; changes from 14.01.2027 not included.",
    setback: { factor: 0.4, minimum: 3, commercialFactor: 0.2, commercialMinimum: 3, cite: "LBauO M-V § 6 Abs. 5", verified: true, unsupported: "Depth by building class: 3 m (classes 1–3), 4 m (class 4), 5 m (class 5); 0.4 H only otherwise." },
    publicSpace: centre("LBauO M-V § 6 Abs. 2"),
    ancillary: { maxWallHeight: 3, maxLengthPerBoundary: 9, maxTotalLength: 15, cite: "LBauO M-V § 6 Abs. 8", verified: true },
    projections: { maxWallShare: 1 / 3, maxProjection: 1.5, minBoundaryDistance: 2, cite: "LBauO M-V § 6 Abs. 6 Nr. 2", verified: true },
    storey: { basis: "own_area", share: 2 / 3, height: 2.3, heightMeasure: "clear", equalityCounts: true, terrainAbove: 1.4, cite: "LBauO M-V § 2 Abs. 6", verified: true },
  },
  NI: {
    jurisdiction: "NI", name: "Niedersächsische Bauordnung", abbreviation: "NBauO",
    stand: "§ 5 in der Fassung ab 01.07.2024, § 2 ab 01.07.2025",
    sourceUrl: "https://voris.wolterskluwer-online.de/browse/document/e807db8f-7202-30e1-a88b-8f1ff76cf135",
    sourceNote: "Official portal VORIS.",
    setback: { factor: 0.4, minimum: 3, commercialFactor: 0.2, commercialMinimum: 3, cite: "NBauO § 5 Abs. 2", verified: true, unsupported: "Grenzabstand measured from every point of the building's outer surface, not as areas in front of walls." },
    publicSpace: { allowed: true, extent: "centre", cite: "NBauO § 6 Abs. 1", verified: true, note: "Street areas up to their centre line; green and water areas only with the owner's consent." },
    ancillary: { maxWallHeight: 3, maxLengthPerBoundary: 9, maxTotalLength: 15, cite: "NBauO § 5 Abs. 8", verified: true },
    projections: { maxWallShare: 1 / 3, maxProjection: 1.5, minBoundaryDistance: null, cite: "NBauO § 5 Abs. 3 Nr. 2", verified: true, note: "The distance may shrink by at most 1.50 m and at most a third." },
    storey: { basis: "floor_below", share: 2 / 3, height: 2.2, heightMeasure: "clear", equalityCounts: false, terrainAbove: 1.4, cite: "NBauO § 2 Abs. 7", verified: true },
  },
  NW: {
    jurisdiction: "NW", name: "Landesbauordnung 2018", abbreviation: "BauO NRW",
    stand: "Fassung ab 01.09.2026 (zuletzt geändert 21.07.2026)",
    sourceUrl: "https://recht.nrw.de/lrgv/gesetz/01092026-landesbauordnung-2018-bauo-nrw-2018/",
    sourceNote: "Official portal recht.nrw.de.",
    setback: { factor: 0.4, minimum: 3, commercialFactor: 0.2, commercialMinimum: 3, cite: "BauO NRW § 6 Abs. 5", verified: true, note: "0.25 H in Kerngebiete." },
    publicSpace: centre("BauO NRW § 6 Abs. 2"),
    ancillary: { maxWallHeight: 3, maxLengthPerBoundary: 9, maxTotalLength: 18, cite: "BauO NRW § 6 Abs. 8", verified: true, note: "Buildings without habitable rooms up to 30 m³." },
    projections: { maxWallShare: 1 / 3, maxProjection: 1.6, minBoundaryDistance: 2, cite: "BauO NRW § 6 Abs. 6 Nr. 2", verified: true },
    storey: { basis: "floor_below", share: 3 / 4, height: 2.3, heightMeasure: "clear", equalityCounts: false, terrainAbove: 1.6, cite: "BauO NRW § 2 Abs. 6", verified: true },
  },
  RP: {
    jurisdiction: "RP", name: "Landesbauordnung Rheinland-Pfalz", abbreviation: "LBauO RP",
    stand: "zuletzt geändert 19.11.2025 (GVBl. S. 672)",
    sourceUrl: "https://mkbwk.rlp.de/fileadmin/07/Bilder/Themen/Baurecht_und_Bautechnik/Bauvorschriften/Bauordnungsrecht/Synopse_mit_unterschiedlichen_Inkrafttretenszeitpunkten_2.0.pdf",
    sourceNote: "Ministry synopsis (nichtamtlich); § 2 Abs. 4 not included and landesrecht.rlp.de not reachable.",
    setback: { factor: 0.4, minimum: 3, commercialFactor: 0.25, commercialMinimum: 3, cite: "LBauO RP § 8 Abs. 6", verified: true },
    publicSpace: centre("LBauO RP § 8 Abs. 2"),
    ancillary: { maxWallHeight: 3.2, maxLengthPerBoundary: 12, maxTotalLength: 18, cite: "LBauO RP § 8 Abs. 9", verified: true },
    projections: { maxWallShare: null, maxProjection: 1.5, minBoundaryDistance: 2, cite: "LBauO RP § 8 Abs. 5", verified: true },
    storey: null,
  },
  SL: {
    jurisdiction: "SL", name: "Landesbauordnung Saarland", abbreviation: "LBO SL",
    stand: "zuletzt geändert durch Gesetz vom 27.08.2025 (Amtsbl. I S. 854)",
    sourceUrl: "https://www.saarland.de/SharedDocs/Downloads/DE/mibs/tp_bauen_und_wohnen/ba_bt_gesetze/bauordnungen/LBO_2025_neu.pdf?__blob=publicationFile&v=2",
    sourceNote: "Official consolidated text on saarland.de.",
    setback: { factor: 0.4, minimum: 3, commercialFactor: 0.2, commercialMinimum: 3, cite: "LBO SL § 7 Abs. 5", verified: true },
    publicSpace: centre("LBO SL § 7 Abs. 2"),
    ancillary: { maxWallHeight: 3, maxLengthPerBoundary: 12, maxTotalLength: 15, cite: "LBO SL § 8 Abs. 2", verified: true },
    projections: { maxWallShare: 1 / 3, maxProjection: 1.5, minBoundaryDistance: 2, cite: "LBO SL § 7 Abs. 6 Nr. 2", verified: true },
    storey: { basis: "floor_below", share: 3 / 4, height: 2.3, heightMeasure: "clear", equalityCounts: true, terrainAbove: 1.4, cite: "LBO SL § 2 Abs. 5", verified: true },
  },
  SN: {
    jurisdiction: "SN", name: "Sächsische Bauordnung", abbreviation: "SächsBO",
    stand: "zuletzt geändert durch Gesetz vom 01.03.2024, Fassung ab 19.03.2024",
    sourceUrl: "https://www.revosax.sachsen.de/vorschrift/1779-SaechsBO",
    sourceNote: "Official portal REVOSax.",
    setback: { factor: 0.4, minimum: 3, commercialFactor: 0.2, commercialMinimum: 3, cite: "SächsBO § 6 Abs. 5", verified: true },
    publicSpace: centre("SächsBO § 6 Abs. 2"),
    ancillary: { maxWallHeight: 3, maxLengthPerBoundary: 9, maxTotalLength: 15, cite: "SächsBO § 6 Abs. 8", verified: true },
    projections: { maxWallShare: 1 / 3, maxProjection: 1.5, minBoundaryDistance: 2, cite: "SächsBO § 6 Abs. 6 Nr. 2", verified: true },
    storey: { basis: "own_area", share: 2 / 3, height: 2.3, heightMeasure: "clear", equalityCounts: true, terrainAbove: 1.4, cite: "SächsBO § 90 Abs. 2", verified: true },
  },
  ST: {
    jurisdiction: "ST", name: "Bauordnung des Landes Sachsen-Anhalt", abbreviation: "BauO LSA",
    stand: null,
    sourceUrl: "https://www.landesrecht.sachsen-anhalt.de",
    sourceNote: "No official consolidated text was reachable; nothing captured.",
    setback: null, publicSpace: null, ancillary: null, projections: null, storey: null,
  },
  SH: {
    jurisdiction: "SH", name: "Landesbauordnung für das Land Schleswig-Holstein", abbreviation: "LBO SH",
    stand: "Bekanntmachung vom 05.07.2024 (GVOBl. S. 504)",
    sourceUrl: "https://verkuendungsportal.schleswig-holstein.de/mm/gvobl_jahrgang_2024/II_GVOBl_Jahrgang_2024",
    sourceNote: "Text copy of the image-only official announcement, checked against the 2021 and 2024 gazette texts; a 2026 amendment is not included.",
    setback: { factor: 0.4, minimum: 3, commercialFactor: 0.2, commercialMinimum: 3, cite: "LBO SH § 6 Abs. 5", verified: true },
    publicSpace: centre("LBO SH § 6 Abs. 2"),
    ancillary: { maxWallHeight: 3, maxLengthPerBoundary: 9, maxTotalLength: 18, cite: "LBO SH § 6 Abs. 8", verified: true },
    projections: { maxWallShare: 1 / 3, maxProjection: 1.5, minBoundaryDistance: 2, cite: "LBO SH § 6 Abs. 6 Nr. 2", verified: true },
    storey: { basis: "floor_below", share: 3 / 4, height: 2.3, heightMeasure: "storey", equalityCounts: true, terrainAbove: 1.4, cite: "LBO SH § 2 Abs. 7", verified: true },
  },
  TH: {
    jurisdiction: "TH", name: "Thüringer Bauordnung", abbreviation: "ThürBO",
    stand: "ThürBO vom 02.07.2024, geändert durch Gesetz vom 06.07.2026 (in Kraft 24.07.2026)",
    sourceUrl: "https://parldok.thueringer-landtag.de/ParlDok/dokument/98016/gesetz_und_verordnungsblatt_nr_9_2024.pdf",
    sourceNote: "Official gazettes hosted by the Landtag (base law and 2026 amendment).",
    setback: { factor: 0.4, minimum: 3, commercialFactor: 0.2, commercialMinimum: 3, cite: "ThürBO § 6 Abs. 5", verified: true },
    publicSpace: centre("ThürBO § 6 Abs. 2"),
    ancillary: { maxWallHeight: 3, maxLengthPerBoundary: 9, maxTotalLength: 18, cite: "ThürBO § 6 Abs. 7", verified: true },
    projections: { maxWallShare: 1 / 3, maxProjection: 1.6, minBoundaryDistance: 2, cite: "ThürBO § 6 Abs. 6 Nr. 2", verified: true },
    storey: { basis: "own_area", share: 2 / 3, height: 2.3, heightMeasure: "clear", equalityCounts: true, terrainAbove: 1.4, cite: "ThürBO § 100 Abs. 2", verified: true },
  },
};

export const isBundesland = (value: string): value is Bundesland => (BUNDESLAENDER as readonly string[]).includes(value);

/** The applicable rule for a topic, or null when the state's rule is not captured, not verified or not modelled. */
export function buildingCodeRule<K extends BuildingCodeTopic>(jurisdiction: string, topic: K): NonNullable<BuildingCode[K]> | null {
  if (!isBundesland(jurisdiction)) return null;
  const rule = BUILDING_CODES[jurisdiction][topic];
  return rule?.verified && !rule.unsupported ? (rule as NonNullable<BuildingCode[K]>) : null;
}

/** Abstandsfläche depth for a wall of assessment height H under the state's standard profile. */
export function setbackDepth(rule: Pick<SetbackRule, "factor" | "minimum">, height: number): number {
  return Math.max(rule.minimum, rule.factor * height);
}
