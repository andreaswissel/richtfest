import { fireRatingSchema, fireClosureSchema, type FireRating, type FireClosure, type FireRoomRole, type FireSpecialUse, type StairwellSmokeVent, type FireRescueWindow } from "./fire-protection-schema";
export * from "./fire-protection-schema";

/**
 * Fire protection (Brandschutz) under a Landesbauordnung: building class,
 * Sonderbau, the deliverable (plans only or plans plus written concept), and
 * the requirement on every wall, slab and door from the rooms it separates.
 * Requirements are quoted from the official text; this module only applies
 * them. Rheinland-Pfalz (LBauO) and Berlin (BauO Bln) are captured; other
 * states return `supported: false` instead of falling back to the
 * Musterbauordnung, because every state adopts it differently.
 */

export type FireBuildingClass = 1 | 2 | 3 | 4 | 5;
export type GarageSize = "small" | "medium" | "large";

const LBAUO = "LBauO RLP";
const BAUOBLN = "BauO Bln";
export const fireCodeEditions = {
  RP: {
    code: "Landesbauordnung Rheinland-Pfalz (LBauO) vom 24. November 1998 (GVBl. S. 365), zuletzt geändert durch Artikel 3 des Gesetzes vom 19. November 2025 (GVBl. S. 672)",
    garages: "Garagen- und Stellplatzanlagenverordnung (GarStellVO) vom 8. Dezember 2022 (GVBl. S. 445)",
  },
  BE: {
    code: "Bauordnung für Berlin (BauO Bln) vom 29. September 2005 (GVBl. S. 495), zuletzt geändert durch Gesetz vom 9. Juli 2026 (GVBl. S. 692)",
    garages: "Betriebs-Verordnung (BetrVO), Abschnitt 3 Garagen",
  },
} as const;
export type FireCodeState = keyof typeof fireCodeEditions;
export const fireCodeSupported = (state: string | null | undefined): state is FireCodeState => state === "RP" || state === "BE";
/** Paragraphs the written part names outside quoted requirements. */
export const fireCodeLaw: Record<FireCodeState, { short: string; long: string; goals: string; specialUse: string; stairwells: string; corridors: string; smoke: string; smokeWindows: string; smokeTop: string; fireWalls: string; garageClass: string | null }> = {
  RP: { short: "LBauO", long: "Landesbauordnung Rheinland-Pfalz – LBauO", goals: "§ 15", specialUse: "§ 50 Abs. 2 LBauO", stairwells: "§ 34 LBauO", corridors: "§ 35 LBauO",
    smoke: "§ 34 Abs. 11 LBauO", smokeWindows: "Fenster mit mindestens 0,50 m² freiem Querschnitt (§ 34 Abs. 11 Satz 2 Nr. 1 LBauO)", smokeTop: "§ 34 Abs. 11 Satz 2 Nr. 2 LBauO", fireWalls: "§ 30 LBauO", garageClass: "§ 2 GarStellVO" },
  BE: { short: "BauO Bln", long: "Bauordnung für Berlin – BauO Bln", goals: "§ 14", specialUse: "§ 2 Abs. 4 BauO Bln", stairwells: "§ 35 BauO Bln", corridors: "§ 36 BauO Bln",
    smoke: "§ 35 Abs. 8 BauO Bln", smokeWindows: "Fenster mit einem freien Querschnitt von mindestens 0,60 m x 0,90 m und einer Brüstung von höchstens 1,20 m (§ 35 Abs. 8 Satz 2 Nr. 1 BauO Bln)", smokeTop: "§ 35 Abs. 8 Satz 2 Nr. 2 BauO Bln", fireWalls: "§ 30 BauO Bln", garageClass: null },
};

export type FireRequirementId =
  | "protectionGoals" | "buildingClass" | "highRise" | "specialUse" | "escapeRoutes" | "loadBearingWalls" | "exteriorWalls" | "partitionWalls" | "partitionOpenings"
  | "ceilings" | "stairwellRequired" | "escapeDistance" | "corridorsBeforeStairwell" | "stairwellWalls" | "stairwellDoors" | "stairwellSmoke"
  | "corridorDefinition" | "corridorWalls" | "corridorSmokeSections" | "rescueWindows" | "garageClass" | "garageEscape" | "fireReview" | "fireWater";

/**
 * One requirement as the written concept states it: the cited text, then how
 * the building meets it. `wording` is "verbatim" for official text and
 * "summary" where Richtfest restates a source it could not quote reliably;
 * summaries must be checked against the source before a concept is issued.
 */
export type FireRequirement = { id: FireRequirementId; chapter: string; cite: string; wording: "verbatim" | "summary"; text: string };

