import { describe, expect, test } from "bun:test";
import { SOURCE_IMAGE_MODEL, SOURCE_IMAGE_QUERY_VERSION, type SourceImageReceipt } from "@richtfest/shared";
import { classifyPlanPages } from "./automatic-building-model";

const receipt = (page: number, choice: string, confidence: number): SourceImageReceipt => ({
  versionId: "00000000-0000-4000-8000-000000000001", page, status: "completed", provenance: "inferred",
  semanticInspection: false, queryVersion: SOURCE_IMAGE_QUERY_VERSION, model: SOURCE_IMAGE_MODEL, reason: "bounded triage",
  answers: { page_type: { type: "choice", choice, confidence, probabilities: {
    floor_plan: choice === "floor_plan" ? confidence : 1 - confidence,
    section: choice === "section" ? confidence : 1 - confidence,
  } } },
});
describe("automatic building-model page coverage", () => {
  test("queues only confident floor plans and retains every other page as classified or unresolved", () => {
    expect(classifyPlanPages({ pageCount: 4, imageClassification: { receipts: [
      receipt(1, "floor_plan", 0.91), receipt(2, "section", 0.94), receipt(3, "floor_plan", 0.55),
    ] } })).toEqual([
      expect.objectContaining({ page: 1, classification: "floor_plan", pageType: "floor_plan" }),
      expect.objectContaining({ page: 2, classification: "non_floor_plan", pageType: "section" }),
      expect.objectContaining({ page: 3, classification: "unresolved", pageType: "floor_plan" }),
      expect.objectContaining({ page: 4, classification: "unresolved", pageType: null }),
    ]);
  });

  test("exact source drawing titles override inferred page type without treating floor annotations on sections as plans", () => {
    const pages = classifyPlanPages({ pageCount: 4, imageClassification: { receipts: [
      receipt(1, "section", 0.99), receipt(2, "floor_plan", 0.99), receipt(3, "floor_plan", 0.99),
      receipt(4, "floor_plan", 0.99),
    ] }, pageTexts: new Map([
      [1, "Grundriss 1. Obergeschoss"],
      [2, "Schnitt A-A Erdgeschoss Obergeschoss"],
      [3, "Ansicht Nord"],
      [4, "FREIFLÄCHENPLAN zeichnerischer Nachweis"],
    ]) });
    expect(pages.map(page => page.classification)).toEqual(["floor_plan", "non_floor_plan", "non_floor_plan", "non_floor_plan"]);
    expect(pages.every(page => page.confidence === 1)).toBe(true);
  });

  test("repeated room labels and an apartment schedule identify a floor plan when image confidence is low", () => {
    const [page] = classifyPlanPages({ pageCount: 1, imageClassification: { receipts: [
      receipt(1, "floor_plan", 0.47),
    ] }, pageTexts: new Map([[1, "Schlafen Kind Bad Flur Wohnen WE 19 Wfl. 82,14 m²"]]) });
    expect(page).toMatchObject({ page: 1, classification: "floor_plan", pageType: "floor_plan", confidence: 1 });
  });

  test("coverage is bounded and never silently drops an unknown single-page PDF", () => {
    expect(classifyPlanPages({ pageCount: null })).toEqual([
      expect.objectContaining({ page: 1, classification: "unresolved" }),
    ]);
    expect(classifyPlanPages({ pageCount: 900 })).toHaveLength(500);
  });
});
