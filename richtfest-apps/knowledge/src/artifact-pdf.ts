import { createRequire } from "node:module";
import { formatSourceCitations, sourceReferenceLabel, type SourceReference } from "@richtfest/shared";
import type { Token, Tokens } from "marked";

export type ArtifactPdfInput = {
  title: string;
  content: string;
  version: number;
  projectId: string;
  sources: SourceReference[];
  sourceVersionIds: string[];
  status: string;
};

const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const safeText = (text: string) => text.replace(uuid, "Source unavailable");

/** Server-only renderer. Markdown is parsed, never executed or fetched. */
export async function artifactPdf(input: ArtifactPdfInput): Promise<Buffer> {
  // Keep the parser, font assets and renderer off the API boot path.
  const [{ default: PDFDocument }, { marked }] = await Promise.all([
    import("pdfkit"), import("marked"),
  ]);
  const require = createRequire(import.meta.url);
  const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true,
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
  paragraph([{ text: safeText(input.title), bold: true }], 21);
  paragraph([{ text: `Revision ${input.version} · Status: ${safeText(input.status)} · Richtfest` }], 9);
  const content = formatSourceCitations(input.content, input.projectId, input.sources);
  blocks(marked.lexer(content, { gfm: true }));
  blocks(marked.lexer("## Source register"));
  const byId = new Map(input.sources.map(source => [source.versionId.toLowerCase(), source]));
  const ids = new Set([...input.sourceVersionIds.map(id => id.toLowerCase()),
    ...(input.content.match(uuid) ?? []).map(id => id.toLowerCase())]);
  const labels = [...new Set([...ids].map(id => {
    const source = byId.get(id);
    return source ? safeText(sourceReferenceLabel(source)) : "Source unavailable";
  }))];
  paragraph([{ text: labels.length ? labels.join("\n") : "No sources referenced." }], 9);
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
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