/** LBauO RLP as amended on 19 Nov 2025, taken from the consolidated official text. Garage and fire-water entries are marked where they are not verbatim. */
const fireRequirementsRp: FireRequirement[] = [
  { id: "protectionGoals", chapter: "Schutzziele", cite: `${LBAUO} § 15 Abs. 1`, wording: "verbatim",
    text: "Bauliche Anlagen müssen so angeordnet und beschaffen sein, dass der Entstehung eines Brandes und der Ausbreitung von Feuer und Rauch vorgebeugt wird und bei einem Brand die Rettung von Menschen und Tieren und wirksame Löscharbeiten möglich sind." },
  { id: "buildingClass", chapter: "Gebäudeklasse", cite: `${LBAUO} § 2 Abs. 2 Satz 2`, wording: "verbatim",
    text: "Sie werden in folgende Gebäudeklassen eingeteilt: 1. Gebäudeklasse 1 Freistehende Wohngebäude mit einer Wohnung in nicht mehr als zwei Geschossen, andere freistehende Gebäude ähnlicher Größe, freistehende land- oder forstwirtschaftliche Betriebsgebäude. 2. Gebäudeklasse 2 Gebäude, bei denen der Fußboden keines Geschosses, in dem Aufenthaltsräume möglich sind, im Mittel mehr als 7 m über der Geländeoberfläche liegt, a) mit nicht mehr als zwei Wohnungen, b) mit drei Wohnungen in freistehenden Gebäuden in Hanglage, wenn die dritte Wohnung im untersten Geschoss liegt und ihren Zugang unmittelbar vom Freien aus hat. An die Stelle der Wohnungen nach Satz 2 Nr. 2 können jeweils sonstige Nutzungseinheiten treten, wenn die Nutzfläche des Gebäudes insgesamt 400 m² nicht überschreitet. 3. Gebäudeklasse 3 Gebäude, bei denen der Fußboden keines Geschosses, in dem Aufenthaltsräume möglich sind, im Mittel mehr als 7 m über der Geländeoberfläche liegt. 4. Gebäudeklasse 4 Gebäude, bei denen der Fußboden keines Geschosses, in dem Aufenthaltsräume möglich sind, im Mittel mehr als 13 m über der Geländeoberfläche liegt. 5. Gebäudeklasse 5 Sonstige Gebäude." },
  { id: "highRise", chapter: "Gebäudeklasse", cite: `${LBAUO} § 2 Abs. 3`, wording: "verbatim",
    text: "Hochhäuser sind Gebäude, bei denen der Fußboden eines Aufenthaltsraums mehr als 22 m über der Geländeoberfläche liegt." },
  { id: "specialUse", chapter: "Sonderbau", cite: `${LBAUO} § 50 Abs. 2`, wording: "verbatim",
    text: "Die Bestimmungen des Absatzes 1 gelten insbesondere für 1. Hochhäuser, 2. Verkaufsstätten, 3. Versammlungsstätten, 4. Büro- und Verwaltungsgebäude, 5. Gaststätten, Beherbergungsbetriebe, 6. Krankenhäuser und ähnliche Einrichtungen der Gesundheitspflege, bauliche Anlagen zum Zweck der Pflege oder Betreuung, Tages- und Begegnungsstätten sowie Wohnheime, […] 7. Kindertagesstätten und sonstige Einrichtungen für Kinder und Jugendliche, 8. Schulen und Sportstätten, 9. bauliche Anlagen und Räume von großer Ausdehnung oder mit erhöhter Brand-, Explosions- oder Verkehrsgefahr, 10. bauliche Anlagen und Räume, die für gewerbliche Betriebe bestimmt sind, 11. bauliche Anlagen und Räume, deren Nutzung mit einem starken Abgang schädlicher Stoffe verbunden ist, 12. Fliegende Bauten, 13. Camping- und Wochenendplätze." },
  { id: "escapeRoutes", chapter: "Rettungswege", cite: `${LBAUO} § 15 Abs. 4 Satz 1 bis 3`, wording: "verbatim",
    text: "Jede Nutzungseinheit mit einem oder mehreren Aufenthaltsräumen muss in jedem Geschoss über mindestens zwei voneinander unabhängige Rettungswege erreichbar sein; beide Rettungswege dürfen jedoch innerhalb des Geschosses über denselben notwendigen Flur führen. Die Rettungswege müssen bei Nutzungseinheiten, die nicht zu ebener Erde liegen, über notwendige Treppen (§ 33 Abs. 1) führen. Bei Gebäuden, die nicht Hochhäuser sind, darf der zweite Rettungsweg über mit vorhandenen Rettungsgeräten der Feuerwehr erreichbare Stellen (Oberkante der Brüstung eines notwendigen Fensters oder sonstige geeignete Stellen) führen; diese Stellen dürfen bei Gebäuden der Gebäudeklassen 2 und 3 nicht mehr als 8 m über der Geländeoberfläche liegen." },
  { id: "loadBearingWalls", chapter: "Tragende Wände, Pfeiler und Stützen", cite: `${LBAUO} § 27 Abs. 1 Satz 2`, wording: "verbatim",
    text: "Sie sind bei Gebäuden der 1. Gebäudeklasse 5 feuerbeständig, 2. Gebäudeklasse 4 in Kellergeschossen feuerbeständig, im Übrigen hochfeuerhemmend, 3. Gebäudeklasse 3 in Kellergeschossen feuerbeständig, im Übrigen feuerhemmend, 4. Gebäudeklasse 2 in Kellergeschossen sowie im untersten Geschoss mit einer dritten Wohnung feuerhemmend und in den wesentlichen Teilen aus nicht brennbaren Baustoffen, im Übrigen feuerhemmend herzustellen; dies gilt nicht für Geschosse im Dachraum, über denen sich keine Aufenthaltsräume befinden, für zu ebener Erde liegende, eingeschossige Vorbauten wie Wintergärten sowie für Unterstützungen von Balkonen." },
  { id: "exteriorWalls", chapter: "Außenwände", cite: `${LBAUO} § 28 Abs. 1 Satz 1, Abs. 2 Satz 2`, wording: "verbatim",
    text: "Nicht tragende Außenwände und nicht tragende Teile tragender Außenwände sind bei Gebäuden der Gebäudeklassen 4 und 5 aus nicht brennbaren Baustoffen oder als raumabschließende Bauteile feuerhemmend herzustellen. […] Sie müssen bei Gebäuden der Gebäudeklassen 4 und 5 schwer entflammbar sein und dürfen nicht brennend abfallen oder abtropfen; Dämmstoffe und Unterkonstruktionen aus normalentflammbaren Baustoffen sind zulässig, wenn die Anforderungen nach Satz 1 erfüllt sind." },
  { id: "partitionWalls", chapter: "Trennwände", cite: `${LBAUO} § 29 Abs. 1 und 2`, wording: "verbatim",
    text: "Trennwände sind als raumabschließende Bauteile zur Verhinderung der Brandausbreitung innerhalb von Geschossen herzustellen 1. zwischen Wohnungen sowie zwischen Wohnungen und fremden Räumen, 2. zwischen sonstigen Nutzungseinheiten. Die Trennwände müssen in Gebäuden der 1. Gebäudeklasse 5 feuerbeständig, 2. Gebäudeklasse 4 hochfeuerhemmend, jeweils im obersten Geschoss im Dachraum feuerhemmend, 3. Gebäudeklassen 2 und 3 feuerhemmend sein." },
  { id: "partitionOpenings", chapter: "Trennwände", cite: `${LBAUO} § 29 Abs. 3`, wording: "verbatim",
    text: "Die Trennwände sind bis zur Rohdecke oder bis unter die Dachhaut zu führen. Öffnungen sind zulässig, wenn sie für die Benutzung des Gebäudes erforderlich sind. Sie sind mit mindestens feuerhemmenden, dicht- und selbstschließenden Abschlüssen zu versehen." },
  { id: "ceilings", chapter: "Decken", cite: `${LBAUO} § 31 Abs. 1 Satz 2`, wording: "verbatim",
    text: "Sie sind bei Gebäuden der 1. Gebäudeklasse 5 sowie zwischen dem land- oder forstwirtschaftliche Betriebsteil und dem Wohnteil eines Gebäudes feuerbeständig, 2. Gebäudeklasse 4 in Kellergeschossen feuerbeständig, im Übrigen hochfeuerhemmend, 3. Gebäudeklasse 3 in Kellergeschossen feuerbeständig, im Übrigen feuerhemmend, 4. Gebäudeklasse 2 feuerhemmend herzustellen; dies gilt, unbeschadet des § 45 Abs. 5, nicht für Geschosse im Dachraum, über denen sich keine Aufenthaltsräume befinden, sowie für Balkone." },
  { id: "stairwellRequired", chapter: "Notwendige Treppenräume", cite: `${LBAUO} § 34 Abs. 1 Satz 1`, wording: "verbatim",
    text: "Jede notwendige Treppe im Innern von Gebäuden der Gebäudeklassen 3 bis 5 muss zur Sicherstellung der Rettungswege aus den Geschossen ins Freie in einem eigenen, durchgehenden Treppenraum liegen (notwendiger Treppenraum)." },
  { id: "escapeDistance", chapter: "Rettungswege", cite: `${LBAUO} § 34 Abs. 2 Satz 1`, wording: "verbatim",
    text: "Von jeder Stelle eines Aufenthaltsraums sowie eines Kellergeschosses muss mindestens ein notwendiger Treppenraum oder ein Ausgang ins Freie in höchstens 35 m Entfernung erreichbar sein." },
  { id: "corridorsBeforeStairwell", chapter: "Notwendige Flure", cite: `${LBAUO} § 34 Abs. 5`, wording: "verbatim",
    text: "In Gebäuden der Gebäudeklassen 4 und 5 müssen in Geschossen mit mehr als vier Wohnungen oder Nutzungseinheiten vergleichbarer Größe vor Treppenräumen notwendige Flure angeordnet werden." },
  { id: "stairwellWalls", chapter: "Notwendige Treppenräume", cite: `${LBAUO} § 34 Abs. 6`, wording: "verbatim",
    text: "Die Wände notwendiger Treppenräume sind als raumabschließende Bauteile in Gebäuden der Gebäudeklasse 5 in der Bauart von Brandwänden, in Gebäuden der Gebäudeklasse 4 in Kellergeschossen feuerbeständig, im Übrigen auch unter zusätzlicher mechanischer Beanspruchung hochfeuerhemmend, und in Gebäuden der Gebäudeklasse 3 in Kellergeschossen feuerbeständig, im Übrigen hochfeuerhemmend herzustellen; […] Satz 1 gilt nicht für nicht tragende Außenwände notwendiger Treppenräume, wenn sie aus nicht brennbaren Baustoffen bestehen und durch Öffnungen in anschließenden Außenwänden im Brandfall nicht gefährdet werden können." },
  { id: "stairwellDoors", chapter: "Notwendige Treppenräume", cite: `${LBAUO} § 34 Abs. 9 Satz 1`, wording: "verbatim",
    text: "In notwendigen Treppenräumen müssen, unbeschadet des Absatzes 11 Satz 4, Öffnungen zu 1. Kellergeschossen, nicht ausgebauten Dachräumen, Werkstätten, Läden, Gaststätten, Lagerräumen und ähnlichen Räumen sowie Nutzungseinheiten mit einer Nutzfläche von mehr als 200 m² mindestens feuerhemmende, rauchdichte und selbstschließende Türen, 2. notwendigen Fluren rauchdichte und selbstschließende Türen, 3. Wohnungen, sonstigen Nutzungseinheiten vergleichbarer Größe sowie sonstigen Räumen mindestens dicht- und selbstschließende Türen haben." },
  { id: "stairwellSmoke", chapter: "Notwendige Treppenräume", cite: `${LBAUO} § 34 Abs. 11 Satz 2 bis 5`, wording: "verbatim",
    text: "Sie müssen mindestens 1. in jedem oberirdischen Geschoss unmittelbar ins Freie führende Fenster mit einem freien Querschnitt von mindestens 0,50 m² haben, die leicht geöffnet werden können und auch für den obersten Zugangsbereich eine Rauchableitung ermöglichen, oder 2. an der höchsten Stelle eine Öffnung zur Rauchableitung haben. In Gebäuden der Gebäudeklasse 5 ist in den Fällen des Satzes 2 Nr. 1 an der höchsten Stelle des Treppenraumes anstelle des Fensters im obersten Geschoss eine Öffnung zur Rauchableitung erforderlich. In den Fällen des Satzes 2 Nr. 2 müssen in den Treppenräumen von Gebäuden der Gebäudeklassen 4 und 5 Öffnungen zu Wohnungen, sonstigen Nutzungseinheiten und Räumen feuerhemmende, rauchdichte und selbstschließende Türen haben. Öffnungen zur Rauchableitung nach den Sätzen 2 und 3 müssen in jedem Treppenraum einen freien Querschnitt von mindestens 1 m² und Vorrichtungen zum Öffnen ihrer Abschlüsse haben, die vom Erdgeschoss und vom obersten Treppenabsatz aus bedient werden können." },
  { id: "corridorDefinition", chapter: "Notwendige Flure", cite: `${LBAUO} § 35 Abs. 1`, wording: "verbatim",
    text: "Flure, über die Rettungswege von Aufenthaltsräumen oder aus Nutzungseinheiten mit Aufenthaltsräumen zu notwendigen Treppenräumen oder zu Ausgängen ins Freie führen (notwendige Flure), müssen so angeordnet und ausgebildet sein, dass die Nutzung im Brandfall ausreichend lang möglich ist. Als notwendige Flure gelten nicht 1. Flure innerhalb von Wohnungen oder sonstigen Nutzungseinheiten vergleichbarer Größe, 2. Flure in Gebäuden der Gebäudeklassen 1 und 2, 3. Flure innerhalb von Nutzungseinheiten, die einer Büro- oder Verwaltungsnutzung dienen und deren Nutzfläche in einem Geschoss nicht mehr als 400 m² beträgt." },
  { id: "corridorWalls", chapter: "Notwendige Flure", cite: `${LBAUO} § 35 Abs. 3`, wording: "verbatim",
    text: "Wände notwendiger Flure sind als raumabschließende Bauteile in Gebäuden der 1. Gebäudeklassen 4 und 5 feuerhemmend und in den wesentlichen Teilen aus nicht brennbaren Baustoffen oder feuerhemmend und mit einer gegen Brandeinwirkung widerstandsfähigen Bekleidung aus nicht brennbaren Baustoffen, 2. Gebäudeklasse 3 feuerhemmend herzustellen. Die Wände sind bis an die Rohdecke oder bis an einen oberen Raumabschluss zu führen, der hinsichtlich Feuerwiderstand und Bauart den Wänden entspricht; Türen in diesen Wänden müssen dicht schließend sein." },
  { id: "rescueWindows", chapter: "Rettungswege", cite: `${LBAUO} § 37 Abs. 2 Satz 1`, wording: "verbatim",
    text: "Öffnungen in Fenstern, die als Rettungswege dienen, müssen im Lichten 0,90 m breit x 1,20 m hoch und von innen leicht zu öffnen sein; ihre Brüstungshöhe darf 1,20 m nicht überschreiten." },
  { id: "garageClass", chapter: "Garagen", cite: "GarStellVO RLP § 2", wording: "verbatim",
    text: "1. bis 100 m² Kleingaragen, 2. über 100 m² bis 1 000 m² Mittelgaragen, 3. über 1 000 m² Großgaragen." },
  { id: "garageEscape", chapter: "Garagen", cite: "GarStellVO RLP § 14 Abs. 1 und 2", wording: "verbatim",
    text: "Jede Mittel- und Großgarage muss in jedem Geschoss mindestens zwei voneinander unabhängige bauliche Rettungswege haben, die unmittelbar oder über notwendige Treppenräume ins Freie führen. […] Von jeder Stelle einer Mittel- und Großgarage muss in demselben Geschoss mindestens ein Ausgang ins Freie, ein notwendiger Treppenraum oder, wenn ein Treppenraum nicht erforderlich ist, mindestens eine notwendige Treppe 1. bei offenen Mittel- und Großgaragen in einer Entfernung von höchstens 50 m, 2. bei geschlossenen Mittel- und Großgaragen in einer Entfernung von höchstens 35 m erreichbar sein. In geschlossenen Mittel- und Großgaragen gilt die Entfernung nach Satz 1 bis zur Sicherheitsschleuse. Die Entfernung ist in der Lauflinie, jedoch nicht über Stellplätze zu messen." },
  { id: "fireWater", chapter: "Löschwasserversorgung", cite: "AGBF/DFV-Information 2018-4 i. V. m. DVGW W 405", wording: "summary",
    text: "Löschwasserbedarf für den Grundschutz bei niedriger, in der Regel freistehender Bebauung (bis 3 Vollgeschosse) 800 l/min (48 m³/h), bei sonstiger Bebauung mindestens 1.600 l/min (96 m³/h), jeweils für mindestens 2 Stunden. Erste Entnahmestelle innerhalb von 75 m Lauflinie bis zum Grundstückszugang, gesamte Löschwassermenge im Umkreis von 300 m. Im Brandschutznachweis sind Bedarf und Nachweis darzustellen." },
];
/**
 * BauO Bln: §§ 14, 27, 29, 31, 35, 36 and 37 as in force since 2006/2017,
 * §§ 2, 33 and 66 as amended on 9 Jul 2026 (in force 23 Jul 2026), from the
 * official text (gesetze.berlin.de). § 28 was amended on 9 Jul 2026 and is
 * kept as a summary until checked against that text. Berlin has no
 * Garagenverordnung; garage size classes follow the Muster-Garagenverordnung.
 */
