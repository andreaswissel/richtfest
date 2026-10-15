import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { compareExteriorNoiseReference } from "../richtfest-apps/acoustics/src/reference-comparison";

// Local files and arithmetic only. No credentials, database, model or resolver.
const { values } = parseArgs({ options: {
  inputs: { type: "string" }, reference: { type: "string" },
} });
if (!values.inputs || !values.reference) {
  console.error("Usage: bun scripts/evaluate-exterior-noise-reference.ts --inputs inputs.json --reference answers.json");
  process.exit(2);
}
const inputs = await Bun.file(values.inputs).text();
const reference = await Bun.file(values.reference).text();
const result = compareExteriorNoiseReference(JSON.parse(inputs), JSON.parse(reference));
console.log(JSON.stringify({ ...result,
  inputFileSha256: createHash("sha256").update(inputs).digest("hex"),
  referenceFileSha256: createHash("sha256").update(reference).digest("hex"),
  note: "Printed-input reproduction, not a released Nachweis. La, corrections, ratings and geometry are supplied reference claims. No day/night selection or compliance approval is performed.",
}, null, 2));
process.exitCode = result.withinTolerance ? 0 : 1;
