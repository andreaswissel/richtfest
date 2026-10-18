# Berlin public-source acceptance evidence

These fixtures preserve a small subset of the live official captures retrieved on 18 October 2026. They test imported geometry and keep source evidence separate from reviewed planning rights. Nothing here is a building permit, a verified site-specific Baufenster or an approved maximum BGF.

## Parcel identity

- **Giersstraße 20:** the address-containing ALKIS parcel is `DEBE00YYAC00002j`, Weißensee, Flur 263, Flurstück 292. Its official attribute is **995 m²**. The earlier arithmetic example derived 986.8421 m² from 375 / 0.38; that is not the official parcel area. Keep the historical arithmetic fixture separate.
- **Eldenaer Straße 60:** its address point falls in `DEBE03YY600002bP`, Flur 915, Flurstück 9236, **2,166 m²**. Nearby `DEBE03YY600001ns`, Flurstück 9139, is **1,041 m²**, but does not contain that address point. It remains an unconfirmed candidate for the user's site. Its matching area alone does not prove identity. The current address lookup also does not establish “60A”.
- **Falkenberger Straße 145:** the address-containing parcel is `DEBE03YY70000LxP`, Weißensee 252 / 52, **3,171 m²**. Its parcel geometry is a reference source, not an approved planning comparator.

Each fixture retains the official WFS URL, source date, retrieval timestamp, parcel ID and full polygon. Areas derived from coordinates may differ slightly from the rounded official attribute.

## IV-2c plan review

The [official adopted plan scan](https://fbinter.stadt-berlin.de/ScansBPlan/03_PA/IV-2c_Abz.pdf) labels WA5 with four full storeys, GRZ 0.5 and GFZ 1.6. The [official explanation](https://fbinter.stadt-berlin.de/ScansBPlan/Begruendungen/0304002c_IV-2c.pdf), pages 25–27, sections II.3–II.3.2, distinguishes residential areas (those values) from mixed-use areas (five full storeys, GRZ 0.6, GFZ 1.6). Page 27 explains the western WA5 Baugrenze at 3 m from TS25. The plan uses Baugrenzen; it does not establish a mandatory Baulinie for this candidate through that symbol alone.

The red outline in `eldena-approximate-plan-overlay.png` is the current candidate parcel, approximately aligned to the historic scan. Its position corroborates WA5 rather than adjacent MI3. This is a QA illustration, not a reviewed alignment or a digitized legal envelope. The jagged parcel has narrow extensions; it must not be replaced by a simple 1,041 m² rectangle.

Reproduction: transform the EPSG:25833 parcel to EPSG:3068 (Soldner Berlin), respecting that `cs2cs` returns northing then easting. Align using the scan's printed grid intersections (28500/22000, 28900/22000 and 28900/21600). The raster was visually picked, with approximately metre-scale uncertainty; no boundary coordinates were extracted from it. SHA-256 hashes and URLs of both source PDFs are in the JSON. No source PDFs are duplicated in the repository.

## What remains unverified

The user's intended Eldena parcel, exact reviewed envelope, current register rights/Baulasten, full site-specific plan applicability, permitted exceptions, and any individual Vorbescheid or Baugenehmigung require their original records. The reported approved GFZ 1.27 and the five-storey exception are not proven by this public plan. Giers GRZ 0.38/GFZ 1.28 remain reported assessment inputs, not values verified in an individual official approval here. A common denominator is not a sufficient §34 neighborhood assessment.

## Test scope

Run `bun test richtfest-apps/feasibility/tests/fixtures/berlin-real-sites.test.ts`.

Tests validate all three actual polygons, compare derived and official areas, verify unreviewed imports cannot become reviewed results, and exercise clipping on real irregular geometry. The 3 m setbacks, parcel-as-envelope and massing parameters used in tests are explicitly hypothetical test inputs. They are never exported as approved rights or saved project defaults.
