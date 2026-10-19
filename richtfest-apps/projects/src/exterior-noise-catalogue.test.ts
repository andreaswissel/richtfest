import { describe, expect, test } from "bun:test";
import { classifyMassiveWall } from "./exterior-noise-catalogue";

describe("massive wall classification", () => {
  test("reads the mass law and unit type from the material text", () => {
    expect(classifyMassiveWall("masonry", "Kalksandstein KS 20-1,8")).toEqual({ material: "dense", form: "masonry", perforated: "none" });
    expect(classifyMassiveWall("masonry", "Hochlochziegel HLz 12-0,8")).toEqual({ material: "dense", form: "masonry", perforated: "clay" });
    expect(classifyMassiveWall("masonry", "Vollziegel Mz")).toEqual({ material: "dense", form: "masonry", perforated: "none" });
    expect(classifyMassiveWall("concrete", "Stahlbeton C25/30")).toEqual({ material: "dense", form: "concrete", perforated: "none" });
    expect(classifyMassiveWall("concrete", null)).toEqual({ material: "dense", form: "concrete", perforated: "none" });
    expect(classifyMassiveWall("masonry", "Porenbeton-Planstein PP2")).toEqual({ material: "aerated_concrete", form: "masonry", perforated: "none" });
    // "Leichtbeton" contains "beton": it must not fall through to normal-weight concrete.
    expect(classifyMassiveWall("masonry", "Leichtbeton-Hohlblockstein Hbl 2")).toEqual({ material: "lightweight_concrete", form: "masonry", perforated: "block" });
  });

  test("build-ups the single-leaf mass law does not cover get no value", () => {
    expect(classifyMassiveWall("masonry", "Kalksandstein mit WDVS 16 cm")).toEqual({ reason: "multi_leaf" });
    expect(classifyMassiveWall("masonry", "Füllziegel, verfüllt")).toEqual({ reason: "multi_leaf" });
    expect(classifyMassiveWall("timber", "Holzrahmenbau")).toEqual({ reason: "not_massive" });
    expect(classifyMassiveWall("masonry", "Mauerwerk")).toEqual({ reason: "material_unknown" });
    expect(classifyMassiveWall("masonry", "KS mit Schlitzlochung")).toEqual({ reason: "material_unknown" });
  });
});
