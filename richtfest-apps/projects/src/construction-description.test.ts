import { expect, test } from "bun:test";
import { mergeComponentStatements, readConstructionDescription } from "./construction-description";

const description = `3.2 Außenwände
Außenwände aus Kalksandstein, d = 17,5 cm, mit Wärmedämmverbundsystem 16 cm.

3.3 Wohnungstrennwände
Wohnungstrennwände KS 24 cm, RDK 2,0, beidseitig verputzt bis unter die Decken.

3.4 Treppenhauswände: Stahlbeton 25 cm.

3.5 Innenwände
Nichttragende Innenwände als Metallständerwand mit Gipskarton, 100 mm.

4. Decken
Geschossdecken aus Stahlbeton, d = 22 cm, Rohdichte 2.400 kg/m³.`;

test("a construction description yields the values it states once per component heading", () => {
  const merged = mergeComponentStatements(readConstructionDescription([{ page: 3, text: description }]));
  expect(merged.map(group => [group.target.wallRole ?? group.target.componentType, Object.fromEntries(Object.entries(group.values).map(([field, stated]) => [field, stated.value]))])).toEqual([
    // Two thicknesses (wall and insulation) in one passage: thickness is left out, not guessed.
    ["exterior", { material: "Kalksandstein", construction: "masonry" }],
    // "bis unter die Decken" inside a sentence does not start a ceiling passage.
    ["apartment_partition", { material: "Kalksandstein", construction: "masonry", thickness: 24, bulkDensity: 2000 }],
    ["stairwell", { material: "Stahlbeton", construction: "concrete", thickness: 25 }],
    ["internal", { material: "Gipskarton-Ständerwand", construction: "drywall", thickness: 10 }],
    ["ceiling", { material: "Stahlbeton", construction: "concrete", thickness: 22, bulkDensity: 2400 }],
  ]);
  expect(merged[1].values.thickness).toMatchObject({ page: 3, quote: "Wohnungstrennwände KS 24 cm, RDK 2,0, beidseitig verputzt bis unter die Decken." });
});

test("statements that disagree cancel each other instead of one winning", () => {
  const merged = mergeComponentStatements(readConstructionDescription([
    { page: 2, text: "Wohnungstrennwände: Kalksandstein 24 cm, RDK 1,8" }, { page: 7, text: "Wohnungstrennwände Kalksandstein 17,5 cm" }]));
  expect(merged).toHaveLength(1);
  expect(Object.keys(merged[0].values)).toEqual(["material", "construction", "bulkDensity"]);
  expect(merged[0].conflicts).toEqual(["thickness"]);
});
