import { expect, test } from "bun:test";
import { assertEvidenceCitations, recordResolvedEvidence } from "./runs";
const supplied = "00000000-0000-4000-8000-000000000001";
const unreadProjectVersion = "00000000-0000-4000-8000-000000000002";

test("project-owned but unread versions cannot be cited in prose or OpenUI", () => {
  const evidence = new Set([supplied]);
  expect(() =>
    assertEvidenceCitations({ citations: [supplied] }, evidence),
  ).not.toThrow();
  expect(() =>
    assertEvidenceCitations({ citations: [unreadProjectVersion] }, evidence),
  ).toThrow("not supplied or resolved");
  expect(() =>
    assertEvidenceCitations(
      {
        citations: [],
        openuiReferences: { sourceVersionIds: [unreadProjectVersion] },
      },
      evidence,
    ),
  ).toThrow("not supplied or resolved");
});

test("only readable source text extends this run's citation scope", () => {
  const evidence = new Set([supplied]);
  recordResolvedEvidence(evidence, {
    status: "missing_input",
    candidates: [{ versionId: unreadProjectVersion }],
  });
  recordResolvedEvidence(evidence, {
    status: "failed",
    source: { versionId: unreadProjectVersion },
  });
  recordResolvedEvidence(evidence, {
    status: "resolved",
    source: { versionId: unreadProjectVersion },
    content: { status: "unsupported", reason: "Scanned document" },
  });
  recordResolvedEvidence(evidence, {
    status: "resolved",
    source: { versionId: unreadProjectVersion },
    content: { status: "available", text: "" },
  });
  recordResolvedEvidence(evidence, {
    status: "resolved",
    source: { versionId: unreadProjectVersion },
    content: { status: "available", text: "   " },
  });
  expect(evidence.has(unreadProjectVersion)).toBe(false);
  recordResolvedEvidence(evidence, {
    status: "resolved",
    source: { versionId: unreadProjectVersion },
    content: { status: "available", text: "Extracted source evidence" },
  });
  expect(() =>
    assertEvidenceCitations(
      {
        citations: [unreadProjectVersion],
        openuiReferences: { sourceVersionIds: [unreadProjectVersion] },
      },
      evidence,
    ),
  ).not.toThrow();
  expect(() =>
    assertEvidenceCitations(
      { citations: [unreadProjectVersion] },
      new Set([supplied]),
    ),
  ).toThrow();
});
