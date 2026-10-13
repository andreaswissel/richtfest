import { createRequire } from "node:module";
import { acousticAttachmentSchema, formatSourceCitations, sourceReferenceLabel, type SourceReference } from "@richtfest/shared";
import type { Token, Tokens } from "marked";

export type ArtifactPdfInput = {
  title: string;
  content: string;
  version: number;
  projectId: string;
  sources: SourceReference[];
  sourceVersionIds: string[];
  status: string;
  template?: unknown;
  readSourcePdf?: (projectId: string, versionId: string) => Promise<Buffer | null>;
  /** Internal report fragment rendering; no generic wrapper. */
  bodyOnly?: boolean;
};

const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const safeText = (text: string) => text.replace(uuid, "Source unavailable");

/** Server-only renderer. Markdown is parsed, never executed or fetched. */
export async function artifactPdf(input: ArtifactPdfInput): Promise<Buffer> {
  const template = input.template as { id?: string; version?: number } | undefined;
  if (!input.bodyOnly && template?.version === 1 &&
    ["interior-noise-concept", "exterior-noise-concept"].includes(template.id ?? ""))
    return conceptPdf(input);
  // Keep the parser, font assets and renderer off the API boot path.
  const [{ default: PDFDocument }, { marked }] = await Promise.all([
    import("pdfkit"), import("marked"),
  ]);
  const require = createRequire(import.meta.url);
  const doc = new PDFDocument({ size: "A4", margins: { top: 88, bottom: 48, left: 48, right: 48 }, bufferPages: true,
    info: { Title: safeText(input.title), Author: "Richtfest" } });
  const result = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", chunk => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.registerFont("body", require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf"));
  doc.registerFont("bold", require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf"));
  doc.registerFont("italic", require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Oblique.ttf"));
  const width = doc.page.width - 96;
  const gap = () => { doc.x = 48; doc.moveDown(0.6); };
  type Run = { text: string; bold?: boolean; italic?: boolean };
  function inline(tokens: Token[], style: Omit<Run, "text"> = {}): Run[] {
    return tokens.flatMap(token => {
      if (token.type === "html" || token.type === "image") return [];
      if (token.type === "br") return [{ text: "\n", ...style }];
      if (token.type === "strong") return inline(token.tokens ?? [], { ...style, bold: true });
      if (token.type === "em") return inline(token.tokens ?? [], { ...style, italic: true });
      if ("tokens" in token && token.tokens) return inline(token.tokens as Token[], style);
      return "text" in token ? [{ text: safeText(String(token.text)), ...style }] : [];
    });
  }
  function paragraph(runs: Run[], size = 10, indent = 0) {
    const nonempty = runs.filter(run => run.text.length);
    nonempty.forEach((run, index) => {
      doc.font(run.bold ? "bold" : run.italic ? "italic" : "body").fontSize(size)
        .fillColor("#222222").text(run.text, { width: width - indent,
          continued: index < nonempty.length - 1, lineGap: 3 });
    });
    gap();
  }
  function blocks(tokens: Token[], indent = 0) {
    for (const token of tokens) {
      doc.x = 48 + indent;
      switch (token.type) {
        case "heading":
          if (doc.y > doc.page.height - 120) doc.addPage();
          paragraph(inline(token.tokens ?? [], { bold: true }), Math.max(11, 20 - token.depth * 2), indent);
          break;
        case "paragraph": case "text":
          paragraph(token.tokens ? inline(token.tokens) : [{ text: safeText(token.text) }], 10, indent);
          break;
        case "list":
          (token as Tokens.List).items.forEach((item, index) => {
            const prefix = token.ordered ? `${Number(token.start) + index}. ` : "• ";
            const children = [...item.tokens];
            const first = children.shift();
            doc.x = 48 + indent + 12;
            if (first && "text" in first) paragraph([{ text: prefix }, ...inline(
              "tokens" in first && first.tokens ? first.tokens as Token[] : marked.lexer(first.text),
            )], 10, indent + 12);
            if (first && !("text" in first)) blocks([first], indent + 12);
            blocks(children, indent + 12);
          });
          break;
        case "blockquote": blocks(token.tokens ?? [], indent + 12); break;
        case "table": {
          const table = token as Tokens.Table;
          const cellText = (tokens: Token[]) => inline(tokens).map(run => run.text).join("");
          doc.font("body").fontSize(9);
          doc.table({ position: { x: 48 + indent }, maxWidth: width - indent,
            columnStyles: table.header.map(() => (width - indent) / table.header.length),
            defaultStyle: { padding: 6, border: 0.5, borderColor: "#cccccc" },
            data: [table.header.map(cell => ({ text: cellText(cell.tokens),
              font: { src: "bold", size: 9 }, backgroundColor: "#eeeeee", type: "TH" as const })),
              ...table.rows.map(row => row.map(cell => cellText(cell.tokens)))],
          });
          gap();
          break;
        }
        // Raw HTML, images, fenced code and executable content are not rendered.
        default: break;
      }
    }
  }
  if (!input.bodyOnly) {
    paragraph([{ text: safeText(input.title), bold: true }], 21);
    paragraph([{ text: `Revision ${input.version} · Status: ${safeText(input.status)} · Richtfest` }], 9);
  }
  const content = formatSourceCitations(input.content, input.projectId, input.sources);
  blocks(marked.lexer(content, { gfm: true }));
  if (!input.bodyOnly) blocks(marked.lexer("## Source register"));
  const byId = new Map(input.sources.map(source => [source.versionId.toLowerCase(), source]));
  const ids = new Set([...input.sourceVersionIds.map(id => id.toLowerCase()),
    ...(input.content.match(uuid) ?? []).map(id => id.toLowerCase())]);
  const labels = [...new Set([...ids].map(id => {
    const source = byId.get(id);
    return source ? safeText(sourceReferenceLabel(source)) : "Source unavailable";
  }))];
  if (!input.bodyOnly) paragraph([{ text: labels.length ? labels.join("\n") : "No sources referenced." }], 9);
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    // Match the app's boxed R / lowercase wordmark; draw locally, never fetch a logo.
    // Reserved top margin keeps the header clear of flowing text and tables.
    doc.roundedRect(48, 28, 26, 26, 7).fill("#171717");
    doc.font("bold").fontSize(13).fillColor("#ffffff")
      .text("R", 48, 32, { width: 26, align: "center", lineBreak: false });
    doc.font("bold").fontSize(17).fillColor("#171717")
      .text("richtfest", 83, 29, { lineBreak: false });
    const wordmarkWidth = doc.widthOfString("richtfest");
    doc.fillColor("#4338ca").text(".", 83 + wordmarkWidth, 29, { lineBreak: false });
    doc.font("body").fontSize(8).fillColor("#666666")
      .text(safeText(input.title).replace(/\s+/g, " "), 250, 31,
        { width: doc.page.width - 298, height: 24, align: "right", ellipsis: true });
    doc.moveTo(48, 68).lineTo(doc.page.width - 48, 68).lineWidth(0.5).strokeColor("#d4d4d4").stroke();
    if (input.bodyOnly) continue; // Composed concepts receive final revision/page footers below.
    // Footer is inside the bottom margin; disable automatic page creation there.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("body").fontSize(8).fillColor("#666666")
      .text(`${safeText(input.status)} · Revision ${input.version} · ${i + 1} / ${pages.count}`,
        48, doc.page.height - 32, { width, align: "right", lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return result;
}

const exportError = () => Object.assign(new Error(
  "Cannot export source attachments. Check that every attachment cites a ready PDF version in this project and uses an available page range, then save a new revision or restore the source.",
), { status: 422, code: "invalid_pdf_attachment" });

/** Compose immutable Markdown sections and original PDF pages, never regenerated evidence. */
async function conceptPdf(input: ArtifactPdfInput): Promise<Buffer> {
  const { PDFDocument, rgb } = await import("pdf-lib");
  const { z } = await import("zod");
  const attachmentSchema = z.array(acousticAttachmentSchema.refine(a => a.pageEnd >= a.pageStart)).max(100);
  const template = input.template as { attachments?: unknown; language?: string };
  const de = template.language === "de";
  const draftLabel = de ? "Entwurf" : "Draft";
  const parsed = attachmentSchema.safeParse(template.attachments === undefined ? [] : template.attachments);
  if (!parsed.success) throw exportError();
  const sources = new Map(input.sources.map(s => [s.versionId.toLowerCase(), s]));
  const cited = new Set(input.sourceVersionIds.map(id => id.toLowerCase()));
  const pdfs = new Map<string, Awaited<ReturnType<typeof PDFDocument.load>>>();
  const attachments = [];
  for (const attachment of parsed.data) {
    const source = sources.get(attachment.versionId.toLowerCase());
    if (!source || !cited.has(attachment.versionId.toLowerCase()) || !input.readSourcePdf) throw exportError();
    try {
      let pdf = pdfs.get(attachment.versionId);
      if (!pdf) {
        const bytes = await input.readSourcePdf(input.projectId, attachment.versionId);
        if (!bytes) throw exportError();
        pdf = await PDFDocument.load(bytes);
        pdfs.set(attachment.versionId, pdf);
      }
      if (attachment.pageEnd > pdf.getPageCount()) throw exportError();
      attachments.push({ ...attachment, source, pdf });
    } catch { throw exportError(); }
  }
  const fragment = async (content: string) => PDFDocument.load(await artifactPdf({
    ...input, template: undefined, bodyOnly: true, content,
  }));
  const chunks = input.content.split(/^(?=#{2,3} )/m);
  const cover = chunks.shift() ?? "";
  const sections = chunks.filter(chunk => !/^## (Contents|Inhaltsverzeichnis)\s*\n/.test(chunk));
  const rendered: { title: string; pdf: Awaited<ReturnType<typeof fragment>>; attachments: typeof attachments }[] = [];
  let sequence = 0;
  for (const section of sections) {
    const heading = section.split("\n")[0].replace(/^#+\s*/, "");
    const number = heading.match(/^(\d+)\./);
    if (number) sequence = Math.max(sequence, Number(number[1]));
    const title = number ? heading : `${++sequence}. ${heading}`;
    const key = /Bebauungsplan|Development plan/.test(heading) ? "planningLaw"
      : /Bauteilaufbauten|Component specifications/.test(heading) ? "components"
      : /Schallschutzpläne|noise plans/.test(heading) ? "plans"
      : /Berechnungsnachweise|Calculation evidence/.test(heading) ? "calculationAppendix" : null;
    const pdf = await fragment(section.replace(/^#+[^\n]*/, `## ${title}`));
    rendered.push({ title, pdf, attachments: attachments.filter(a => a.section === key) });
  }
  if (attachments.some(a => !rendered.some(s => s.attachments.includes(a)))) throw exportError();
  const output = await PDFDocument.create();
  output.setTitle(safeText(input.title));
  output.setAuthor("Richtfest");
  const append = async (pdf: Awaited<ReturnType<typeof fragment>>) => {
    for (const page of await output.copyPages(pdf, pdf.getPageIndices())) output.addPage(page);
  };
  await append(await fragment(cover + `\n\n${draftLabel} · Revision ${input.version} · ${input.status}\n\n` + (de
    ? "Beigefügte Quellseiten sind ungeprüfte Belege, keine neue Freigabe oder Unterschrift. Nur aufgeführte Seitenbereiche sind enthalten; die Vollständigkeit der Anlagen ist nicht zertifiziert."
    : "Imported source pages are unverified evidence, not new approval or signatures. Only listed page ranges are attached; annex completeness is not certified.")));
  // Contents length can spill; calculate again until its page count stabilizes.
  let contentsCount = 1;
  let contents;
  for (let attempt = 0; attempt < 5; attempt++) {
    let start = output.getPageCount() + contentsCount + 1;
    const rows = rendered.map(s => {
      const row = `| ${s.title} | ${start} |`;
      start += s.pdf.getPageCount() + s.attachments.reduce((n, a) => n + a.pageEnd - a.pageStart + 1, 0);
      return row;
    });
    contents = await fragment(`## ${de ? "Inhaltsverzeichnis" : "Contents"}\n\n| ${de ? "Abschnitt" : "Section"} | ${de ? "Seite" : "Page"} |\n| --- | --- |\n${rows.join("\n")}`);
    if (contents.getPageCount() === contentsCount) break;
    contentsCount = contents.getPageCount();
  }
  await append(contents!);
  const imported = new Map<number, { label: string; band: number }>();
  for (const section of rendered) {
    await append(section.pdf);
    for (const a of section.attachments) {
      const pages = await output.copyPages(a.pdf, Array.from({ length: a.pageEnd - a.pageStart + 1 }, (_, i) => a.pageStart - 1 + i));
      pages.forEach((page, i) => {
        const label = `${a.source.fileName} · v${a.source.version} · ${de ? "Seite" : "page"} ${a.pageStart + i} · ${a.label}`.replace(/\s+/g, " ");
        if (page.getWidth() <= 96) throw exportError();
        const band = Math.max(64, 44 + Math.ceil((label.length + 29) * 8 / (page.getWidth() - 96)) * 10);
        imported.set(output.getPageCount(), { label, band });
        // New space above the original artwork; do not move annotations or flatten pages.
        page.setSize(page.getWidth(), page.getHeight() + band);
        output.addPage(page);
      });
    }
  }
  const { default: fontkit } = await import("@pdf-lib/fontkit");
  const { readFile } = await import("node:fs/promises");
  output.registerFontkit(fontkit);
  const font = await output.embedFont(await readFile(createRequire(import.meta.url).resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf")), { subset: true });
  output.getPages().forEach((page, i) => {
    const source = imported.get(i);
    // Only generated fragments carry the wordmark. Original evidence keeps its
    // own artwork and a separate provenance band, never Richtfest authorship.
    if (source) page.drawText(`${de ? "IMPORTIERTE UNGEPRÜFTE QUELLE" : "IMPORTED UNVERIFIED SOURCE"} - ${source.label}`, {
      x: 48, y: page.getHeight() - 24, size: 8, font, color: rgb(0.25, 0.25, 0.25),
      maxWidth: page.getWidth() - 96, lineHeight: 10,
    });
    page.drawText(`${draftLabel} - Revision ${input.version} - ${safeText(input.status)} - ${i + 1} / ${output.getPageCount()}`, {
      x: 48, y: source ? page.getHeight() - source.band + 20 : 24, size: 8, font,
    });
  });
  return Buffer.from(await output.save());
}