const fireRequirementsBe: FireRequirement[] = [
  { id: "protectionGoals", chapter: "Schutzziele", cite: `${BAUOBLN} § 14`, wording: "verbatim",
    text: "Bauliche Anlagen sind so anzuordnen, zu errichten, zu ändern und instand zu halten, dass der Entstehung eines Brandes und der Ausbreitung von Feuer und Rauch (Brandausbreitung) vorgebeugt wird und bei einem Brand die Rettung von Menschen und Tieren sowie wirksame Löscharbeiten möglich sind." },
  { id: "buildingClass", chapter: "Gebäudeklasse", cite: `${BAUOBLN} § 2 Abs. 3 Satz 1 bis 3`, wording: "verbatim",
    text: "Gebäude werden in folgende Gebäudeklassen eingeteilt: 1. Gebäudeklasse 1: a) freistehende Gebäude mit einer Höhe bis zu 7 m und nicht mehr als zwei Nutzungseinheiten von insgesamt nicht mehr als 400 m² Brutto-Grundfläche und b) freistehende land- oder forstwirtschaftlich genutzte Gebäude. 2. Gebäudeklasse 2: Gebäude mit einer Höhe bis zu 7 m und nicht mehr als zwei Nutzungseinheiten von insgesamt nicht mehr als 400 m² Brutto-Grundfläche, 3. Gebäudeklasse 3: sonstige Gebäude mit einer Höhe bis zu 7 m, 4. Gebäudeklasse 4: Gebäude mit einer Höhe bis zu 13 m und Nutzungseinheiten mit jeweils nicht mehr als 400 m² Brutto-Grundfläche, 5. Gebäudeklasse 5: sonstige Gebäude einschließlich unterirdischer Gebäude. Höhe im Sinne des Satzes 1 ist das Maß der Fußbodenoberkante des höchstgelegenen Geschosses, in dem ein Aufenthaltsraum möglich ist, über der Geländeoberfläche im Mittel. Die Brutto-Grundfläche umfasst die gesamte Fläche der Nutzungseinheit einschließlich der Umfassungswände; bei der Berechnung der Brutto-Grundfläche nach Satz 1 bleiben Flächen in Kellergeschossen außer Betracht." },
  { id: "highRise", chapter: "Gebäudeklasse", cite: `${BAUOBLN} § 2 Abs. 4 Nr. 1`, wording: "verbatim",
    text: "Hochhäuser (Gebäude mit einer Höhe nach Absatz 3 Satz 2 von mehr als 22 m)," },
  { id: "specialUse", chapter: "Sonderbau", cite: `${BAUOBLN} § 2 Abs. 4`, wording: "verbatim",
    text: "Sonderbauten sind Anlagen und Räume besonderer Art oder Nutzung, die einen der nachfolgenden Tatbestände erfüllen: 1. Hochhäuser […], 3. Gebäude mit mehr als 1 600 m² Brutto-Grundfläche des Geschosses mit der größten Ausdehnung, ausgenommen Wohngebäude, Garagen sowie Räume und Gebäude für Abstellplätze für Fahrräder, 4. Verkaufsstätten, deren Verkaufsräume und Ladenstraßen eine Brutto-Grundfläche von insgesamt mehr als 800 m² haben, 5. Gebäude mit Räumen, die einer Büro- oder Verwaltungsnutzung dienen und einzeln eine Brutto-Grundfläche von mehr als 400 m² haben, 6. Gebäude mit Räumen, die einzeln für die Nutzung durch mehr als 100 Personen bestimmt sind, 7. Versammlungsstätten […], 8. Schank- und Speisegaststätten mit mehr als 40 Gastplätzen in Gebäuden oder mehr als 1000 Gastplätzen im Freien, Beherbergungsstätten mit mehr als 12 Betten und Spielhallen sowie Wettbüros mit jeweils mehr als 150 Quadratmeter Brutto-Grundfläche, 9. Gebäude mit Nutzungseinheiten zum Zwecke der Pflege oder Betreuung […], 10. Krankenhäuser, 11. Wohnheime, 12. Tageseinrichtungen für Kinder, Menschen mit Behinderung und alte Menschen, sonstige Einrichtungen zur Unterbringung von Personen […], 13. Schulen, Hochschulen und ähnliche Einrichtungen, […] 15. Camping- und Wochenendplätze, 16. Freizeit- und Vergnügungsparks, 17. Fliegende Bauten, soweit sie einer Ausführungsgenehmigung bedürfen, 18. Regallager mit einer Oberkante Lagerguthöhe von mehr als 7,50 m, 19. bauliche Anlagen, deren Nutzung durch Umgang mit oder Lagerung von Stoffen mit Explosions- oder erhöhter Brandgefahr verbunden ist, 20. Anlagen und Räume, die in den Nummern 1 bis 19 nicht aufgeführt und deren Art oder Nutzung mit vergleichbaren Gefahren verbunden sind." },
  { id: "escapeRoutes", chapter: "Rettungswege", cite: `${BAUOBLN} § 33 Abs. 1 Satz 1, Abs. 2 und 3`, wording: "verbatim",
    text: "Für Nutzungseinheiten wie Wohnungen, Praxen oder selbständige Betriebsstätten müssen in jedem Geschoss mit Aufenthaltsräumen mindestens zwei voneinander unabhängige Rettungswege ins Freie vorhanden sein; beide Rettungswege dürfen jedoch innerhalb des Geschosses über denselben notwendigen Flur führen. […] Für Nutzungseinheiten nach Absatz 1, die nicht zu ebener Erde liegen, muss der erste Rettungsweg über eine notwendige Treppe führen. Der zweite Rettungsweg kann eine weitere notwendige Treppe oder eine mit Rettungsgeräten der Feuerwehr erreichbare Stelle der Nutzungseinheit sein. Ein zweiter Rettungsweg ist nicht erforderlich, wenn die Rettung über einen Sicherheitstreppenraum möglich ist. Gebäude, deren zweiter Rettungsweg über Rettungsgeräte der Feuerwehr führt und bei denen die Oberkante der Brüstung von zum Anleitern bestimmten Fenstern oder Stellen mehr als 8 Meter über der Geländeoberfläche liegt, dürfen nur errichtet werden, wenn die Feuerwehr über die erforderlichen Rettungsgeräte wie Hubrettungsfahrzeuge verfügt." },
  { id: "loadBearingWalls", chapter: "Tragende Wände, Pfeiler und Stützen", cite: `${BAUOBLN} § 27 Abs. 1 Satz 2, Abs. 2`, wording: "verbatim",
    text: "Sie müssen 1. in Gebäuden der Gebäudeklasse 5 feuerbeständig, 2. in Gebäuden der Gebäudeklasse 4 hochfeuerhemmend, 3. in Gebäuden der Gebäudeklassen 2 und 3 feuerhemmend sein. […] Im Kellergeschoss müssen tragende und aussteifende Wände und Stützen 1. in Gebäuden der Gebäudeklassen 3 bis 5 feuerbeständig, 2. in Gebäuden der Gebäudeklassen 1 und 2 feuerhemmend sein." },
  { id: "exteriorWalls", chapter: "Außenwände", cite: `${BAUOBLN} § 28 Abs. 2, 3 und 5`, wording: "summary",
    text: "Nichttragende Außenwände und nichttragende Teile tragender Außenwände müssen aus nichtbrennbaren Baustoffen bestehen oder als raumabschließende Bauteile feuerhemmend sein. Oberflächen von Außenwänden sowie Außenwandbekleidungen müssen einschließlich der Dämmstoffe und Unterkonstruktionen schwerentflammbar sein. Dies gilt nicht für Gebäude der Gebäudeklassen 1 bis 3." },
  { id: "partitionWalls", chapter: "Trennwände", cite: `${BAUOBLN} § 29 Abs. 2 und 3`, wording: "verbatim",
    text: "Trennwände sind erforderlich 1. zwischen Nutzungseinheiten sowie zwischen Nutzungseinheiten und anders genutzten Räumen, ausgenommen notwendigen Fluren, 2. zum Abschluss von Räumen mit Explosions- oder erhöhter Brandgefahr, 3. zwischen Aufenthaltsräumen und anders genutzten Räumen im Kellergeschoss. Trennwände nach Absatz 2 Nr. 1 und 3 müssen die Feuerwiderstandsfähigkeit der tragenden und aussteifenden Bauteile des Geschosses haben, jedoch mindestens feuerhemmend sein. Trennwände nach Absatz 2 Nr. 2 müssen feuerbeständig sein." },
  { id: "partitionOpenings", chapter: "Trennwände", cite: `${BAUOBLN} § 29 Abs. 4 bis 6`, wording: "verbatim",
    text: "Die Trennwände nach Absatz 2 sind bis zur Rohdecke, im Dachraum bis unter die Dachhaut zu führen; werden in Dachräumen Trennwände nur bis zur Rohdecke geführt, ist diese Decke als raumabschließendes Bauteil einschließlich der sie tragenden und aussteifenden Bauteile feuerhemmend herzustellen. Öffnungen in Trennwänden nach Absatz 2 sind nur zulässig, wenn sie auf die für die Nutzung erforderliche Zahl und Größe beschränkt sind; sie müssen feuerhemmende, dicht- und selbstschließende Abschlüsse haben. Die Absätze 1 bis 5 gelten nicht für Wohngebäude der Gebäudeklassen 1 und 2." },
  { id: "ceilings", chapter: "Decken", cite: `${BAUOBLN} § 31 Abs. 1 Satz 2, Abs. 2 Satz 1`, wording: "verbatim",
    text: "Sie müssen 1. in Gebäuden der Gebäudeklasse 5 feuerbeständig, 2. in Gebäuden der Gebäudeklasse 4 hochfeuerhemmend, 3. in Gebäuden der Gebäudeklassen 2 und 3 feuerhemmend sein. […] Im Kellergeschoss müssen Decken 1. in Gebäuden der Gebäudeklassen 3 bis 5 feuerbeständig, 2. in Gebäuden der Gebäudeklassen 1 und 2 feuerhemmend sein." },
  { id: "stairwellRequired", chapter: "Notwendige Treppenräume", cite: `${BAUOBLN} § 35 Abs. 1 Satz 1 und 3 Nr. 1`, wording: "verbatim",
    text: "Jede notwendige Treppe muss zur Sicherstellung der Rettungswege aus den Geschossen ins Freie in einem eigenen, durchgehenden Treppenraum liegen (notwendiger Treppenraum). […] Notwendige Treppen sind ohne eigenen Treppenraum zulässig 1. in Gebäuden der Gebäudeklassen 1 und 2, […]" },
  { id: "escapeDistance", chapter: "Rettungswege", cite: `${BAUOBLN} § 35 Abs. 2 Satz 1`, wording: "verbatim",
    text: "Von jeder Stelle eines Aufenthaltsraumes sowie eines Kellergeschosses muss mindestens ein Ausgang in einen notwendigen Treppenraum oder ins Freie in höchstens 35 m Entfernung erreichbar sein." },
  { id: "stairwellWalls", chapter: "Notwendige Treppenräume", cite: `${BAUOBLN} § 35 Abs. 4 Satz 1 und 2`, wording: "verbatim",
    text: "Die Wände notwendiger Treppenräume müssen als raumabschließende Bauteile 1. in Gebäuden der Gebäudeklasse 5 die Bauart von Brandwänden haben, 2. in Gebäuden der Gebäudeklasse 4 auch unter zusätzlicher mechanischer Beanspruchung hochfeuerhemmend sein und 3. in Gebäuden der Gebäudeklasse 3 feuerhemmend sein. Dies ist nicht erforderlich für Außenwände von Treppenräumen, die aus nichtbrennbaren Baustoffen bestehen und durch andere an diese Außenwände anschließende Gebäudeteile im Brandfall nicht gefährdet werden können." },
  { id: "stairwellDoors", chapter: "Notwendige Treppenräume", cite: `${BAUOBLN} § 35 Abs. 6 Satz 1`, wording: "verbatim",
    text: "In notwendigen Treppenräumen müssen Öffnungen 1. zu Kellergeschossen, zu nicht ausgebauten Dachräumen, Werkstätten, Läden, Lager- und ähnlichen Räumen sowie zu sonstigen Räumen und Nutzungseinheiten mit einer Fläche von mehr als 200 m² Brutto-Grundfläche, ausgenommen Wohnungen, mindestens feuerhemmende, rauchdichte und selbstschließende Abschlüsse, 2. zu notwendigen Fluren rauchdichte und selbstschließende Abschlüsse, 3. zu sonstigen Räumen und Nutzungseinheiten mindestens dicht- und selbstschließende Abschlüsse haben." },
  { id: "stairwellSmoke", chapter: "Notwendige Treppenräume", cite: `${BAUOBLN} § 35 Abs. 8`, wording: "verbatim",
    text: "Notwendige Treppenräume müssen belüftet und zur Unterstützung wirksamer Löscharbeiten entraucht werden können. Sie müssen 1. in jedem oberirdischen Geschoss unmittelbar ins Freie führende Fenster mit einem freien Querschnitt von mindestens 0,60 Meter x 0,90 Meter (Breite x Höhe) haben, die geöffnet werden können und eine Brüstung von nicht mehr als 1,20 Meter Höhe haben, oder 2. an der obersten Stelle eine Öffnung zur Rauchableitung haben. In den Fällen des Satzes 2 Nummer 1 ist in Gebäuden der Gebäudeklasse 5 an der obersten Stelle eine Öffnung zur Rauchableitung erforderlich; in den Fällen des Satzes 2 Nummer 2 sind in Gebäuden der Gebäudeklassen 4 und 5, soweit dies zur Erfüllung der Anforderungen nach Satz 1 erforderlich ist, besondere Vorkehrungen zu treffen. Öffnungen zur Rauchableitung nach Satz 2 und 3 müssen in jedem Treppenraum einen freien Querschnitt von mindestens einem Quadratmeter und Vorrichtungen zum Öffnen ihrer Abschlüsse haben, die vom Erdgeschoss sowie vom obersten Treppenabsatz aus bedient werden können." },
  { id: "corridorDefinition", chapter: "Notwendige Flure", cite: `${BAUOBLN} § 36 Abs. 1`, wording: "verbatim",
    text: "Flure, über die Rettungswege aus Aufenthaltsräumen oder aus Nutzungseinheiten mit Aufenthaltsräumen zu Ausgängen in notwendige Treppenräume oder ins Freie führen (notwendige Flure), müssen so angeordnet und ausgebildet sein, dass die Nutzung im Brandfall ausreichend lange möglich ist. Notwendige Flure sind nicht erforderlich 1. in Wohngebäuden der Gebäudeklassen 1 und 2, 2. in sonstigen Gebäuden der Gebäudeklassen 1 und 2, ausgenommen in Kellergeschossen, 3. innerhalb von Nutzungseinheiten mit nicht mehr als 200 Quadratmeter Brutto-Grundfläche und innerhalb von Wohnungen, […]" },
  { id: "corridorWalls", chapter: "Notwendige Flure", cite: `${BAUOBLN} § 36 Abs. 4`, wording: "verbatim",
    text: "Die Wände notwendiger Flure müssen als raumabschließende Bauteile feuerhemmend, in Kellergeschossen, deren tragende und aussteifende Bauteile feuerbeständig sein müssen, feuerbeständig sein. Die Wände sind bis an die Rohdecke zu führen. Sie dürfen bis an die Unterdecke der Flure geführt werden, wenn die Unterdecke feuerhemmend und ein nach Satz 1 vergleichbarer Raumabschluss sichergestellt ist. Türen in diesen Wänden müssen dicht schließen; Öffnungen zu Lagerbereichen im Kellergeschoss müssen feuerhemmende, dicht- und selbstschließende Abschlüsse haben." },
  { id: "corridorSmokeSections", chapter: "Notwendige Flure", cite: `${BAUOBLN} § 36 Abs. 3 Satz 1 und 2`, wording: "verbatim",
    text: "Notwendige Flure sind durch nichtabschließbare, rauchdichte und selbstschließende Abschlüsse in Rauchabschnitte zu unterteilen. Die Rauchabschnitte sollen nicht länger als 30 m sein." },
  { id: "rescueWindows", chapter: "Rettungswege", cite: `${BAUOBLN} § 37 Abs. 5 Satz 1`, wording: "verbatim",
    text: "Fenster, die als Rettungswege nach § 33 Abs. 2 Satz 2 dienen, müssen im Lichten mindestens 0,90 m x 1,20 m (Breite x Höhe) groß und dürfen nicht höher als 1,20 m über der Fußbodenoberkante angeordnet sein." },
  { id: "garageClass", chapter: "Garagen", cite: "Muster-Garagenverordnung § 1 Abs. 8 (in Berlin ohne eigene Garagenverordnung)", wording: "summary",
    text: "Garagen mit einer Nutzfläche bis 100 m² sind Kleingaragen, über 100 m² bis 1 000 m² Mittelgaragen, über 1 000 m² Großgaragen." },
  { id: "fireReview", chapter: "Prüfung", cite: `${BAUOBLN} § 66 Abs. 3 Satz 2`, wording: "verbatim",
    text: "Der Brandschutznachweis muss bauaufsichtlich geprüft sein bei 1. Sonderbauten, 2. Mittel- und Großgaragen, 3. Gebäuden der Gebäudeklassen 4 und 5." },
  { id: "fireWater", chapter: "Löschwasserversorgung", cite: "AGBF/DFV-Information 2018-4 i. V. m. DVGW W 405", wording: "summary",
    text: "Löschwasserbedarf für den Grundschutz bei niedriger, in der Regel freistehender Bebauung (bis 3 Vollgeschosse) 800 l/min (48 m³/h), bei sonstiger Bebauung mindestens 1.600 l/min (96 m³/h), jeweils für mindestens 2 Stunden. Erste Entnahmestelle innerhalb von 75 m Lauflinie bis zum Grundstückszugang, gesamte Löschwassermenge im Umkreis von 300 m. Im Brandschutznachweis sind Bedarf und Nachweis darzustellen." },
];
export const fireRequirements: Record<FireCodeState, FireRequirement[]> = { RP: fireRequirementsRp, BE: fireRequirementsBe };
/** A requirement as the state's code words it; undefined where that code has no such rule (Berlin has no rule on notwendige Flure before Treppenräume). */
export const fireRequirement = (id: FireRequirementId, state: FireCodeState) => fireRequirements[state].find(requirement => requirement.id === id);

