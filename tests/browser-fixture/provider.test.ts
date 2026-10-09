import { describe, expect, test } from "bun:test";
import {
  browserFixtureOutput,
  createBrowserFixtureProviderFetch,
} from "./provider";
import { validateOpenUI } from "../../richtfest-os/apps/api/src/openui-validation";

describe("browser streaming fixture provider", () => {
  test("emits OpenAI-compatible SSE deltas that reassemble to proposed output", async () => {
    const fetchFixture = createBrowserFixtureProviderFetch({
      chunkDelayMs: 0,
      chunkSize: 9,
    });
    const response = await fetchFixture("https://unused.invalid", {
      method: "POST",
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const wire = await response.text();
    const deltas = wire
      .split("\n")
      .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
      .map((line) => JSON.parse(line.slice(6)).delta as string);
    expect(deltas.length).toBeGreaterThan(1);
    expect(JSON.parse(deltas.join(""))).toEqual(browserFixtureOutput);
    expect(browserFixtureOutput.openui).toContain("root = Callout(");
    expect(validateOpenUI(browserFixtureOutput.openui)).toEqual({
      sourceVersionIds: [],
      artifactIds: [],
    });
    expect(browserFixtureOutput.artifact.type).toBe("draft");
  });
});
