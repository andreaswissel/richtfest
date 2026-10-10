export const soundInsulationPlanningFixture = {
  projectName: "Bendenweg 6, Alzey",
  prompt:
    "Moin Meister! Schau dir mal die Projektdateien an und bau eine Schallschutzplanung.",
  sources: [
    {
      fileId: "00000000-0000-4000-8000-000000000201",
      name: "Grundrisse und Schnitte.pdf",
      versionId: "00000000-0000-4000-8000-000000000101",
      version: 3,
      mimeType: "application/pdf",
    },
    {
      fileId: "00000000-0000-4000-8000-000000000202",
      name: "Baubeschreibung und Schallschutzanforderungen.pdf",
      versionId: "00000000-0000-4000-8000-000000000102",
      version: 2,
      mimeType: "application/pdf",
    },
  ],
  excerpts: {
    "00000000-0000-4000-8000-000000000101":
      "Grundrisse und Schnitte mit Raumaufteilung und Bauteilbezeichnungen.",
    "00000000-0000-4000-8000-000000000102":
      "Projektanforderungen zu Außenlärm und Innenlärm; konkrete Bauteilwerte sind zu prüfen.",
  },
  expectedSummary:
    "Vorläufige Schallschutzplanung als Arbeitsgrundlage; keine geprüfte Freigabe.",
} as const;
