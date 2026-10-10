import type { PublicDatasetMetadata } from "@richtfest/shared";
import { datasets, partitions } from "./schema";

export const BERLIN_SCOPE = "berlin-giersstrasse-20";
// 200 m square around official Berlin address 61316, checked 2026-10-10; not a survey.
export const BERLIN_BBOX: [number, number, number, number] = [397036.524413514, 5824034.603153919, 397236.524413514, 5824234.603153919];
export const berlinSources = [
  { id: "7e8f0651-92f5-48d0-a66c-3c9c937c1401", partitionId: "7e8f0651-92f5-48d0-a66c-3c9c937c1501", slug: "berlin-building-heights", label: "Berlin building heights 2022", service: "ua_gebaeudehoehen", layer: "gebaeudehoehen", kind: "building", metadataId: "d8b0505d-f1a8-433b-a8e0-867f106cecb3" },
  { id: "7e8f0651-92f5-48d0-a66c-3c9c937c1402", partitionId: "7e8f0651-92f5-48d0-a66c-3c9c937c1502", slug: "berlin-street-trees", label: "Berlin street trees", service: "baumbestand", layer: "strassenbaeume", kind: "tree", metadataId: "3368004a-d596-336a-8fdf-c4391f3313dd" },
  { id: "7e8f0651-92f5-48d0-a66c-3c9c937c1403", partitionId: "7e8f0651-92f5-48d0-a66c-3c9c937c1503", slug: "berlin-park-trees", label: "Berlin park trees", service: "baumbestand", layer: "anlagenbaeume", kind: "tree", metadataId: "3368004a-d596-336a-8fdf-c4391f3313dd" },
] as const;

export async function seedCatalogue(db: any) {
  await db.transaction(async (tx: any) => {
    for (const source of berlinSources) {
      const building = source.kind === "building";
      const metadata: PublicDatasetMetadata = {
        publisher: building ? "Senatsverwaltung für Stadtentwicklung, Bauen und Wohnen Berlin" : "Senatsverwaltung für Mobilität, Verkehr, Klimaschutz und Umwelt Berlin",
        metadataUrl: `https://gdi.berlin.de/geonetwork/srv/ger/csw?service=CSW&request=GetRecordById&version=2.0.2&outputschema=http%3A%2F%2Fwww.isotc211.org%2F2005%2Fgmd&elementsetname=full&id=${source.metadataId}`,
        licence: "dl-de/zero-2-0", licenceUrl: "https://www.govdata.de/dl-de/zero-2-0", attribution: "No mandatory attribution; publisher retained for provenance.",
        sourceUpdatedAt: building ? "2023-08-23" : "2026-04-09", surveyedAt: null,
        declaredCadence: building ? "annually" : "asNeeded",
        coverageNote: building ? "Generalized LoD2 roof heights, source model dated 2022-04-07; not a survey. Metadata checked 2026-10-10." : "Street trees and partial park-tree coverage; no common measurement date. Metadata checked 2026-10-10.",
      };
      await tx.insert(datasets).values({ id: source.id, slug: source.slug, label: source.label, connector: source.slug, metadata }).onConflictDoNothing();
      await tx.insert(partitions).values({ id: source.partitionId, datasetId: source.id, scope: BERLIN_SCOPE, bbox: BERLIN_BBOX, intervalSeconds: 86400 }).onConflictDoNothing();
    }
  });
}
