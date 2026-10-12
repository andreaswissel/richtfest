import { z } from "zod";

const section = z.string().trim().min(1).max(6000);
const metadata = z.string().trim().min(1).max(300).nullable();
const common = {
  version: z.literal(1),
  language: z.enum(["de", "en"]),
  project: z.object({
    name: metadata,
    number: metadata,
    client: metadata,
    designer: metadata,
    author: metadata,
    date: metadata,
  }).strict(),
  preliminaryRemarks: section,
  plans: section,
  components: section,
  planningLaw: section,
  sourcesAndRevisions: section,
  openIssues: section,
  calculationAppendix: section,
};

/** Reference-derived authoring formats, not executable calculation templates. */
export const acousticConceptTemplateSchema = z.discriminatedUnion("id", [
  z.object({
    ...common,
    id: z.literal("interior-noise-concept"),
    requirements: section,
    verification: section,
    buildingServices: section,
    heatPumps: section,
    protectionLevels: section,
  }).strict(),
  z.object({
    ...common,
    id: z.literal("exterior-noise-concept"),
    exteriorNoiseAssessment: section,
  }).strict(),
]);

/** Preview and export use this saved Markdown; layout does not depend on the model. */
export function renderAcousticConcept(template: z.infer<typeof acousticConceptTemplateSchema>) {
  const de = template.language === "de";
  const interior = template.id === "interior-noise-concept";
  const choose = (german: string, english: string) => de ? german : english;
  const sections: [string, string][] = [
    [choose("1. Vorbemerkungen", "1. Preliminary remarks"), template.preliminaryRemarks],
    ...(template.id === "interior-noise-concept" ? [
      [choose("2. Anforderungen und Schallschutznormen", "2. Requirements and acoustic standards"), template.requirements],
      [choose("3. Schallschutzpläne Innenlärm", "3. Interior-noise plans"), template.plans],
      [choose("4. Bauteilaufbauten", "4. Component specifications"), template.components],
      [choose("5. Schallschutznachweis und baurechtliche Belange", "5. Acoustic verification and planning requirements"), template.verification],
      [choose("5.1. Bebauungsplan", "5.1. Development plan"), template.planningLaw],
      [choose("6. Haustechnik, Treppen und Sanitäranlagen", "6. Building services, stairs and sanitary installations"), template.buildingServices],
      [choose("7. Luft-Wasser-Wärmepumpe", "7. Air-to-water heat pump"), template.heatPumps],
      [choose("8. Vereinbartes Schutzniveau und DEGA-Empfehlung 103", "8. Agreed protection level and DEGA recommendation 103"), template.protectionLevels],
    ] as [string, string][] : [
      [choose("2. Bewertung des Außenlärms", "2. Exterior-noise assessment"), template.exteriorNoiseAssessment],
      [choose("3. Bebauungsplan", "3. Development plan"), template.planningLaw],
      [choose("4. Bauteilaufbauten", "4. Component specifications"), template.components],
      [choose("5. Schallschutzpläne Außenlärm", "5. Exterior-noise plans"), template.plans],
    ] as [string, string][]),
    [choose("Quellen und Planungsstände", "Sources and revisions"), template.sourcesAndRevisions],
    [choose("Offene Punkte und nächste Schritte", "Open issues and next steps"), template.openIssues],
    [choose("Prüfstatus und Kenntnisnahme", "Review status and acknowledgment"), choose(
      "Entwurf zur fachlichen Prüfung. Keine Freigabe, Unterschrift oder Bestätigung der Normkonformität. Fachplanung, Entwurfsverfasser und Bauherr müssen den Entwurf und das vereinbarte Schutzniveau prüfen; eine Kenntnisnahme wurde nicht erfasst.",
      "Draft for specialist review. Not approved, signed or certified compliant. The specialist, designer and client must review the draft and agreed protection level; no acknowledgment has been recorded.",
    )],
    [choose("Anlage · Berechnungsnachweise", "Appendix · Calculation evidence"), template.calculationAppendix],
  ];
  const title = choose(
    `Schallschutzkonzept · ${interior ? "Innenlärm" : "Außenlärm"}`,
    `Acoustic concept · ${interior ? "Interior noise" : "Exterior noise"}`,
  );
  const fields = [
    [choose("Objekt", "Project"), template.project.name],
    [choose("Projektnummer", "Project number"), template.project.number],
    [choose("Bauherr", "Client"), template.project.client],
    [choose("Entwurfsverfasser", "Designer"), template.project.designer],
    [choose("Fachplaner", "Specialist author"), template.project.author],
    [choose("Bearbeitungsdatum", "Issue date"), template.project.date],
  ];
  const cell = (value: string | null) => (value ?? choose("Nicht angegeben", "Not supplied"))
    .replace(/[\\`*_{}<>#!|\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
  // Preserve tables/lists, but reserve section headings for the versioned template.
  const body = (value: string) => value.replace(/^ {0,3}#{1,6}\s+(.+)$/gm, "**$1**")
    .replace(/^(.+)\n {0,3}(?:=+|-+)\s*$/gm, "$1");
  return [
    `# ${title}`,
    choose("Vorlage 1 · Entwurf", "Template 1 · Draft"),
    choose(
      "Quellenbasierter Konzeptentwurf, kein rechnerischer Schallschutznachweis. Es wurde keine Berechnung durchgeführt. Werte aus vorhandenen Nachweisen sind zitierte Quellenangaben, keine durch Richtfest validierten Ergebnisse. Pläne und Berechnungsanlagen werden nur referenziert, nicht erzeugt oder als vollständig beigefügt bestätigt.",
      "Source-based concept draft, not an engineering verification. No calculation was performed. Values from existing reports are cited source claims, not results validated by Richtfest. Plans and calculation appendices are referenced only, not generated or confirmed as completely attached.",
    ),
    `| ${choose("Projektangabe", "Project information")} | ${choose("Stand", "Value")} |\n| --- | --- |\n${fields.map(([label, value]) => `| ${label} | ${cell(value)} |`).join("\n")}`,
    `## ${choose("Inhaltsverzeichnis", "Contents")}\n\n${sections.map(([heading]) => `- ${heading}`).join("\n")}`,
    ...sections.map(([heading, text]) => `${heading.startsWith("5.1.") ? "###" : "##"} ${heading}\n\n${body(text)}`),
  ].join("\n\n");
}