// ---------------------------------------------------------------------------
// Building class, Sonderbau and deliverable

export type FireBuildingInput = {
  state: string | null;
  /** Floor of the highest storey in which Aufenthaltsräume are possible, on average above the ground surface (§ 2 Abs. 2 Satz 2 LBauO), in metres. */
  height: number | null;
  detached: boolean | null;
  dwellings: number | null;
  otherUnits: number | null;
  /** RLP: Nutzfläche of the whole building; decides GK 2 only when sonstige Nutzungseinheiten replace dwellings. */
  usableArea: number | null;
  /** Berlin: Brutto-Grundfläche of the largest Nutzungseinheit without basement areas; above 400 m² a building up to 13 m is GK 5, not GK 4. */
  largestUnitArea?: number | null;
  /** Berlin: Brutto-Grundfläche of all Nutzungseinheiten together without basement areas; decides GK 1/2 for buildings with up to two units. */
  unitsGrossArea?: number | null;
  storeysAboveGround: number | null;
  specialUse: FireSpecialUse | null;
  garageArea: number | null;
};
export type FireClassification = {
  supported: boolean;
  /** The code applied; null when the state is open or not covered. */
  state: FireCodeState | null;
  buildingClass: FireBuildingClass | null;
  highRise: boolean;
  specialUse: FireSpecialUse | null;
  garage: GarageSize | null;
  /** Plans only (Brandschutznachweis) or plans plus the written part (Brandschutzkonzept); null while the class or Sonderbau is open. */
  deliverable: "nachweis" | "konzept" | null;
  /**
   * Who checks it. RLP: nobody (§ 66 Abs. 1), a Prüfsachverständige/r for
   * Brandschutz (§ 66 Abs. 2, § 65 Abs. 4), or the authority or a
   * Prüfsachverständige/r (§ 65). Berlin: bauaufsichtlich geprüft by a
   * Prüfingenieur/in für Brandschutz (§ 66 Abs. 3 Satz 2 BauO Bln) or nobody.
   */
  review: "none" | "psv" | "authority_or_psv" | "check_engineer" | null;
  /** Inputs that must be entered before the class or deliverable can be decided. */
  gaps: Array<keyof FireBuildingInput>;
  notes: Array<"hillsideThirdDwelling" | "garageExtendedContent" | "gk1SimilarSize">;
};

export const garageSize = (area: number | null): GarageSize | null => area === null || area <= 0 ? null : area <= 100 ? "small" : area <= 1000 ? "medium" : "large";

/** RP § 37(2), opening dimensions/operation only. This does NOT establish an
 * independent second route, ladder access, roof access or applicable edition.
 * Missing measurements are not zero; width and height cannot be interchanged.
 * Official provision effective 13 Feb 2021 (checked 24 Oct 2026):
 * https://www.landesrecht.rlp.de/bsrp/document/jlr-NNLRP00005B3ENN00000000126
 */
export function assessRescueWindow(state: string | null, input: FireRescueWindow) {
  const supported = state === "RP";
  const enabled = supported && input.designated === true;
  const checks = {
    clearWidth: enabled && input.clearWidth !== null ? input.clearWidth >= 0.9 : null,
    clearHeight: enabled && input.clearHeight !== null ? input.clearHeight >= 1.2 : null,
    sillHeight: enabled && input.sillHeight !== null ? input.sillHeight <= 1.2 : null,
    openableInside: enabled ? input.openableInside : null,
  };
  const status = !state ? "open" : !supported ? "unsupported" : input.designated === false ? "not_designated"
    : Object.values(checks).some(value => value === false) ? "not_met"
    : input.location === "facade" && Object.values(checks).every(value => value === true) ? "met" : "open";
  return { status, checks, cite: supported ? "LBauO RLP § 37 Abs. 2 Satz 1" : null } as const;
}

/**
 * Building class under § 2 Abs. 2 LBauO RLP. Unlike the Musterbauordnung, RLP
 * caps neither GK 2 nor GK 4 by unit size, and GK 2 allows other units only
 * while the building's Nutzfläche stays within 400 m². GK 1's "andere
 * freistehende Gebäude ähnlicher Größe" is a judgement and never inferred.
 */
export function fireBuildingClassRp(input: FireBuildingInput): { buildingClass: FireBuildingClass | null; gaps: FireClassification["gaps"]; notes: FireClassification["notes"] } {
  const { height } = input;
  if (height === null) return { buildingClass: null, gaps: ["height"], notes: [] };
  if (height > 13) return { buildingClass: 5, gaps: [], notes: [] };
  if (height > 7) return { buildingClass: 4, gaps: [], notes: [] };
  const gaps: FireClassification["gaps"] = [];
  if (input.dwellings === null) gaps.push("dwellings");
  if (input.otherUnits === null) gaps.push("otherUnits");
  if (gaps.length) return { buildingClass: null, gaps, notes: [] };
  const dwellings = input.dwellings!, other = input.otherUnits!;
  if (other === 0 && dwellings === 1 && input.detached !== false) {
    const missing: FireClassification["gaps"] = [...(input.detached === null ? ["detached" as const] : []), ...(input.storeysAboveGround === null ? ["storeysAboveGround" as const] : [])];
    if (missing.length) return { buildingClass: null, gaps: missing, notes: [] };
    if (input.storeysAboveGround! <= 2) return { buildingClass: 1, gaps: [], notes: [] };
  }
  if (other === 0) return dwellings <= 2 ? { buildingClass: 2, gaps: [], notes: [] }
    : { buildingClass: 3, gaps: [], notes: dwellings === 3 ? ["hillsideThirdDwelling"] : [] };
  if (dwellings + other > 2) return { buildingClass: 3, gaps: [], notes: [] };
  if (input.usableArea === null) return { buildingClass: null, gaps: ["usableArea"], notes: [] };
  return { buildingClass: input.usableArea <= 400 ? 2 : 3, gaps: [], notes: dwellings + other === 1 && input.detached ? ["gk1SimilarSize"] : [] };
}

/**
 * Building class under § 2 Abs. 3 BauO Bln (as the Musterbauordnung): up to
 * 7 m GK 1–3 by the number and Brutto-Grundfläche of the units, up to 13 m
 * GK 4 while every unit stays within 400 m² BGF, otherwise GK 5. The
 * land- or forstwirtschaftliche GK 1 is not inferred.
 */
export function fireBuildingClassBe(input: FireBuildingInput): { buildingClass: FireBuildingClass | null; gaps: FireClassification["gaps"]; notes: FireClassification["notes"] } {
  const { height } = input;
  if (height === null) return { buildingClass: null, gaps: ["height"], notes: [] };
  if (height > 13) return { buildingClass: 5, gaps: [], notes: [] };
  if (height > 7) {
    const largest = input.largestUnitArea ?? null;
    return largest === null ? { buildingClass: null, gaps: ["largestUnitArea"], notes: [] } : { buildingClass: largest <= 400 ? 4 : 5, gaps: [], notes: [] };
  }
  const gaps: FireClassification["gaps"] = [];
  if (input.dwellings === null) gaps.push("dwellings");
  if (input.otherUnits === null) gaps.push("otherUnits");
  if (gaps.length) return { buildingClass: null, gaps, notes: [] };
  if (input.dwellings! + input.otherUnits! > 2) return { buildingClass: 3, gaps: [], notes: [] };
  const total = input.unitsGrossArea ?? null;
  if (total === null) return { buildingClass: null, gaps: ["unitsGrossArea"], notes: [] };
  if (total > 400) return { buildingClass: 3, gaps: [], notes: [] };
  if (input.detached === null) return { buildingClass: null, gaps: ["detached"], notes: [] };
  return { buildingClass: input.detached ? 1 : 2, gaps: [], notes: [] };
}

/**
 * The building's class, Sonderbau and what the specialist has to deliver.
 * A written concept is required for GK 4, GK 5 and every Sonderbau (the
 * office standard; RLP itself lets the Nachweis sit in plans and description,
 * § 5 Abs. 2 BauuntPrüfVO). Mittel- and Großgaragen add the Sonderbau content
 * of § 5 Abs. 2 Satz 2 BauuntPrüfVO but do not by themselves require a concept.
 */
