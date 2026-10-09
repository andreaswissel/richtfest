import { expect, test } from "bun:test";
import { extractSourceText } from "./source-text";
async function* bytes(value: Uint8Array) {
  yield value;
}
function tinyPdf() {
  const stream = "BT /F1 12 Tf 20 50 Td (Source wall type AL24) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let result = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(result.length);
    result += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const offset = result.length;
  result += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`;
  return new TextEncoder().encode(result);
}
test("extracts actual PDF text with immutable page coverage", async () => {
  const result = await extractSourceText(
    bytes(tinyPdf()),
    "application/pdf",
    "source.pdf",
  );
  expect(result.status).toBe("available");
  expect(result.text).toContain("Source wall type AL24");
  expect(result.coverage).toEqual({
    pageStart: 1,
    pageEnd: 1,
    totalPages: 1,
    truncated: false,
    nextPage: null,
  });
});
test("bounds text processing without changing source upload size", async () => {
  const result = await extractSourceText(
    bytes(new TextEncoder().encode("a".repeat(70000))),
    "text/plain",
    "source.ifc",
  );
  expect(result.text?.length).toBe(65536);
  expect(result.truncated).toBe(true);
});
test("mocked provider receives extracted PDF evidence and proposes a draft", async () => {
  const { callProvider } = await import("./provider-runtime");
  const source = await extractSourceText(
    bytes(tinyPdf()),
    "application/pdf",
    "source.pdf",
  );
  const output = await callProvider(
    { provider: "openai", goal: "Review source", context: { source } },
    "sk-test-placeholder",
    async (_url, init) => {
      expect(String(init.body)).toContain("Source wall type AL24");
      return Response.json({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  summary: "Review AL24",
                  rationale: "Exact source excerpt",
                  citations: [],
                  tools: [],
                  artifact: {
                    title: "Source review",
                    content: "Source wall type AL24 requires review",
                    type: "draft",
                  },
                }),
              },
            ],
          },
        ],
      });
    },
  );
  expect((output as any).artifact.type).toBe("draft");
});
