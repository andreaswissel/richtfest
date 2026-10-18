import type { DocumentTypeProposal, DocumentType } from "@richtfest/shared";

const rules: Array<{ kind: NonNullable<DocumentTypeProposal["kind"]>; type: DocumentType; pattern: RegExp }> = [
  { kind: "preliminary_permit", type: "permit", pattern: /^(?:Bauvorbescheid|Vorbescheid)\b/i },
  { kind: "permit", type: "permit", pattern: /^Baugenehmigung\b/i },
  { kind: "development_plan", type: "development_plan", pattern: /^(?:(?:vorhabenbezogener|Entwurf zum)\s+)?Bebauungsplan\b/i },
  { kind: "building_encumbrance", type: "other", pattern: /^(?:Auszug aus dem Baulastenverzeichnis|Baulastenverzeichnis|Baulast(?:enerklärung|enbescheinigung)?)\b/i },
  { kind: "right_of_way", type: "other", pattern: /^(?:Wegerecht|Geh- und Fahrrecht|Grunddienstbarkeit)\b/i },
  { kind: "cadastral", type: "plans", pattern: /^(?:Auszug aus dem Liegenschaftskataster|Liegenschaftskarte|Flurkarte|Katasterauszug)\b/i },
];

/** Workflow only scopes the candidates; headings in saved content supply the evidence.
 * Mentions in prose cannot turn a letter about a plan into the plan itself. */
export function proposeDocumentType(versionId: string, metadata: unknown,
  pages: Array<{ page: number; content: { text?: string } }>): DocumentTypeProposal | undefined {
  if (!metadata || typeof metadata !== "object" || (metadata as Record<string, unknown>).workflow !== "site_assessment") return undefined;
  const hits = new Map<string, { rule: typeof rules[number]; evidence: { page: number; quote: string } }>();
  for (const page of pages) {
    for (const line of (page.content.text ?? "").split(/\r?\n/).slice(0, 40)) {
      const quote = line.trim();
      if (!quote || quote.length > 220) continue;
      // A heading may carry an identifier/date, but statements about missing,
      // requested or future documents are references, not document identity.
      if (/\b(?:nicht|kein(?:e|en|er|es)?|liegt|liegen|wird|werden|wurde|wurden|ist|sind|war|waren|soll|sollen|muss|müssen|beantragt|nachgereicht|angefordert|erforderlich|fehlt|fehlen)\b/i.test(quote)) continue;
      for (const rule of rules) if (rule.pattern.test(quote) && !hits.has(rule.kind)) hits.set(rule.kind, { rule, evidence: { page: page.page, quote } });
    }
  }
  const matches = [...hits.values()];
  const single = matches.length === 1 ? matches[0] : undefined;
  return { versionId, documentType: single?.rule.type ?? null, kind: single?.rule.kind ?? null,
    status: single ? "proposed" : matches.length ? "ambiguous" : "unknown", reviewStatus: "unreviewed",
    evidence: matches.map(match => match.evidence) };
}