export function classifyFireBuilding(input: FireBuildingInput): FireClassification {
  const supported = fireCodeSupported(input.state);
  const garage = garageSize(input.garageArea);
  if (!supported) return { supported, state: null, buildingClass: null, highRise: false, specialUse: input.specialUse, garage, deliverable: null, review: null, gaps: input.state ? [] : ["state"], notes: [] };
  const state = input.state as FireCodeState;
  const { buildingClass, gaps, notes } = state === "BE" ? fireBuildingClassBe(input) : fireBuildingClassRp(input);
  const highRise = input.height !== null && input.height > 22;
  const special = highRise || (input.specialUse !== null && input.specialUse !== "none");
  const specialGaps: FireClassification["gaps"] = input.specialUse === null && !highRise ? ["specialUse"] : [];
  const deliverable = special || (buildingClass !== null && buildingClass >= 4) ? "konzept"
    : buildingClass === null || specialGaps.length ? null : "nachweis";
  const residential = (input.otherUnits ?? 0) === 0;
  // § 66 Abs. 3 Satz 2 BauO Bln: Sonderbauten, Mittel- und Großgaragen and GK 4–5 are checked; everything else is not.
  if (state === "BE") {
    const checked = special || garage === "medium" || garage === "large" || (buildingClass !== null && buildingClass >= 4);
    const review = checked ? "check_engineer" as const : buildingClass === null || specialGaps.length ? null : "none" as const;
    return { supported, state, buildingClass, highRise, specialUse: input.specialUse, garage, deliverable, review, gaps: [...gaps, ...specialGaps], notes };
  }
  const review = special ? (highRise || input.specialUse !== "office" ? "authority_or_psv" : "psv")
    : buildingClass === null || specialGaps.length ? null
    : buildingClass >= 4 ? "psv"
    : residential || buildingClass <= 2 ? "none" : "authority_or_psv";
  return { supported, state, buildingClass, highRise, specialUse: input.specialUse, garage, deliverable, review, gaps: [...gaps, ...specialGaps],
    notes: [...notes, ...(garage === "medium" || garage === "large" ? ["garageExtendedContent" as const] : [])] };
}

// ---------------------------------------------------------------------------
// Ratings and closures

const ratingProfile: Record<FireRating, { minutes: number; mechanical: boolean; nonCombustible: boolean }> = {
  nb: { minutes: 0, mechanical: false, nonCombustible: true },
  fh: { minutes: 30, mechanical: false, nonCombustible: false }, hf: { minutes: 60, mechanical: false, nonCombustible: false }, hf_m: { minutes: 60, mechanical: true, nonCombustible: false },
  fb: { minutes: 90, mechanical: false, nonCombustible: false }, fb_nb_m: { minutes: 90, mechanical: true, nonCombustible: true },
};
/** Whether a declared rating meets a requirement: at least as long, resistant to mechanical load and nichtbrennbar where that is required. */
export const ratingSatisfies = (actual: FireRating, required: FireRating) => {
  const a = ratingProfile[actual], r = ratingProfile[required];
  return a.minutes >= r.minutes && (a.mechanical || !r.mechanical) && (a.nonCombustible || !r.nonCombustible);
};
/** The weakest rating that meets every requirement. */
export const combineRatings = (ratings: FireRating[]): FireRating | null =>
  ratings.length ? fireRatingSchema.options.find(rating => ratings.every(required => ratingSatisfies(rating, required)))! : null;

type ClosureProfile = { minutes: number; smokeTight: boolean; selfClosing: boolean; solid: boolean };
const closureProfile: Record<FireClosure, ClosureProfile> = {
  D: { minutes: 0, smokeTight: false, selfClosing: false, solid: false },
  DS: { minutes: 0, smokeTight: false, selfClosing: true, solid: false },
  V_DS: { minutes: 0, smokeTight: false, selfClosing: true, solid: true },
  RS: { minutes: 0, smokeTight: true, selfClosing: true, solid: false },
  T30_DS: { minutes: 30, smokeTight: false, selfClosing: true, solid: true },
  T30_RS: { minutes: 30, smokeTight: true, selfClosing: true, solid: true },
  T90_DS: { minutes: 90, smokeTight: false, selfClosing: true, solid: true },
  T90_RS: { minutes: 90, smokeTight: true, selfClosing: true, solid: true },
};
/** Every closure is at least dicht schließend; rauchdicht implies it. */
export function closureSatisfies(actual: FireClosure, required: FireClosure) {
  const a = closureProfile[actual], r = closureProfile[required];
  return a.minutes >= r.minutes && (a.smokeTight || !r.smokeTight) && (a.selfClosing || !r.selfClosing) && (a.solid || !r.solid);
}
/** The weakest closure that meets every requirement (codes are ordered weakest first). */
export const combineClosures = (closures: FireClosure[]): FireClosure | null =>
  closures.length ? fireClosureSchema.options.find(code => closures.every(required => closureSatisfies(code, required)))! : null;

// ---------------------------------------------------------------------------
// Rooms, walls, slabs and doors

export type FireRoomInput = { spaceType: string | null; roomUse: string | null; name: string };
const habitableUses = new Set(["living_dining_kitchen", "bedroom", "child_room", "office"]);
const habitableName = /wohn|schlaf|kind|zimmer|essen|küche|kueche|kochen|arbeit|büro|buero|studio|gast/i;
const ancillaryName = /bad|dusche|wc|abstell|\bar\b|flur|diele|garderobe|hwr|hausw|technik|keller|lager|speis|ankleide|balkon|loggia|terrasse/i;

/**
 * A room's escape role from its space type, use and the building class. A
 * stairwell is a notwendiger Treppenraum and a common corridor a notwendiger
 * Flur only from GK 3 (§ 34 Abs. 1, § 35 Abs. 1 Satz 2 Nr. 2). Null while the
 * class or space type is open. A person's entered role always wins.
 */
export function deriveFireRoomRole(room: FireRoomInput, buildingClass: FireBuildingClass | null): FireRoomRole | null {
  if (room.spaceType === "stairwell" || room.spaceType === "common_corridor") {
    if (buildingClass === null) return null;
    return buildingClass < 3 ? "other" : room.spaceType === "stairwell" ? "necessary_stairwell" : "necessary_corridor";
  }
  if (room.spaceType !== "apartment") return room.spaceType ? "other" : null;
  if (room.roomUse && room.roomUse !== "other_unknown") return habitableUses.has(room.roomUse) ? "habitable" : "other";
  return habitableName.test(room.name) && !ancillaryName.test(room.name) ? "habitable" : "other";
}

/** A room on one side of a component. `smokeVent` is set on a notwendiger Treppenraum vented differently from the building default. */
export type FireSpace = { role: FireRoomRole | null; unit: string | null; basement: boolean; roomUse?: string | null; smokeVent?: StairwellSmokeVent | null };
export type FireReason<T> = { requirement: FireRequirementId; value: T };
export type FireComponentRequirement<T> = { required: T | null; reasons: Array<FireReason<T>> };

/**
 * The ratings each state's code sets, by building class and whether the
 * storey is a basement. RLP: § 27, § 29 Abs. 2, § 31, § 34 Abs. 6, § 35
 * Abs. 3 LBauO. Berlin: § 27, § 29 Abs. 3, § 31, § 35 Abs. 4, § 36 Abs. 4
 * BauO Bln; Trennwände there take the storey's load-bearing rating (at least
 * feuerhemmend) and do not apply in Wohngebäude of GK 1 and 2.
 */
const ratingRules: Record<FireCodeState, {
  loadBearing: (gk: FireBuildingClass, basement: boolean) => FireRating | null;
  ceiling: (gk: FireBuildingClass, basement: boolean) => FireRating | null;
  partition: (gk: FireBuildingClass, basement: boolean, residential: boolean) => FireRating | null;
  stairwell: (gk: FireBuildingClass, basement: boolean) => FireRating | null;
  corridor: (gk: FireBuildingClass, basement: boolean) => FireRating | null;
}> = {
  RP: {
    loadBearing: (gk, basement) => gk === 5 ? "fb" : gk === 4 || gk === 3 ? (basement ? "fb" : gk === 4 ? "hf" : "fh") : gk === 2 ? "fh" : null,
    ceiling: (gk, basement) => gk === 5 ? "fb" : gk === 4 || gk === 3 ? (basement ? "fb" : gk === 4 ? "hf" : "fh") : gk === 2 ? "fh" : null,
    partition: (gk) => gk === 5 ? "fb" : gk === 4 ? "hf" : gk >= 2 ? "fh" : null,
    stairwell: (gk, basement) => gk === 5 ? "fb_nb_m" : gk === 4 ? (basement ? "fb" : "hf_m") : gk === 3 ? (basement ? "fb" : "hf") : null,
    corridor: (gk) => gk >= 3 ? "fh" : null,
  },
  BE: {
    loadBearing: (gk, basement) => basement ? (gk >= 3 ? "fb" : "fh") : gk === 5 ? "fb" : gk === 4 ? "hf" : gk >= 2 ? "fh" : null,
    ceiling: (gk, basement) => basement ? (gk >= 3 ? "fb" : "fh") : gk === 5 ? "fb" : gk === 4 ? "hf" : gk >= 2 ? "fh" : null,
    partition: (gk, basement, residential) => gk <= 2 && residential ? null : combineRatings(["fh", ...[ratingRules.BE.loadBearing(gk, basement)].filter((rating): rating is FireRating => Boolean(rating))]),
    stairwell: (gk) => gk === 5 ? "fb_nb_m" : gk === 4 ? "hf_m" : gk === 3 ? "fh" : null,
    corridor: (gk, basement) => gk >= 3 ? (basement ? "fb" : "fh") : null,
  },
};
/** The slab above a storey (§ 31); "basement" is the storey below it. */
export const ceilingRequirement = (state: FireCodeState, gk: FireBuildingClass | null, basement: boolean): FireComponentRequirement<FireRating> => {
  const required = gk === null ? null : ratingRules[state].ceiling(gk, basement);
  return { required, reasons: required ? [{ requirement: "ceilings", value: required }] : [] };
};

/** Two spaces are separated by a Trennwand when one lies in a unit and the other is outside that unit (another unit or a common space). */
const separatesUnits = (a: FireSpace, b: FireSpace) => Boolean((a.unit || b.unit) && a.unit !== b.unit);

/**
 * Requirement on a wall from the spaces on its two faces: Treppenraumwand
 * (§ 34 Abs. 6), Wand eines notwendigen Flurs (§ 35 Abs. 3), Trennwand
 * (§ 29) and, for walls marked load-bearing, § 27. The strictest applies.
 * Walls of notwendige Treppenräume and Flure follow their own rule, not § 29,
 * as the office draws it (a dwelling's wall to the notwendiger Flur is
 * feuerhemmend in GK 4). A Treppenraum's exterior wall is drawn nichtbrennbar
 * (§ 34 Abs. 6 Satz 2) unless it is load-bearing, when Satz 1 applies; only
 * walls bounding nothing but the Treppenraum are marked. Other
 * exterior walls only carry § 27; § 28 is listed in the written part.
 */
