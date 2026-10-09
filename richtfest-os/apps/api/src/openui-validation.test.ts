import { expect, test } from "bun:test";
import { validateOpenUI } from "./openui-validation";
test("artifact previews require artifact ownership validation", () => {
  const id = "550e8400-e29b-41d4-a716-446655440002";
  expect(
    validateOpenUI(
      `root = ArtifactPreview("${id}", "550e8400-e29b-41d4-a716-446655440003")`,
    ),
  ).toEqual({ sourceVersionIds: [], artifactIds: [id] });
});
test("accepts static registered source-grounded UI", () => {
  expect(validateOpenUI('root = Callout("Proposed source review")')).toEqual({
    sourceVersionIds: [],
    artifactIds: [],
  });
});
test("rejects executable, external, unregistered or incomplete UI", () => {
  for (const code of [
    'root = Callout("https://example.com")',
    'root = Query("fetch", {})',
    'root = Unknown("x")',
    'root = Callout("unfinished',
    "root = Callout(missing)",
    'root = Callout(Action(OpenUrl("https://example.com")))',
  ])
    expect(() => validateOpenUI(code)).toThrow();
});
