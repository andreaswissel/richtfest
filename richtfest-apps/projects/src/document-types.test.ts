import { expect, test } from "bun:test";
import { inferDocumentType } from "./document-types";
import { replyText } from "./inquiries";

const infer = (name: string, titleText = "", pages: Partial<{ floorPlanPages: number; drawingPages: number; pages: number }> = {}) =>
  inferDocumentType({ name, titleText, floorPlanPages: pages.floorPlanPages ?? 0, drawingPages: pages.drawingPages ?? 0, pages: pages.pages ?? null })?.documentType ?? null;

test("document types come from the title, not from documents the body mentions", () => {
  expect(infer("BV_Musterstr.pdf", "Baubeschreibung\nNeubau eines Mehrfamilienhauses\nGemäß Bebauungsplan Nr. 12 …")).toBe("construction_description");
  expect(infer("Anlage 3.pdf", "Schalltechnische Untersuchung zum Bebauungsplan Nr. 12")).toBe("acoustic_report");
  expect(infer("B-Plan 12 Textteil.pdf", "Satzung")).toBe("development_plan");
  expect(infer("scan.pdf", "Sehr geehrte Damen und Herren,\nanbei die Baubeschreibung")).toBe("construction_description");
  expect(infer("scan.pdf", "Sehr geehrte Damen und Herren,\nwie besprochen …")).toBe("correspondence");
  // A plan set mentioning a Baubeschreibung in its legend is still plans when the name says nothing.
  expect(infer("Grundriss_OG1.pdf", "", { floorPlanPages: 1, pages: 1 })).toBe("plans");
  expect(infer("Anlage.pdf", "Inhaltsverzeichnis")).toBeNull();
});

test("a reply is read without the quoted request it answers", () => {
  expect(replyText("Decken 22 cm.\n\nAm 3. März 2026 um 10:12 schrieb Richtfest:\n> Decken: Dicke?")).toBe("Decken 22 cm.");
  expect(replyText("Decken 22 cm.\n-----Ursprüngliche Nachricht-----\nVon: Richtfest\nDecken: Dicke?")).toBe("Decken 22 cm.");
  expect(replyText("Decken 22 cm.\n> Außenwände 30 cm\nGrüße")).toBe("Decken 22 cm.\nGrüße");
  // A forwarded mail's own header block at the top is kept.
  expect(replyText("Von: Architekt\nDecken 22 cm.")).toBe("Von: Architekt\nDecken 22 cm.");
});