export function fireWallRequirement(input: { state: FireCodeState; buildingClass: FireBuildingClass | null; basement: boolean; loadBearing: boolean | null;
  /** A Wohngebäude: Berlin sets no Trennwände in GK 1 and 2 for it. */
  residential?: boolean;
  faces: Array<{ exterior: boolean; spaces: FireSpace[] }> }): FireComponentRequirement<FireRating> {
  const gk = input.buildingClass;
  if (gk === null) return { required: null, reasons: [] };
  const rules = ratingRules[input.state];
  const reasons: Array<FireReason<FireRating>> = [];
  const add = (requirement: FireRequirementId, value: FireRating | null) => { if (value && !reasons.some(reason => reason.requirement === requirement)) reasons.push({ requirement, value }); };
  if (input.loadBearing) add("loadBearingWalls", rules.loadBearing(gk, input.basement));
  const [a, b] = input.faces;
  const escapeSpace = (space: FireSpace) => space.role === "necessary_stairwell" || space.role === "necessary_corridor";
  if (a && b && !a.exterior && !b.exterior) {
    for (const x of a.spaces) for (const y of b.spaces) for (const [p, q] of [[x, y], [y, x]] as const) {
      if (p.role === "necessary_stairwell" && q.role !== "necessary_stairwell") add("stairwellWalls", rules.stairwell(gk, input.basement || q.basement));
      if (p.role === "necessary_corridor" && q.role !== "necessary_corridor") add("corridorWalls", rules.corridor(gk, input.basement || q.basement));
      const partition = rules.partition(gk, input.basement, input.residential ?? true);
      if (separatesUnits(p, q) && !escapeSpace(p) && !escapeSpace(q)) add("partitionWalls", partition);
      // § 29 Abs. 2 Nr. 3 BauO Bln: between Aufenthaltsräume and other rooms in the basement, also within one unit.
      if (input.state === "BE" && p.basement && q.basement && p.role === "habitable" && q.role !== "habitable" && !escapeSpace(q)) add("partitionWalls", partition);
    }
  } else if (a && b && a.exterior !== b.exterior && (a.exterior ? b : a).spaces.length > 0 && (a.exterior ? b : a).spaces.every(space => space.role === "necessary_stairwell")) {
    // Only a facade wall of the Treppenraum alone; a wall element running past other rooms would otherwise be marked along its whole length.
    add("stairwellWalls", input.loadBearing ? rules.stairwell(gk, input.basement) : gk >= 3 ? "nb" : null);
  }
  return { required: combineRatings(reasons.map(reason => reason.value)), reasons };
}

const storageLike = new Set(["storage", "utility_technical"]);

/**
 * Requirement on a door from the spaces it connects: doors of notwendige
 * Treppenräume (§ 34 Abs. 9, Abs. 11 Satz 4), doors in walls of notwendigen
 * Fluren (§ 35 Abs. 3) and other openings in Trennwände (§ 29 Abs. 3). As in
 * the LBauO RLP checklist, the Treppenraum and Flur rules take precedence over
 * § 29 Abs. 3 for their own doors. Doors to the outside carry none. Storage and
 * technical rooms count as Lagerräume. Berlin (§ 35 Abs. 6, § 36 Abs. 4 BauO
 * Bln) has the same Treppenraum doors, but a smoke opening at the top asks for
 * "besondere Vorkehrungen" instead of T 30-RS doors, and doors from a
 * notwendiger Flur to basement storage are T 30-DS.
 */
export function fireDoorRequirement(input: { state: FireCodeState; buildingClass: FireBuildingClass | null; smokeVent: StairwellSmokeVent | null;
  sides: [FireSpace | null, FireSpace | null] }): FireComponentRequirement<FireClosure> {
  const gk = input.buildingClass;
  const [a, b] = input.sides;
  if (gk === null || !a || !b) return { required: null, reasons: [] };
  const reasons: Array<FireReason<FireClosure>> = [];
  for (const [p, q] of [[a, b], [b, a]] as const) {
    if (p.role === "necessary_stairwell" && q.role !== "necessary_stairwell") {
      const value: FireClosure = q.basement || storageLike.has(q.roomUse ?? "") ? "T30_RS" : q.role === "necessary_corridor" ? "RS"
        : input.state === "RP" && gk >= 4 && (p.smokeVent ?? input.smokeVent) === "top_opening" ? "T30_RS" : "DS";
      reasons.push({ requirement: value === "T30_RS" && !q.basement && !storageLike.has(q.roomUse ?? "") ? "stairwellSmoke" : "stairwellDoors", value });
    }
    if (p.role === "necessary_corridor" && q.role !== "necessary_corridor" && q.role !== "necessary_stairwell")
      reasons.push({ requirement: "corridorWalls", value: input.state === "BE" && q.basement && storageLike.has(q.roomUse ?? "") ? "T30_DS" : "D" });
  }
  // § 34 Abs. 9 and § 35 Abs. 3 are the specific rules for doors of Treppenräume and notwendigen Fluren; § 29 Abs. 3 covers the other doors between units.
  const escapeSpace = (space: FireSpace) => space.role === "necessary_stairwell" || space.role === "necessary_corridor";
  if (separatesUnits(a, b) && !escapeSpace(a) && !escapeSpace(b)) reasons.push({ requirement: "partitionOpenings", value: "T30_DS" });
  const unique = reasons.filter((reason, index) => reasons.findIndex(other => other.requirement === reason.requirement) === index);
  return { required: combineClosures(unique.map(reason => reason.value)), reasons: unique };
}

/** Status of a component against its requirement from its declared rating or closure. */
export const fireComponentStatus = <T extends FireRating | FireClosure>(required: T | null, actual: T | null, satisfies: (actual: T, required: T) => boolean) =>
  required === null ? "none" as const : actual === null ? "open" as const : satisfies(actual, required) ? "met" as const : "not_met" as const;

// ---------------------------------------------------------------------------
// Escape route lengths (§ 34 Abs. 2)

export type PlanPointM = { x: number; y: number };
export type EscapeRoom = { id: string; polygon: PlanPointM[]; role: FireRoomRole | null; basement: boolean };
/** A door with the rooms on its two sides; null is outside the building. */
export type EscapeDoor = { id: string; point: PlanPointM; rooms: [string | null, string | null] };
/** The longest route from a room: its length, where it starts, the room door it leaves through and the walking line to the exit, as drawn in a Brandschutzplan. */
export type EscapeRoute = { roomId: string; length: number; from: PlanPointM; doorId: string; path: PlanPointM[] };
export const maxEscapeDistance = 35;

const dist = (a: PlanPointM, b: PlanPointM) => Math.hypot(a.x - b.x, a.y - b.y);
const cross = (o: PlanPointM, a: PlanPointM, b: PlanPointM) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
function onSegment(p: PlanPointM, a: PlanPointM, b: PlanPointM, eps = 1e-6) {
  return Math.abs(cross(a, b, p)) <= eps * Math.max(1, dist(a, b)) && Math.min(a.x, b.x) - eps <= p.x && p.x <= Math.max(a.x, b.x) + eps && Math.min(a.y, b.y) - eps <= p.y && p.y <= Math.max(a.y, b.y) + eps;
}
function insideOrOn(p: PlanPointM, ring: PlanPointM[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if (onSegment(p, a, b)) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
/** A straight walk inside the room: it crosses no edge and every sampled point lies in the room or on its boundary. */
function walkable(p: PlanPointM, q: PlanPointM, ring: PlanPointM[]) {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!, b = ring[i]!;
    const d1 = cross(a, b, p), d2 = cross(a, b, q), d3 = cross(p, q, a), d4 = cross(p, q, b);
    if (((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))) return false;
  }
  for (let k = 1; k < 8; k++) if (!insideOrOn({ x: p.x + (q.x - p.x) * k / 8, y: p.y + (q.y - p.y) * k / 8 }, ring)) return false;
  return true;
}
function closestOnRing(p: PlanPointM, ring: PlanPointM[]) {
  let best = ring[0]!, bestDistance = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!, b = ring[i]!, dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
    const candidate = { x: a.x + dx * t, y: a.y + dy * t }, d = dist(p, candidate);
    if (d < bestDistance) { best = candidate; bestDistance = d; }
  }
  return { point: best, distance: bestDistance };
}
/** Shortest walking distance and line inside a room from a source to any point (visibility graph). */
function geodesicField(source: PlanPointM, ring: PlanPointM[]) {
  const nodes = [source, ...ring], distances = nodes.map((_, index) => index === 0 ? 0 : Infinity), done = nodes.map(() => false), previous = nodes.map(() => -1);
  for (;;) {
    let current = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && distances[i]! < Infinity && (current < 0 || distances[i]! < distances[current]!)) current = i;
    if (current < 0) break;
    done[current] = true;
    for (let i = 0; i < nodes.length; i++) if (!done[i]) {
      const candidate = distances[current]! + dist(nodes[current]!, nodes[i]!);
      if (candidate < distances[i]! && walkable(nodes[current]!, nodes[i]!, ring)) { distances[i] = candidate; previous[i] = current; }
    }
  }
  const nearest = (point: PlanPointM) => {
    let best = Infinity, via = -1;
    for (let i = 0; i < nodes.length; i++) if (distances[i]! < Infinity && distances[i]! + dist(nodes[i]!, point) < best && walkable(nodes[i]!, point, ring)) { best = distances[i]! + dist(nodes[i]!, point); via = i; }
    return { distance: best, via };
  };
  return {
    distance: (point: PlanPointM) => nearest(point).distance,
    /** The walking line from the source to the point, around the room's corners. */
    path: (point: PlanPointM) => {
      const line = [point];
      for (let i = nearest(point).via; i >= 0; i = previous[i]!) line.unshift(nodes[i]!);
      return line;
    },
  };
}
/** Points where the longest route can start: every corner and points every half metre along the walls. */
function boundarySamples(ring: PlanPointM[], spacing = .5) {
  const samples: PlanPointM[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!, steps = Math.max(1, Math.ceil(dist(a, b) / spacing));
    for (let k = 0; k < steps; k++) samples.push({ x: a.x + (b.x - a.x) * k / steps, y: a.y + (b.y - a.y) * k / steps });
  }
  return samples;
}

/**
 * The longest walking distance from any point of each Aufenthaltsraum (and of
 * every basement room) to the nearest door into a notwendiger Treppenraum or
 * to the outside, along the shortest line through rooms and doors: not
 * through walls, furniture ignored (§ 34 Abs. 2 LBauO, measured as in the
 * LBauO checklist). Doors further than `snap` metres from a room's outline
 * are not taken as its doors. Rooms without a route are left out.
 */
export function escapeRouteLengths(rooms: EscapeRoom[], doors: EscapeDoor[], snap = 1): EscapeRoute[] {
  const byId = new Map(rooms.filter(room => room.polygon.length >= 3).map(room => [room.id, room]));
  const isExit = (door: EscapeDoor) => door.rooms.some(id => id === null || byId.get(id)?.role === "necessary_stairwell");
  // Entry point of each door into each room it opens into.
  const entries = new Map<string, Array<{ door: EscapeDoor; entry: PlanPointM; offset: number }>>();
  for (const door of doors) for (const id of door.rooms) {
    const room = id ? byId.get(id) : undefined;
    if (!room || room.role === "necessary_stairwell") continue;
    const { point, distance } = closestOnRing(door.point, room.polygon);
    if (distance > snap) continue;
    entries.set(room.id, [...(entries.get(room.id) ?? []), { door, entry: point, offset: distance }]);
  }
  const fields = new Map<string, Map<string, ReturnType<typeof geodesicField>>>();
  const fieldOf = (roomId: string, doorId: string) => {
    const roomFields = fields.get(roomId) ?? new Map<string, ReturnType<typeof geodesicField>>();
    fields.set(roomId, roomFields);
    if (!roomFields.has(doorId)) {
      const entry = entries.get(roomId)!.find(item => item.door.id === doorId)!;
      roomFields.set(doorId, geodesicField(entry.entry, byId.get(roomId)!.polygon));
    }
    return roomFields.get(doorId)!;
  };
  // Distance from each door to an exit, walking through the rooms between doors (Dijkstra over doors).
  const exitDistance = new Map<string, number>(doors.filter(isExit).map(door => [door.id, 0]));
  // The next door toward the exit and the room walked through to reach it.
  const next = new Map<string, { doorId: string; roomId: string }>();
  const settled = new Set<string>();
  for (;;) {
    let current: string | null = null;
    for (const [id, value] of exitDistance) if (!settled.has(id) && (current === null || value < exitDistance.get(current)!)) current = id;
    if (current === null) break;
    settled.add(current);
    const base = exitDistance.get(current)!;
    for (const [roomId, items] of entries) {
      const from = items.find(item => item.door.id === current);
      if (!from) continue;
      for (const to of items) {
        if (to.door.id === current || settled.has(to.door.id)) continue;
        const walk = base + from.offset + fieldOf(roomId, current).distance(to.entry) + to.offset;
        if (walk < (exitDistance.get(to.door.id) ?? Infinity)) { exitDistance.set(to.door.id, walk); next.set(to.door.id, { doorId: current, roomId }); }
      }
    }
  }
  const routes: EscapeRoute[] = [];
  for (const room of byId.values()) {
    if (room.role !== "habitable" && !room.basement) continue;
    if (room.role === "necessary_stairwell") continue;
    const exits = (entries.get(room.id) ?? []).filter(item => exitDistance.has(item.door.id));
    if (!exits.length) continue;
    let worst: EscapeRoute | null = null;
    for (const point of boundarySamples(room.polygon)) {
      let best: { length: number; door: string } | null = null;
      for (const item of exits) {
        const length = fieldOf(room.id, item.door.id).distance(point) + item.offset + exitDistance.get(item.door.id)!;
        if (!best || length < best.length) best = { length, door: item.door.id };
      }
      if (best && best.length < Infinity && (!worst || best.length > worst.length)) worst = { roomId: room.id, length: best.length, from: point, doorId: best.door, path: [] };
    }
    if (!worst) continue;
    const doorPoint = (id: string) => doors.find(door => door.id === id)!.point;
    const entry = (roomId: string, doorId: string) => entries.get(roomId)!.find(item => item.door.id === doorId)!.entry;
    const path = [...fieldOf(room.id, worst.doorId).path(worst.from).reverse(), doorPoint(worst.doorId)];
    for (let door = worst.doorId, hop = next.get(door); hop; door = hop.doorId, hop = next.get(door)) path.push(...fieldOf(hop.roomId, door).path(entry(hop.roomId, hop.doorId)), doorPoint(hop.doorId));
    routes.push({ ...worst, length: Math.round(worst.length * 100) / 100, path });
  }
  return routes;
}

