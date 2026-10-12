import { z } from "zod";
import { sourceEntityInput } from "./source-model";
import { acousticConceptTemplateSchema, renderAcousticConcept, type AcousticConceptId } from "./acoustic-concept";

/** Proposed source links, not imported BIM objects or approved calculation inputs. */
export const soundInsulationTemplateSchema = z.object({
  id: z.literal("sound-insulation-review"),
  version: z.literal(1),
  language: z.enum(["de", "en"]),
  scope: z.string().trim().min(1).max(4000),
  sourcesAndRevisions: z.string().trim().min(1).max(4000),
  requirements: z.string().trim().min(1).max(6000),
  entities: z.array(z.object({
    kind: z.enum(["room", "component"]),
    label: z.string().trim().min(1).max(200),
    versionId: z.string().uuid(),
    entityKey: sourceEntityInput.shape.key.max(100).nullable(),
    page: z.number().int().positive().nullable(),
    // Preserve the importer's declaration, including case; this is not IFC validation.
    globalId: sourceEntityInput.shape.globalId.unwrap().max(255).nullable(),
    observations: z.string().trim().min(1).max(1000),
  }).strict()).max(100),
  findings: z.string().trim().min(1).max(6000),
  measures: z.string().trim().min(1).max(6000),
  openIssues: z.string().trim().min(1).max(6000),
}).strict();

export const acousticDocumentTemplateSchema = z.union([soundInsulationTemplateSchema, acousticConceptTemplateSchema]);

/** A proposed deliverable, distinct from the short conversational handoff. */
export const agentDocumentSchema = z.object({
  title: z.string().trim().min(1).max(300),
  // Assembled documents are not model responses; preserve their complete sections.
  content: z.string().trim().min(1),
  template: acousticDocumentTemplateSchema.optional(),
}).strict();

/** Both preview and PDF consume this saved Markdown, never model-chosen headings. */
export function prepareAgentDocument(document: z.infer<typeof agentDocumentSchema> | null | undefined, requireSoundInsulation: boolean | AcousticConceptId = false, maxCharacters: number | null = 60000) {
  if (!document?.template) {
    if (requireSoundInsulation) throw new Error("Sound insulation review requires its versioned document template");
    return document;
  }
  const template = acousticDocumentTemplateSchema.parse(document.template);
  if (typeof requireSoundInsulation === "string" && template.id !== requireSoundInsulation)
    throw new z.ZodError([{ code: "custom", path: ["document", "template", "id"], message: "The requested template is required." }]);
  for (const [key, value] of Object.entries(template)) {
    if (typeof value === "string" && /^(?:nicht verwendet|siehe (?:konzeptdatensatz|nachfolgenden)|not used|see (?:concept dataset|below))(?:[.;\s]|$)/i.test(value))
      throw new z.ZodError([{ code: "custom", path: ["document", "template", key], message: "Author this section; a placeholder is not a report." }]);
  }
  // null is reserved for application-assembled, validated section pieces.
  const schema = maxCharacters === null ? agentDocumentSchema
    : agentDocumentSchema.extend({ content: z.string().trim().min(1).max(maxCharacters) });
  if (template.id !== "sound-insulation-review") {
    return schema.parse({ ...document, content: renderAcousticConcept(template), template });
  }
  const de = template.language === "de";
  // Sections are plain text with source citations, not arbitrary Markdown structure.
  const prose = (value: string) => value.replace(/[\\`*_{}<>#!|]/g, "\\$&");
  const line = (value: string) => prose(value).replace(/[\r\n]+/g, " ");
  const section = (title: string, body: string) => `## ${title}\n\n${body}`;
  const content = [
    de ? "Schallschutzprüfung · Vorlage 1 · Entwurf" : "Sound insulation review · Template 1 · Draft",
    de
      ? "Dokumentenprüfung, kein rechnerischer Schallschutznachweis. Es wurde keine Berechnung durchgeführt. Raum- und Bauteilzuordnungen sind ungeprüfte Vorschläge; IFC-Geometrie, Eigenschaften und Vollständigkeit sind nicht verifiziert."
      : "Document review, not an engineering verification. No calculation was performed. Room and component links are unreviewed proposals; IFC geometry, properties and completeness are not verified.",
    section(de ? "1. Auftrag und Umfang" : "1. Scope", prose(template.scope)),
    section(de ? "2. Quellen und Planungsstände" : "2. Sources and revisions", prose(template.sourcesAndRevisions)),
    section(de ? "3. Anforderungen und Annahmen" : "3. Requirements and assumptions", prose(template.requirements)),
    section(de ? "4. Raum- und Bauteilbezüge" : "4. Room and component references", template.entities.length
      ? template.entities.map(entity => [
        `- **${de ? entity.kind === "room" ? "Raum" : "Bauteil" : entity.kind}: ${line(entity.label)}**`,
        `  - ${de ? "Quelle" : "Source"}: [${entity.versionId}]${entity.page === null ? "" : ` · ${de ? "Seite" : "Page"} ${entity.page}`}`,
        `  - ${de ? "Modellbezug" : "Model reference"}: ${line([entity.entityKey, entity.globalId].filter(Boolean).join(" · ") || "—")}`,
        `  - ${de ? "Beobachtung (ungeprüft)" : "Observation (unreviewed)"}: ${line(entity.observations)}`,
      ].join("\n")).join("\n\n")
      : de ? "Keine belegten Zuordnungen vorhanden. Quellenabdeckung und Zuordnungen sind fachlich zu prüfen." : "No evidenced references available. Source coverage and references require specialist review."),
    section(de ? "5. Befunde und Widersprüche" : "5. Findings and conflicts", prose(template.findings)),
    section(de ? "6. Maßnahmen und Varianten" : "6. Measures and alternatives", prose(template.measures)),
    section(de ? "7. Offene Punkte und nächste Schritte" : "7. Open issues and next steps", prose(template.openIssues)),
    section(de ? "8. Prüfstatus" : "8. Review status", de ? "Entwurf zur fachlichen Prüfung. Keine Freigabe und kein Nachweis der Normkonformität." : "Draft for specialist review. Not approved and not a statement of compliance."),
  ].join("\n\n");
  return schema.parse({ ...document, content, template });
}

export type SourceReference = { versionId: string; fileName: string; version: number };

export function sourceReferenceLabel(source: SourceReference) {
  return `${source.fileName} · v${source.version}`;
}

/** Resolve bracketed immutable-version citations, never model-authored names or URLs. */
export function formatSourceCitations(
  text: string,
  projectId: string,
  sources: SourceReference[],
  unavailable = "Source unavailable",
) {
  const byId = new Map(sources.map(source => [source.versionId.toLowerCase(), source]));
  const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  const escape = (value: string) => value.replace(/[\\`*_[\]<>|]/g, "\\$&").replace(/[\r\n]/g, " ");
  return text.replace(/\[([^\]\n]+)\](?!\()/g, (original, citation: string) => {
    if (!citation.match(uuid)) return original;
    return citation.replace(uuid, id => {
      const source = byId.get(id.toLowerCase());
      return source
        ? `[${escape(sourceReferenceLabel(source))}](/projects/${encodeURIComponent(projectId)}?panel=documents&sourceVersion=${encodeURIComponent(source.versionId)})`
        : escape(unavailable);
    });
  });
}
