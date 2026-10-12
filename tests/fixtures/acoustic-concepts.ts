/** Synthetic evidence only; never copy customer data or acoustic results from the references. */
export function acousticConceptFixture(id: "interior-noise-concept" | "exterior-noise-concept", language: "de" | "en", versionId: string) {
  const de = language === "de";
  const common = {
    id, version: 1 as const, language,
    project: { name: "Template verification", number: "TEST-42", client: null, designer: null, author: null, date: null },
    preliminaryRemarks: de ? "Konzeptentwurf für ein synthetisches Testprojekt. Keine Ausführungsfreigabe." : "Concept draft for a synthetic test project. Not approved for construction.",
    plans: de ? `Erdgeschoss, Seite 2 [${versionId}]. Akustische Markierungen fehlen.` : `Ground floor, page 2 [${versionId}]. Acoustic markings missing.`,
    components: de
      ? `| Bauteil | Quellenbezug | Aufbau | Prüfstatus |\n| --- | --- | --- | --- |\n| Trennwand W-17 | [${versionId}], S. 2 | Nicht belegt | Ungeprüft |`
      : `| Component | Source | Build-up | Review status |\n| --- | --- | --- | --- |\n| Separating wall W-17 | [${versionId}], p. 2 | Not evidenced | Unreviewed |`,
    planningLaw: de ? "Bebauungsplan und Anwendbarkeit offen." : "Development plan and applicability unresolved.",
    sourcesAndRevisions: `[${versionId}] · v3 · ${de ? "Planungsstand ungeprüft" : "Design revision unreviewed"}`,
    openIssues: de ? "Bauteilaufbauten und Schutzniveau bestätigen lassen." : "Obtain confirmation of build-ups and protection level.",
    calculationAppendix: de ? "Keine Berechnungsnachweise vorgelegt. Keine Anlage beigefügt." : "No calculation evidence supplied. No appendix attached.",
  };
  return id === "interior-noise-concept" ? {
    ...common, id,
    requirements: de ? "Mindestanforderung und vereinbartes Schutzniveau getrennt klären." : "Clarify statutory minimum and agreed protection separately.",
    verification: de ? "Luft- und Trittschallnachweise fehlen." : "Airborne and impact-noise evidence missing.",
    buildingServices: de ? "Entkopplung von Treppen und Sanitäranlagen nicht belegt." : "Stair and sanitary-installation decoupling not evidenced.",
    heatPumps: de ? "Aufstellort und Schallleistungsdaten der Wärmepumpe fehlen." : "Heat-pump location and sound-power data missing.",
    protectionLevels: de ? "Keine DEGA-Klasse vereinbart oder bestätigt." : "No DEGA class agreed or certified.",
  } : {
    ...common, id,
    exteriorNoiseAssessment: de ? "Nordfassade: Tag-/Nachtpegel fehlen. Keine Pegelberechnung." : "North facade: day/night levels missing. No noise prediction.",
  };
}