// ---------------------------------------------------------------------------
// Fire water (AGBF 2018-4)

/** Grundschutz fire water: 800 l/min for low, usually detached buildings with up to three Vollgeschosse, otherwise at least 1,600 l/min, each for two hours. */
export const fireWaterDemand = (fullStoreys: number | null, detached: boolean | null) =>
  fullStoreys === null ? null : fullStoreys <= 3 && detached !== false ? { litresPerMinute: 800, cubicMetresPerHour: 48 } : { litresPerMinute: 1600, cubicMetresPerHour: 96 };

// ---------------------------------------------------------------------------
// Written part: draft text in the fixed order requirement, then implementation

export const fireRatingText: Record<FireRating, string> = {
  nb: "aus nichtbrennbaren Baustoffen", fh: "feuerhemmend", hf: "hochfeuerhemmend", hf_m: "hochfeuerhemmend, auch unter zusätzlicher mechanischer Beanspruchung",
  fb: "feuerbeständig", fb_nb_m: "in der Bauart von Brandwänden (feuerbeständig, nichtbrennbar, auch unter zusätzlicher mechanischer Beanspruchung)",
};
export const fireClosureText: Record<FireClosure, string> = {
  D: "dicht schließend (D)", DS: "dicht- und selbstschließend (DS)", V_DS: "vollwandig, dicht- und selbstschließend (V-DS)", RS: "rauchdicht und selbstschließend (RS)",
  T30_DS: "feuerhemmend, dicht- und selbstschließend (T 30-DS)", T30_RS: "feuerhemmend, rauchdicht und selbstschließend (T 30-RS)",
  T90_DS: "feuerbeständig, dicht- und selbstschließend (T 90-DS)", T90_RS: "feuerbeständig, rauchdicht und selbstschließend (T 90-RS)",
};
const specialUseTextRp: Record<FireSpecialUse, string> = {
  none: "kein Sonderbau", retail: "Verkaufsstätte (§ 50 Abs. 2 Nr. 2)", assembly: "Versammlungsstätte (Nr. 3)", office: "Büro- und Verwaltungsgebäude (Nr. 4)",
  restaurant_hotel: "Gaststätte, Beherbergungsbetrieb (Nr. 5)", care: "Einrichtung der Gesundheitspflege, Pflege oder Betreuung, Wohnheim (Nr. 6)", childcare: "Kindertagesstätte, Einrichtung für Kinder und Jugendliche (Nr. 7)",
  school_sports: "Schule, Sportstätte (Nr. 8)", large_or_hazard: "Anlage großer Ausdehnung oder erhöhter Brand-, Explosions- oder Verkehrsgefahr (Nr. 9)", commercial: "Anlage für gewerbliche Betriebe (Nr. 10)",
  emissions: "Nutzung mit starkem Abgang schädlicher Stoffe (Nr. 11)", temporary: "Fliegender Bau (Nr. 12)", camping: "Camping- und Wochenendplatz (Nr. 13)",
};
const specialUseTextBe: Record<FireSpecialUse, string> = {
  none: "kein Sonderbau", retail: "Verkaufsstätte (§ 2 Abs. 4 Nr. 4)", assembly: "Versammlungsstätte oder Räume für mehr als 100 Personen (Nr. 6, 7)", office: "Büro- und Verwaltungsnutzung (Nr. 5)",
  restaurant_hotel: "Gaststätte, Beherbergungsstätte (Nr. 8)", care: "Pflege oder Betreuung, Krankenhaus, Wohnheim (Nr. 9 bis 11)", childcare: "Tageseinrichtung, Einrichtung zur Unterbringung (Nr. 12)",
  school_sports: "Schule, Hochschule (Nr. 13)", large_or_hazard: "große Ausdehnung, Regallager oder Explosions- oder erhöhte Brandgefahr (Nr. 3, 18, 19)", commercial: "Anlage mit vergleichbaren Gefahren (Nr. 20)",
  emissions: "Anlage mit vergleichbaren Gefahren (Nr. 20)", temporary: "Fliegender Bau (Nr. 17)", camping: "Camping- und Wochenendplatz (Nr. 15)",
};
const specialUseText: Record<FireCodeState, Record<FireSpecialUse, string>> = { RP: specialUseTextRp, BE: specialUseTextBe };

export type FireConceptInput = {
  classification: FireClassification;
  height: number | null;
  dwellings: number | null;
  garageEnclosure: "open" | "closed" | null;
  /** Every notwendiger Treppenraum with how it is vented (its own value or the building default). */
  stairwells: Array<{ name: string; smokeVent: StairwellSmokeVent | null }>;
  components: Array<{ kind: "wall" | "ceiling" | "door"; name: string; status: "none" | "met" | "not_met" | "open"; reasons: Array<FireReason<FireRating | FireClosure>> }>;
  routes: Array<{ room: string; length: number }>;
  rescueWindows?: Array<{ name: string; input: FireRescueWindow }>;
  water: { litresPerMinute: number; cubicMetresPerHour: number } | null;
};
const metres = (value: number) => value.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todo = (text: string) => `[${text} – ergänzen]`;

/**
 * The written part as plain German text for the specialist to edit, in the
 * chapter structure of the office's Brandschutzkonzept (Bendenweg, 2026) until
 * the Brandschutzatlas outline is available. Each requirement is quoted with
 * its source, then how this building meets it from the model; what the model
 * cannot know is left as a bracketed placeholder. Nothing it states is
 * reviewed; unmet components are collected under Abweichungen for the
 * specialist to compensate. Summaries that are not verbatim are marked.
 */
