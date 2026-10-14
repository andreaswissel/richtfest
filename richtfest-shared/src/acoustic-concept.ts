import { z } from "zod";

// Length is writing guidance, not grounds for discarding complete acoustic evidence.
// Model token budgets still bound each call; assembled sections retain every piece.
const section = z.string().trim().min(1);
const metadata = z.string().trim().min(1).max(300).nullable();
export const acousticConceptIdSchema = z.enum(["interior-noise-concept", "exterior-noise-concept"]);
export type AcousticConceptId = z.infer<typeof acousticConceptIdSchema>;
export const acousticSourceRangeSchema = z.object({
  versionId: z.string().uuid(),
  pageStart: z.number().int().positive(),
  pageEnd: z.number().int().positive(),
}).strict();
export const acousticAttachmentSchema = acousticSourceRangeSchema.extend({
  label: z.string().trim().min(1).max(300),
  section: z.enum(["planningLaw", "components", "plans", "calculationAppendix"]),
}).strict();
export const acousticSectionKeySchema = z.enum([
  "preliminaryRemarks", "exteriorNoiseAssessment", "planningLaw", "components", "plans",
  "sourcesAndRevisions", "openIssues", "calculationAppendix", "requirements", "verification",
  "buildingServices", "heatPumps", "protectionLevels",
]);
export function acousticSectionKeys(id: AcousticConceptId) {
  return ["preliminaryRemarks", ...(id === "exterior-noise-concept"
    ? ["exteriorNoiseAssessment", "planningLaw", "components", "plans"]
    : ["requirements", "plans", "components", "verification", "planningLaw", "buildingServices", "heatPumps", "protectionLevels"]),
    "sourcesAndRevisions", "openIssues", "calculationAppendix"] as z.infer<typeof acousticSectionKeySchema>[];
}

/** Explicit user selection takes precedence over the model's planning proposal. */
export function requestedAcousticConcept(goal: string): AcousticConceptId | undefined {
  const explicit = [...goal.matchAll(/\b(interior-noise-concept|exterior-noise-concept)\b/gi)];
  if (explicit.length) return explicit.at(-1)![1]!.toLowerCase() as AcousticConceptId;
  const exterior = /(?:außen|aussen|exterior)[-\s]*(?:lärm|laerm|noise)/i.test(goal);
  const interior = /(?:innen|interior)[-\s]*(?:lärm|laerm|noise)/i.test(goal);
  return /konzept|concept|bericht|report/i.test(goal) && exterior !== interior
    ? exterior ? "exterior-noise-concept" : "interior-noise-concept" : undefined;
}
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
  attachments: z.array(acousticAttachmentSchema).max(100).optional(),
};

/** A source/page map, not the report body. Each section is authored separately. */
export const acousticConceptOutlineSchema = z.object({
  id: acousticConceptIdSchema,
  title: z.string().trim().min(1).max(300),
  language: common.language,
  project: common.project,
  sections: z.array(z.object({
    key: acousticSectionKeySchema,
    sources: z.array(acousticSourceRangeSchema).max(100),
  }).strict()).max(13),
  attachments: z.array(acousticAttachmentSchema).max(100),
}).strict();

export const acousticSectionOutputSchema = z.object({
  content: section.describe("Aim for 12000 characters or fewer. This is a soft target: preserve complete evidence, citations and tables rather than truncating to fit."),
  citations: z.array(z.string().uuid()).max(100),
  complete: z.boolean(),
}).strict();

/** The editor owns prose, not metadata, source PDFs or the calculation appendix. */
export const acousticEditorialOutputSchema = z.object({
  sections: z.array(z.object({ key: acousticSectionKeySchema, content: section }).strict()).max(12),
  complete: z.boolean(),
}).strict();

/** Match the provider's JSON schema to the one section a packet may edit. */
export function acousticEditorialPacketOutputSchema(key: z.infer<typeof acousticSectionKeySchema>) {
  return acousticEditorialOutputSchema.extend({
    sections: z.array(acousticEditorialOutputSchema.shape.sections.element.extend({ key: z.literal(key) })).length(1),
  });
}

export const acousticEditorialCheckSchema = z.object({
  preserved: z.boolean().describe("True only if the edit retains all substantive evidence and uncertainty without new claims or calculations."),
  issues: z.array(z.string().trim().min(1).max(2000)).max(100),
}).strict();

/** Bounded edits to identified fragments, never a replacement for the whole report. */
export const acousticConsolidationOutputSchema = z.object({
  complete: z.boolean(),
  replacements: z.array(z.object({
    id: z.string().min(1),
    content: z.string().nullable().describe("Null keeps the exact original; empty removes only duplicate evidence retained in the other supplied fragment."),
  }).strict()).min(1).max(2),
}).strict();

/** Explicit patch-editorial-v1 protocol; legacy consolidation stays at two IDs. */
export const acousticPatchEditorialOutputSchema = acousticConsolidationOutputSchema.extend({
  replacements: acousticConsolidationOutputSchema.shape.replacements.max(32),
});

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
      "Quellenbasierter Konzeptentwurf, kein normativer Schallschutznachweis. Ausdrücklich ausgewiesene Werkzeugberechnungen bleiben fachlich ungeprüft. Werte aus vorhandenen Nachweisen sind zitierte Quellenangaben, keine durch Richtfest validierten Ergebnisse. Aufgeführte Quellseiten werden im PDF unverändert als ungeprüfte Belege beigefügt; nicht aufgeführte Pläne oder Anlagen sind nicht enthalten. Unterschriften auf Quellseiten sind keine Freigabe dieses Entwurfs.",
      "Source-based concept draft, not a standards-based engineering verification. Explicitly identified tool calculations remain subject to specialist review. Values from existing reports are cited source claims, not results validated by Richtfest. Listed source pages are included in the PDF as unchanged, unverified evidence; unlisted plans or appendices are not attached. Signatures on source pages do not approve this draft.",
    ),
    `| ${choose("Projektangabe", "Project information")} | ${choose("Stand", "Value")} |\n| --- | --- |\n${fields.map(([label, value]) => `| ${label} | ${cell(value)} |`).join("\n")}`,
    `## ${choose("Inhaltsverzeichnis", "Contents")}\n\n${sections.map(([heading]) => `- ${heading}`).join("\n")}`,
    ...sections.map(([heading, text]) => {
      const key = /Bebauungsplan|Development plan/.test(heading) ? "planningLaw"
        : /Bauteilaufbauten|Component specifications/.test(heading) ? "components"
        : /Schallschutzpläne|noise plans/.test(heading) ? "plans"
        : /Berechnungsnachweise|Calculation evidence/.test(heading) ? "calculationAppendix" : undefined;
      const attachments = (template.attachments ?? []).filter(a => a.section === key);
      const register = attachments.map(a => `- ${cell(a.label)} · [${a.versionId}] · ${choose("PDF-Seiten", "PDF pages")} ${a.pageStart}–${a.pageEnd}`).join("\n");
      return `${heading.startsWith("5.1.") ? "###" : "##"} ${heading}\n\n${body(text)}${register ? `\n\n**${choose("Beigefügte Quellseiten (ungeprüft)", "Attached source pages (unverified)")}**\n\n${register}` : ""}`;
    }),
  ].join("\n\n");
}
