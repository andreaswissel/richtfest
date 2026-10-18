import { expect, test } from "bun:test";
import { proposeDocumentType } from "./document-type-proposal";
const version = "5d224902-c3d9-41b3-8c1d-01d3a30c6f7f";
const context = { workflow: "site_assessment" };
const pages = (text: string) => [{ page: 3, content: { text } }];

test("workflow scopes content inference without inventing a document type", () => {
  expect(proposeDocumentType(version, {}, pages("Bebauungsplan 12-3"))).toBeUndefined();
  expect(proposeDocumentType(version, context, pages("Project notes"))).toMatchObject({ status: "unknown", documentType: null });
});
test("content headings distinguish preliminary decisions from plans cited in prose", () => {
  expect(proposeDocumentType(version, context, pages("Vorbescheid\nDas Vorhaben liegt im Bebauungsplan 12-3.\nDie Baulast ist zu prüfen."))).toEqual({
    versionId: version, documentType: "permit", kind: "preliminary_permit", status: "proposed", reviewStatus: "unreviewed",
    evidence: [{ page: 3, quote: "Vorbescheid" }],
  });
  expect(proposeDocumentType(version, context, pages("Bebauungsplan 12-3\nTextliche Festsetzungen"))).toMatchObject({ kind: "development_plan", documentType: "development_plan" });
});
test("upload metadata cannot approve or supply classification", () => {
  const metadata = { ...context, reviewStatus: "approved", documentTypeProposal: { status: "proposed", documentType: "permit", reviewStatus: "approved" } };
  expect(proposeDocumentType(version, metadata, pages("Unbekannt"))).toMatchObject({ reviewStatus: "unreviewed", documentType: null, status: "unknown", versionId: version });
});
test("conflicting headings remain ambiguous with exact page evidence", () => {
  expect(proposeDocumentType(version, context, [{ page: 1, content: { text: "Vorbescheid" } }, { page: 4, content: { text: "Bebauungsplan 12-3" } }])).toMatchObject({
    status: "ambiguous", kind: null, documentType: null, evidence: [{ page: 1, quote: "Vorbescheid" }, { page: 4, quote: "Bebauungsplan 12-3" }],
  });
});
test.each([
  ["Baulastenverzeichnis", "building_encumbrance", "other"],
  ["Geh- und Fahrrecht", "right_of_way", "other"],
  ["Auszug aus dem Liegenschaftskataster", "cadastral", "plans"],
  ["Baugenehmigung", "permit", "permit"],
])("recognizes %s without adding unsupported planning conclusions", (text, kind, documentType) => {
  expect(proposeDocumentType(version, context, pages(text))).toMatchObject({ kind, documentType, reviewStatus: "unreviewed" });
});
test("incidental prose and scanned empty text stay unknown", () => {
  expect(proposeDocumentType(version, context, pages("Wir beantragen einen Vorbescheid zum Bebauungsplan."))).toMatchObject({ status: "unknown" });
  expect(proposeDocumentType(version, context, pages(""))).toMatchObject({ status: "unknown" });
});

test.each(["Bebauungsplan wird nachgereicht", "Vorbescheid liegt nicht vor", "Baulast ist nicht eingetragen", "Wegerecht muss noch beantragt werden", "Baugenehmigung fehlt", "Bebauungsplan wurde angefordert"])("does not identify documents from prose reference: %s", text => {
  expect(proposeDocumentType(version, context, pages(text))).toMatchObject({ status: "unknown", documentType: null, evidence: [] });
});