export function fireConceptDraft(input: FireConceptInput): string {
  const { classification: c } = input;
  const state = c.state ?? "RP";
  const law = fireCodeLaw[state];
  const gk = c.buildingClass;
  const garage = c.garage === "medium" || c.garage === "large";
  const lines: string[] = [];
  const text = (...items: string[]) => lines.push(...items);
  const quote = (id: FireRequirementId) => { const r = fireRequirement(id, state); if (!r) return; text(`Anforderung (${r.cite}${r.wording === "summary" ? ", sinngemäß – Wortlaut prüfen" : ""}):`, `„${r.text}“`); };
  const heading = (number: string, title: string) => { if (lines.at(-1) !== "") text(""); text(`${number} ${title}`, ""); };
  const valueText = (value: FireRating | FireClosure) => value in fireRatingText ? fireRatingText[value as FireRating] : fireClosureText[value as FireClosure];
  const deviations = new Set<string>();
  const byRequirement = new Map<FireRequirementId, Array<{ name: string; status: string; value: FireRating | FireClosure }>>();
  for (const component of input.components) for (const reason of component.reasons) {
    byRequirement.set(reason.requirement, [...(byRequirement.get(reason.requirement) ?? []), { name: component.name, status: component.status, value: reason.value }]);
    if (component.status === "not_met") deviations.add(component.name);
  }
  /** One line per required value with how many components meet it. */
  const implementation = (id: FireRequirementId) => {
    const items = byRequirement.get(id) ?? [];
    if (!items.length) return text("Umsetzung: in den erfassten Bauteilen nicht betroffen.");
    const values = new Map<string, typeof items>();
    for (const item of items) values.set(item.value, [...(values.get(item.value) ?? []), item]);
    for (const [value, group] of values) {
      const count = (status: string) => group.filter(item => item.status === status).length;
      text(`Umsetzung: ${group.length} Bauteil(e) ${valueText(value as FireRating | FireClosure)} – erfüllt ${count("met")}, nicht erfüllt ${count("not_met")}, offen ${count("open")}.`);
    }
  };
  /** The office's closing sentence of a chapter, once every component it covers is met. */
  const closing = (...ids: FireRequirementId[]) => {
    const items = ids.flatMap(id => byRequirement.get(id) ?? []);
    if (items.length && items.every(item => item.status === "met")) text("Alle Anforderungen werden eingehalten.");
  };
  const ventText = (vent: StairwellSmokeVent | null) => vent === "windows" ? `in jedem oberirdischen Geschoss unmittelbar ins Freie führende ${law.smokeWindows}`
    : vent === "top_opening" ? `an der höchsten Stelle eine Öffnung zur Rauchableitung, bedienbar vom Erdgeschoss und vom obersten Treppenabsatz (${law.smokeTop})${state === "BE" && gk !== null && gk >= 4 ? `; ${todo("besondere Vorkehrungen nach § 35 Abs. 8 Satz 3 BauO Bln")}` : ""}`
    : todo(`Rauchableitung nach ${law.smoke}`);
  const garageName = `${input.garageEnclosure === "open" ? "offene" : input.garageEnclosure === "closed" ? "geschlossene" : "[offene/geschlossene]"} ${c.garage === "large" ? "Großgarage" : "Mittelgarage"}`;

  text(c.deliverable === "konzept" ? "Brandschutzkonzept – Entwurf" : "Brandschutznachweis – Entwurf der Angaben",
    "Aus dem Richtfest-Gebäudemodell erzeugt. Nicht geprüft; Bauteilangaben und Platzhalter in [Klammern] vom Fachplaner zu ergänzen und zu bestätigen.");

  heading("1", "Allgemeine Angaben");
  heading("1.1", "Anlass und Auftrag");
  heading("1.1.1", "Vorbemerkung");
  text(`${todo("Vorhaben, Gebäude und Nutzungen je Geschoss")}${input.dwellings ? ` Wohnungen im Modell: ${input.dwellings}.` : ""}`);
  heading("1.1.2", "Vorgespräch");
  text(todo("Vorabsprache mit dem Prüfsachverständigen (Datum, geklärte Punkte) oder Abschnitt streichen"));
  heading("1.1.3", "Auftragsumfang");
  text("Das Brandschutzkonzept für das geplante Vorhaben dient als Bestandteil der Bauvorlagen zur Erlangung der Baugenehmigung.", todo("Leistungsphase"));
  heading("1.1.4", "Nachweisumfang");
  text("Das Brandschutzkonzept berücksichtigt ausschließlich die baurechtlichen Belange des vorbeugenden Brandschutzes zur Erlangung der Baugenehmigung.");
  heading("1.1.5", "Nachweisgebrauch");
  text(`Zur Verwirklichung allgemeiner Anforderungen müssen in jedem Fall die Schutzziele nach ${law.goals} der ${law.long} eingehalten werden. Maßgebend ist der Textteil des Nachweises, die Brandschutzpläne sind keine Ausführungspläne.`);
  heading("1.2", "Basis und Unterlagen");
  text(todo("Bauzeichnungen (Grundrisse, Schnitte, Ansichten, Freiflächenplan) mit Datum"));

  heading("2", "Baurechtliche Grundlagen");
  heading("2.1", "Baurechtliche Einordnung");
  text(input.height !== null ? `Die Höhe des Fußbodens des höchstgelegenen Geschosses, in dem ein Aufenthaltsraum vorhanden oder möglich ist, über der Geländeoberfläche im Mittel beträgt ca. ${metres(input.height)} m (Werte aus den Schnitten).` : todo("Höhe des Fußbodens des höchstgelegenen Geschosses mit möglichem Aufenthaltsraum"));
  heading("2.1.1", "Genehmigungspläne");
  text(todo("Planausschnitte"));
  heading("2.1.2", "Baukonstruktion");
  text(todo("Bauweise, Fassade (WDVS, Brandriegel)"));
  heading("2.2", "Einstufung in anzuwendende Rechtsvorschriften");
  text(`Die bauliche Anlage wird auf Grundlage der ${fireCodeEditions[state].code} beurteilt. In Verbindung damit ist die Verwaltungsvorschrift Technische Baubestimmungen (${state === "BE" ? "VV TB Bln" : "VV TB"})${garage ? ` und die ${fireCodeEditions[state].garages}` : ""} maßgebende Rechtsgrundlage dieses Brandschutzkonzeptes.`);
  heading("2.3", "Schlussfolgerungen für den Brandschutz");
  quote("buildingClass");
  text(`Umsetzung: Es handelt sich um ein Gebäude der ${gk ? `Gebäudeklasse ${gk}` : "Gebäudeklasse [offen]"}.`);
  text(`Das Gebäude ist nach ${law.specialUse} als ${c.highRise ? `Hochhaus (${state === "BE" ? "§ 2 Abs. 4 Nr. 1" : "§ 50 Abs. 2 Nr. 1"})` : c.specialUse ? specialUseText[state][c.specialUse] : "[Sonderbau offen]"} zu beurteilen.`);
  if (c.garage) { quote("garageClass"); text(`Umsetzung: Die Garage ist${law.garageClass ? ` nach ${law.garageClass}` : ""} als ${c.garage === "small" ? "Kleingarage" : garageName} zu beurteilen.`); }
  if (c.review === "check_engineer") { quote("fireReview"); text("Umsetzung: Der Brandschutznachweis wird von einer Prüfingenieurin oder einem Prüfingenieur für Brandschutz bauaufsichtlich geprüft."); }

  heading("3", "Brandrisikoanalyse");
  heading("3.1", "Schutzziele");
  quote("protectionGoals");
  heading("3.2", "Brandlasten");
  text(todo("Nutzung, besondere Räume, Brandgefahren und Brandlasten"));

  heading("4", "Brandschutzkonzept");
  heading("4.1", "Allgemeine Anforderungen");
  text("Im Nachweis werden die baurechtlichen Begriffe verwendet (nichtbrennbar, schwerentflammbar, normalentflammbar; feuerbeständig, hochfeuerhemmend, feuerhemmend). Zur Übersetzung in die europäischen Klassen wird auf DIN EN 13501-1 und -2 verwiesen.");
  heading("4.1.2", "Brand- und Rauchabschnitte");
  text(todo(`Gebäudeabmessungen gegen 40 m Brandwandabstand (${law.fireWalls}), Abstände zu Grundstücksgrenzen`));
  heading("4.2", "Abwehrender Brandschutz");
  text(todo("4.2.1 Zuständigkeitsbereich, 4.2.2 Feuerwehrpläne, 4.2.3 Zugänge, Zufahrten, Aufstell- und Bewegungsflächen"));
  heading("4.2.4", "Löschwasserversorgung");
  quote("fireWater");
  text(input.water ? `Umsetzung: Die erforderliche Löschwassermenge beträgt ${input.water.cubicMetresPerHour} m³/h (${input.water.litresPerMinute.toLocaleString("de-DE")} l/min) für zwei Stunden Löschzeit. ${todo("Zusicherung des Trägers der Wasserversorgung, Entnahmestellen")}` : `Umsetzung: ${todo("Löschwasserbedarf (Vollgeschosse fehlen im Modell)")}`);
  text("", todo("4.2.5 Löschwasserentnahmestelle, 4.2.6 Löschwasserrückhaltung, 4.2.7 Schlüsseldepot"));

  heading("4.3", "Rettungswege");
  heading("4.3.1", "Erster Rettungsweg");
  quote("escapeRoutes");
  text(`Umsetzung: Der erste Rettungsweg führt über ${byRequirement.has("corridorWalls") ? "den notwendigen Flur und " : ""}den notwendigen Treppenraum unmittelbar ins Freie.`);
  heading("4.3.2", "Rettungsweglängen");
  quote("escapeDistance");
  if (input.routes.length) {
    const longest = input.routes.reduce((a, b) => b.length > a.length ? b : a);
    const over = input.routes.filter(route => route.length > maxEscapeDistance);
    text(`Umsetzung: Von der abgelegensten Stelle jedes Aufenthaltsraums bis zum Zugang des notwendigen Treppenraums gemessen; die weiteste Strecke beträgt ca. ${metres(longest.length)} m (${longest.room}).`,
      over.length ? `Über 35 m: ${over.map(route => `${route.room} ${metres(route.length)} m`).join("; ")}.` : "Alle maximalen Rettungsweglängen werden eingehalten.");
  } else text(`Umsetzung: ${todo("Rettungsweglängen (Plan mit Maßstab und geprüften Türen)")}`);
  if (garage) { quote("garageEscape"); text(`Umsetzung: ${todo(state === "BE" ? "Rettungswege und weiteste Strecke in der Garage (Berlin: keine Garagenverordnung, Anforderungen als Sonderbau abstimmen)" : "weiteste Strecke in der Garage")}`); }
  heading("4.3.3", "Zweiter Rettungsweg");
  quote("rescueWindows");
  text(`Umsetzung: ${todo("je Geschoss: Rettung über tragbare Leitern oder Hubrettungsgerät, anleiterbare Stellen, Fenster mit lichten Maßen und Brüstungshöhen")}`);
  if (input.rescueWindows?.length) {
    text("Teilprüfung der erfassten Fenster – keine Freigabe und kein Nachweis des zweiten Rettungswegs. Anleiterbarkeit, Unabhängigkeit, Dachzugang und Vollständigkeit bleiben ungeprüft.");
    const labels = { met: "Einzelkriterien rechnerisch erfüllt", not_met: "mindestens ein Einzelkriterium nicht erfüllt", open: "Eingaben offen", unsupported: "Landesregel nicht unterstützt", not_designated: "nicht als Rettungsfenster vorgesehen" };
    for (const window of input.rescueWindows) {
      const result = assessRescueWindow(c.state, window.input);
      const dimension = (value: number | null) => value === null ? "offen" : `${metres(value)} m`;
      text(`${window.name}: ${labels[result.status]}; lichte Breite ${dimension(window.input.clearWidth)}, lichte Höhe ${dimension(window.input.clearHeight)}, Brüstung ${dimension(window.input.sillHeight)}; von innen leicht zu öffnen: ${window.input.openableInside === null ? "offen" : window.input.openableInside ? "ja" : "nein"}.`);
      if (result.status === "not_met") deviations.add(window.name);
    }
  }
  if (gk && gk >= 3) {
    heading("4.3.5", `Notwendige Treppenräume – ${law.stairwells}`);
    quote("stairwellRequired");
    quote("stairwellWalls");
    implementation("stairwellWalls");
    quote("stairwellDoors");
    implementation("stairwellDoors");
    if (byRequirement.has("stairwellSmoke")) { quote("stairwellSmoke"); implementation("stairwellSmoke"); }
    closing("stairwellWalls", "stairwellDoors", "stairwellSmoke");
    heading("4.3.6", `Notwendige Flure – ${law.corridors}`);
    quote("corridorsBeforeStairwell");
    quote("corridorSmokeSections");
    quote("corridorWalls");
    implementation("corridorWalls");
    closing("corridorWalls");
  }

  heading("4.4", "Baulicher Brandschutz");
  text("Die Anordnung der Anforderungen an die Feuerwiderstandsfähigkeit kann den Brandschutzplänen entnommen werden.");
  heading("4.4.1", "Tragende Wände, Pfeiler und Stützen");
  quote("loadBearingWalls");
  implementation("loadBearingWalls");
  closing("loadBearingWalls");
  heading("4.4.2", "Außenwände");
  quote("exteriorWalls");
  text(`Umsetzung: ${todo("Baustoffe der Außenwände und Bekleidungen")}`);
  heading("4.4.4", "Trennwände");
  quote("partitionWalls");
  implementation("partitionWalls");
  quote("partitionOpenings");
  implementation("partitionOpenings");
  closing("partitionWalls", "partitionOpenings");
  heading("4.4.6", "Decken");
  quote("ceilings");
  implementation("ceilings");
  closing("ceilings");
  heading("4.4.8", "Türen");
  const doors = new Map<string, { count: number; met: number }>();
  for (const component of input.components) if (component.kind === "door" && component.status !== "none") {
    const value = combineClosures(component.reasons.map(reason => reason.value as FireClosure));
    if (!value) continue;
    const entry = doors.get(value) ?? { count: 0, met: 0 };
    entry.count++; if (component.status === "met") entry.met++;
    doors.set(value, entry);
  }
  text(doors.size ? [...doors].map(([value, entry]) => `${entry.count} Tür(en) mindestens ${fireClosureText[value as FireClosure]}, davon erfüllt ${entry.met}.`).join("\n") : "Keine Türen mit Anforderungen erfasst.");
  heading("4.4.9", "Rauchableitung");
  text(input.stairwells.length ? input.stairwells.map(stairwell => `Notwendiger Treppenraum ${stairwell.name}: ${ventText(stairwell.smokeVent)}.`).join("\n") : todo("Rauchableitung des Treppenraums"));
  if (garage) text(todo(`Lüftung und Rauchableitung der Garage (${state === "BE" ? "BetrVO, Muster-Garagenverordnung" : "GarStellVO"})`));
  text("", todo("4.4.3 Brandriegel, 4.4.5 Brandwände, 4.4.7 Dach (harte Bedachung)"));

  heading("4.5", "Haustechnische Anlagen und Einrichtungen");
  text(todo("Aufzug, Leitungsanlagen (LAR), Lüftungsanlagen (LüAR), elektrische Betriebsräume, Feuerungsanlagen, Müllräume, PV"));
  heading("4.6", "Anlagentechnischer Brandschutz");
  text(todo(`BMA, Rauchwarnmelder (${state === "BE" ? "§ 48 BauO Bln" : "§ 44 Abs. 7 LBauO"}), Alarmierung, Löschanlagen, RWA, Sicherheitsbeleuchtung, Blitzschutz`));
  heading("4.7", "Organisatorischer Brandschutz");
  text(todo("Betriebsvorschriften, Brandschutzordnung, Flucht- und Rettungswegpläne"));
  heading("4.8", "Wiederkehrende Prüfungen");
  text(garage && state === "RP" ? "Die Wirksamkeit und Betriebssicherheit baurechtlich erforderlicher sicherheitstechnischer Anlagen ist nach der AnlPrüfVO zu prüfen; dies gilt insbesondere für die Garage." : todo("Prüfpflichtige Anlagen nach AnlPrüfVO"));

  heading("5", "Zusammenfassung");
  heading("5.1", "Abweichungen und Kompensationsmaßnahmen");
  const open = input.components.some(component => component.status === "open");
  text(deviations.size ? `Nicht erfüllt: ${[...deviations].join(", ")}. ${todo("Kompensationsmaßnahmen")}`
    : open ? "Aus den erfassten Bauteilen sind keine Abweichungen bekannt; offene Bauteilangaben sind vor Abschluss zu ergänzen." : "Es sind keine Abweichungen geplant bzw. werden benötigt.");
  heading("5.2", "Schlussbemerkungen");
  text(todo("Schlussbemerkung des Sachverständigen"));
  heading("6", "Hinweise zur Planung und Ausführung");
  text(todo("Allgemeine Hinweise, Forderungen des Sachversicherers"));
  heading("7", "Anlagen zum Brandschutzkonzept");
  text("7.1 Brandschutzpläne", "7.2 Zusicherung des Trägers der Wasserversorgung", ...(gk && gk >= 4 ? ["7.3 Stellungnahme der Feuerwehr für den Einsatz von Hubrettungsfahrzeugen"] : []));
  return lines.join("\n");
}
