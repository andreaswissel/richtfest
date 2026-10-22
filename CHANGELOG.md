# Changelog

## 2026-10-22

- **Lighter first load:** Fire-protection calculations and law references now load with the project workspace instead of slowing down every app startup.
- **Fire protection in the building model (Rheinland-Pfalz and Berlin):** Enter the federal state, the height of the highest habitable floor, units, Sonderbau and garage under **Fire protection**, and Richtfest shows the Gebäudeklasse and whether a plan-based Nachweis or a full Brandschutzkonzept with Prüfsachverständigen review is needed. **Show Brandschutzplan** colours the plan like the office draws it: required wall ratings from the rooms on both sides, notwendiger Treppenraum and Flur in green, door closures (D, RS, T30 …) and every room's escape route as a line with its length against 35 m. Each wall and door shows its requirement with the LBauO paragraph; enter the provided rating to mark it met. **Copy written part (draft)** writes the Brandschutzkonzept text in the office's chapter structure: each requirement quoted from the LBauO, then how the building meets it, with placeholders for what the model cannot know and unmet components as Abweichungen. Berlin uses the BauO Bln, including its 400 m² unit limit for GK 4 and review by a Prüfingenieur/in für Brandschutz.
- **Review imported IFC models:** Propose room and element classifications with source evidence, then explicitly approve or reject each value with a reason. Record findings and open questions for source warnings without hiding missing inputs; confirmed values remain separate from newer proposals.
- **Building models from IFC:** Preview an uploaded IFC revision, review source limitations and select the building storeys to import. Rooms and elements become a saved draft with metre-based plan geometry and links to their IFC identities; existing work stays intact and repeated imports create no duplicates. IFC uploads remain identifiable when given a custom label.

## 2026-10-19

- **Storeys in the outliner:** The building model outliner now lists every storey of the plan set, top floor first, with its level and room count, or switch it to group by plan page. Expand a storey or page to see its rooms, or open its plan from its row.
- **Room detection at the plan's scale:** Plan extraction now reads each sheet's scale from its dimension chains (and a printed "M 1:100" when they agree), shown in Plan context where you can correct it. Rooms are bounded only by walls and doors: furniture, door swings and fittings belong to the room, kept existing walls separate rooms, and a living room, dining area, kitchen or hall that share one open space become one room ("Wohnen / Diele") with both labels and printed areas. On a real plan, rooms within 10 % of their printed area went from none to 55 of 59. Existing plans are re-extracted automatically.
- **Merge rooms:** In the building model, select a room candidate and merge it with a neighbouring one when the plan trace split one room; the wall or doorway between them becomes floor and the printed areas add up. **Split rooms** undoes it.
- **Landing page paused:** The public landing page is offline until its relaunch. `richtfest.ai` and the other marketing domains now forward to the app sign-in at `app.richtfest.ai`.
- **Messages with room to breathe:** Notes, errors and empty states that follow each other in a section no longer touch. Several notices on the building model plan now form a stack, the first in front and the others peeking out behind it; open it to read them all.
- **Walls from the plan:** Plan extraction now proposes nearly every wall of a real architect plan. Corners, T and cross junctions and short piers between windows are split into straight walls instead of being left as unsupported shapes; each plan set gets a **Wall colours** list in Plan context where you set what each fill colour means (planned, existing, demolished or not a wall; the usual DIN 1356-1 colours are preselected), so demolished walls stay out of the planned building's sound checks. Plans without layers (flattened prints) now get walls too, read from the outlines of the wall pen, and their rooms are separated along those lines. Existing plans are re-extracted automatically.
- **Hamburg parcels:** The site assessment now looks up official parcels for Hamburg addresses (ALKIS Hamburg, LGV): the parcel at the address point with its number, official area and last change, the parcels around it on the map, and adoption into the assessment and Design. Development plans, heritage, aerial image and neighbour GRZ/GFZ are still Berlin-only and say so for Hamburg sites.
- **Interior sound insulation complete:** Interior sound insulation now also checks elevated requirements (DIN 4109-5, when the building is set to elevated), stairs in the stairwell into the rooms behind it, impact sound from common hallways into the rooms beside and diagonally below, and building services (sanitary installations by the reference installation wall, others by a measured or certified level). Cross junctions are read from the plan, linings, suspended ceilings and the screed are credited, and drywall and timber elements take their values from the DIN 4109-33 catalogue, including timber ceiling impact sound. Add stairs and installations right in the view; the Nachweis and the Richtfest Agent cover the new checks.
- **Sound insulation in steps:** Sound insulation now opens in four steps (noise sources, facade levels, exterior noise, interior sound), each its own link. Every step reads top to bottom: inputs, suggestions to confirm, checks, then the Nachweis. Add forms sit in their own panels, each ceiling shows its construction with its checks into the rooms below, what a check still needs is shown in its result, and the room editor and element lists name each storey.
- **Windows and doors from the plan:** **Derive from plan** in the building model now turns the openings in the traced walls into windows and doors, each in its wall and room, with its outline on the plan and its width at the printed scale. Add the height (or area) and Rw and they count in the exterior noise and interior verifications; the Richtfest Agent fills them from a window schedule instead of adding duplicates. Openings entered earlier are linked from their wall, selectable in the outliner, and take their place on the plan where that is unambiguous.
- **Window Rw from DIN 4109-35:** Windows without a tested Rw can now be rated from the window catalogue. Enter the glazing (for example 6/16/4) when adding a window, and frame, seals, opening type, frame share and glazing bars in the building model if known; **Suggest Rw from the component catalogue** then suggests the window's Rw with the catalogue row and every correction as its basis, taking unknown conditions at their least favourable. The Richtfest Agent can read glazing and glass Rw from a Fensterliste.
- **Exterior noise: roofs and small elements:** The exterior noise verification now covers roofs and small elements. Add the roof surfaces bounding a room (top storey, sloped ceiling) with construction, area and Rw; a roof takes the loudest La of the room's facades. Ventilators, roller shutter boxes and similar parts are entered with their count and Dn,e,w, and the Richtfest Agent can suggest them from data sheets.
- **Interior verification: entrance doors and the storey above:** Interior sound insulation now checks entrance doors from the stairwell or common hallway: add a door to a stairwell or corridor wall with where it leads (dwelling hallway or habitable room) and its tested Rw, and it is checked against DIN 4109-1. A stairwell wall with such a door is held to the requirement for walls with doors instead of the full wall requirement. The Nachweis lists the doors, and the Richtfest Agent can suggest doors and their Rw from a Türliste or plan with the cited page. Ceiling checks now take the flanking walls above the ceiling from the storey above's own plan instead of assuming they repeat the walls below.
- **Exterior noise for every storey:** Facade levels and the exterior noise verification now take each storey from its own floor plan. Plans of further storeys are aligned to the placed plan by their building outline, so set-back upper floors get their own facades; rooms are named with their storey ("EG · Wohnen"), each storey has its own clear room height, and one Nachweis covers the whole building. Receiver heights follow the storey level set in the building model.
- **Interior sound insulation:** The project's Exterior noise view is now **Sound insulation** and also checks interior components against the DIN 4109-1 minimum requirements: airborne sound of apartment, corridor and stairwell walls between each pair of rooms and of ceilings into each room below, with flanking transmission over the walls and slabs the building model knows, and impact sound of ceilings with their floating screed. Element values come from the component catalogue; enter ceiling type, screed and Dn,f,w of lightweight walls right there or in the building model. **Create interior Nachweis** writes the draft Schallschutznachweis Innenbauteile with every transmission path, assumptions and open inputs, and the Richtfest Agent suggests missing inputs from the project sources with the cited page.
- **Quicker data entry in the building model:** Several property edits in a row (for example material, thickness and density of a wall) now all save, each once, without waiting for the previous one.
- **Richtfest Agent fills the exterior noise verification:** Ask the agent to prepare the Schallschutznachweis: it reports which rooms are missing what, suggests room uses, windows from the Fensterliste, Rw values and heights from the project sources with the cited page, and can create the draft Nachweis. Accept or reject its suggestions in Exterior noise, one by one or all at once; unconfirmed suggestions keep the Nachweis a Teilstand.
- **Wall Rw from DIN 4109-32:** Exterior noise suggests the Rw of massive exterior walls from their material, thickness and density (mass law), with the calculation as its basis; insulated or multi-leaf walls and perforated units outside the catalogue are named instead of guessed.
- **Exterior noise in the building model:** Rooms, exterior walls, windows and doors show their exterior noise values (use, Rw and basis, opening area, surfaces complete); walls list their openings, and Sound insulation holds the method, flanking and each storey's clear room height.
- **Exterior noise verification:** Exterior noise lists the rooms of the placed plan with their exterior facades and La. Enter room use, clear room height, wall Rw and windows; complete rooms are checked against the DIN 4109-1 requirement right away. **Create Nachweis** writes the draft Schallschutznachweis Außenlärm with calculation sheets, the derivation of La and a sign-off block as a document and PDF.

- **Facade levels:** Exterior noise shows draft road rating levels after RLS-19 and relevant exterior noise levels La per facade and storey after DIN 4109-2, with every assumption and limitation listed. Roads take a surface type and gradient; railways take rating levels from a study. Needs the acoustic norm pack configured on the server.
- **Faster first load:** Feasibility texts now load with the project workspace instead of with the app, which takes about 38 kB off every first page load.
- **Review planning limits:** Planning limits now opens with the capacity the figures allow and one list sorted by what each limit does to it: limiting figures with the area they cost, street land on the parcel, reserves, then the checks. The cited plan page, the Baunutzungsplan map or a site plan stands beside the selected item; Enter accepts, E edits, R rejects, J and K move. Below the list, B-Plan sites get deviation routes worth asking for (§ 31 (2), § 31 (3) housing exemption, § 246e Bau-Turbo) with the area each would add, conditions and typical time, and proposed Baulasten and Grundbuch enquiries that become project planning tasks in the Plot phase.
- **B-Plan rules version:** The site assessment now records a B-Plan's type, adoption date and court review from the Berlin register and derives which BauNVO version applies. Plans before 1990 and the Baunutzungsplan no longer get a GRZ 2 default, and attic and Staffel rooms count toward GF there. In former West Berlin without a newer plan, parcels are marked "Baunutzungsplan 1960" instead of § 34; choosing the building class (e.g. V/3) on the plan map proposes storeys, GRZ, GFZ and building form.
- **Street land on the parcel:** In Design, mark an exclusion as "Not building land" (or let the plan trace find public traffic areas on the parcel); GRZ and GFZ then refer to the remaining building land (§ 19 (3) BauNVO), which can be adopted as the parcel area.
- **Planning law guide:** New Docs page explaining which rules decide what a parcel may hold, how a B-Plan check differs from § 34, neighbours and street, deviation routes (§ 31, Bau-Turbo) and how capacity becomes a deal decision.
- **Planning basis from official registers:** Planning limits now suggests the planning basis while it is open: the B-Plan in force at the address, or § 34 / § 35 from the land-use plan, with one click to use it. Under a B-Plan, "Read development plan" imports the plan PDF and proposes GRZ, GFZ, storeys and plan rules with page citations, all unreviewed. B-Plans from Mitte and Treptow-Köpenick, whose PDFs are hosted by the districts, can now be imported at all. Importing an official plan again reuses the stored PDF instead of adding another copy; a changed PDF is kept as the next revision of the same file.

## 2026-10-18

- **Residual land value as a feature flag:** The paused keep / densify / rebuild study is back as a second Feasibility tab, "Residual land value", for people who have the new per-user feature flag `feasibility_financial_study`; everyone else still sees only the site assessment, and old `study=financial` links open it. Operators enable flags per person by email (see Accounts → Feature flags). Includes a database migration.
- **Exterior noise across Germany:** Look up roads and railways now works in 13 states: the site address is located in the state's official address register (approximately via OpenStreetMap in Bayern, Mecklenburg-Vorpommern and Schleswig-Holstein) and roads and railways come from the state's official topographic map. Published traffic counts from the Umweltbundesamt and Eisenbahn-Bundesamt noise mapping attach to busy roads and main railway lines nationwide and fill a source's traffic or train volume inputs when you add it. Federal count stations (BASt) and the NRW, Niedersachsen and Sachsen road census are imported as well and take precedence, including heavy-vehicle counts. Hamburg, Sachsen and Saarland say no list is available yet.
- **Trees from LiDAR in 3D location:** Berlin sites now show trees on private plots that the public tree inventory misses, detected from the 2021 laser scan with approximate height and crown, on their own layer and marked as unreviewed. LiDAR now loads for sites in every Berlin district, not just Mitte.
- **Exterior noise in Berlin:** Look up roads and railways now works for Berlin sites, using the city's street network and the strategic noise map 2022: roads come with their published traffic count (Kfz/24h, Lkw share), which fills a road's traffic inputs as imported values when you add it, and railways list S- und Fernbahn, tram and above-ground U-Bahn. Sites outside the covered regions now say so instead of asking to look up again.
- **Outline editing:** Right-click a corner of a building or room outline to delete that point, or an edge to add one where you clicked. Clicking a corner now also focuses it, so Delete removes the point instead of the whole building.
- **Footprint proposal:** "Propose footprint" in Design proposes the base footprint: the largest outline whose Abstandsflächen stay on the parcel and clear of neighbours, inside the Baugrenze and within GRZ and GFZ, at the planned full storeys. Where neighbours stand on the side boundaries it builds to them (closed form). Up to three variants along the plot; each is unreviewed and can be dragged and reshaped like any outline. It replaces the massing variants list.
- **Building code rules:** The Landesbauordnung rules for all 16 states (Abstandsflächen, public areas, Nebengebäude, balconies, Staffelgeschoss) are stored with their paragraphs, read from official texts; Planning limits show the state's rules, and Design applies only verified ones. Neighbours' fire walls on the parcel boundary no longer count as setback conflicts.
- **Updates in projects:** "New updates available" now also appears in the project bar next to your profile, since the navigation rail is hidden inside projects.
- **Feasibility steps:** The site assessment always opens on Site, and the chosen step is kept in the link, so reloading or sharing it returns to the same step.
- **Design context layers:** Design shows the same context as the Site map: aerial image, B-Plan areas, monuments and preservation areas, and the neighbours' GRZ, GFZ and storeys on their parcels, each as a layer you can hide.
- **B-Plan on the aerial map:** The Site step loads the aerial map with parcels and data on its own. On a parcel under a B-Plan, "Overlay on map" imports the official plan PDF and opens the three-point alignment right there; the aligned plan is drawn over the aerial image as its own layer.
- **Editing in Design:** Drag a Staffelgeschoss as a whole within its building, and drag any edge of a selected outline to move that flank parallel to itself. The Staffel proposal now follows the Landesbauordnung: in Berlin just below ⅔ of the floor below (BauO Bln § 2 Abs. 12), so it does not count as a full storey; 75 % stays available where an approval allows it.
- **Design full window:** The Design step now fills the whole window like 3D location and the building model, with plan alignment as a drawer at the bottom; the detailed design check table moved to Result.
- **Heritage and Milieuschutz on the parcel map:** Monuments (Denkmale) and preservation areas (Milieuschutz and urban-character Erhaltungsgebiete) are map layers now, and every parcel lists a monument on it or next to it and the preservation areas it lies in, with "None found" when the lookup returned nothing.
- **Setback check:** Neighbouring garages and sheds (Nebengebäude, by ALKIS building function or under 3 m high) no longer count as setback conflicts, as § 6 (8) BauO Bln allows them in setback areas. Run the nearby-buildings lookup again to classify existing results.
- **§ 34 reference plots:** On the parcel map, add any neighbouring plot as a § 34 reference and remove it again; chosen plots are outlined. Each shows its built footprint, GRZ, GFZ and storeys, plus the measured building height with the storeys it implies. Where listed storeys disagree with the height, one click uses the height-based count and scales the plot's GFZ with it. The unreviewed GRZ, GFZ and storey limits follow the chosen plots, so Design measures against them; entered or reviewed values stay.
- **Staffelgeschoss:** Add a Staffelgeschoss from the building in Layers or the live preview. It is proposed as the footprint set back at least 1.5 m to at most ⅔ or 75 % of the floor below, adjustable in its details. It gets its own Abstandsfläche (0.4 H to its top, measured from its own walls) instead of raising the main walls' setback.
- **Design:** The live preview shows Grundfläche, GRZ and GFZ against their limits while you draw. Layers have a delete button per object (Delete/Backspace also removes the selection), and the layer list, inspector and live preview can be resized by dragging their edges. The step bar now stays attached under the project tabs while scrolling.
- **Parcel map:** Looking up parcels now also loads the surrounding buildings, so every parcel shows GRZ 1/GRZ 2, GFZ and its storeys straight away, and the § 34 comparison lists the storey range of the neighbours.
- **Feasibility:** Opens directly on the site assessment; the financial study is paused and no longer shown.
- **Design:** Double-click closes a footprint outline in the plan and in 3D. The footprint tool is now called "Draw building footprint", the building-line tool has its own line icon, and in 3D the selected building stands out while the others turn grey.
- **Baugrenze from the plan:** With a B-Plan page aligned on the parcel, one click traces the Baugrenze and Baulinien around the parcel as an unreviewed envelope and building lines, using the provider you choose. Drag the approximate corners onto the plan lines, then review.
- **Parcel map:** "Design on this parcel" adopts the selected parcel and opens it in Design. Adopting a parcel inside Design now also sets the parcel area.
- **3D editors and massing:** 3D location and the site assessment's Design step open as a top-down map: drag pans, scroll zooms to the cursor, and Ctrl/⌥ + drag tilts and turns. In Design, pick a parcel directly on the map, draw the footprint in the plan or in 3D, then set floors × floor height or drag the roof grip to extrude; BGF updates live. Abstandsflächen (0.4 H, min. 3 m) follow live in green, turning red where they cross the parcel boundary or overlap neighbouring buildings' areas.
- **Planning limits:** Reorganised into one consistent layout: planning basis and source documents first, then Figures, Building rules and Other checks with aligned value, source and status columns. Building form and height now group what the sources state, the rule used for the design and the check under one heading instead of spreading them over three tables.
- **Site assessment:** GRZ 2 (garages, parking and ancillary structures, § 19 (4) BauNVO) is an optional input, read from the B-Plan when stated and otherwise proposed as GRZ + 50 % up to 0.8. It limits the footprint only when below GRZ, and Result shows what it leaves for ancillary structures. § 35 outer area is a planning basis of its own: the site summary proposes it on open land and keeps the capacity hypothetical until the authority confirms permissibility.
- **Parcel map:** Neighbouring parcels show GRZ 1 (main buildings) and GRZ 2 (including garages, sheds and underground garages) next to GFZ, as a layer you can toggle. Each parcel is marked as B-Plan in force, plan in progress, likely § 34 or likely § 35, using the B-Plan register and the Berlin land-use plan; the site summary no longer assumes § 34 on open land.

- Workbench tools in Site assessment, 3D location and the building model show a tooltip with their name and shortcut on hover, including tools that are currently unavailable.
- **Site summary:** One click from the saved address to a complete, unreviewed site frame: official parcel, B-Plan or § 34, nearby references, GRZ/GFZ/storeys, building form, setback envelope, an exemption scenario and a first massing. For a covering B-Plan it imports the official plan PDF and reads its GRZ, GFZ, storeys and Bauweise with the provider you choose, citing the page; under § 34 it uses the neighbours. Building form is inferred from neighbours on the parcel boundaries when the plan does not state it. Reviewed and entered values are never replaced.
- **Parcel map:** The Site step shows parcels on the Berlin aerial image, labelled with number and observed GRZ/GFZ, with named B-Plan areas, nearby buildings, zoom and layer controls. Selecting a parcel shows its area, last change, whether a development plan is in force and the § 34 values of its neighbours.
- **Design and result:** Drag buildings or nudge them with the arrow keys, preview the exemption massing in 2D/3D, and compare the buildable floor area with and without exemption in Result. Study switch, steps, figures and Save now share one header row, so the editor is visible without scrolling.

- Add the site address when creating a project. Project details now supports confirmed project deletion, with protection while uploads or processing are active. Includes migration 0053 for reliable background file cleanup.

- **Site assessment** is reorganised into four steps (Site, Planning limits, Design, Result) with open-item counts, a header with the key figures, Save and Download report, and an open-items table that jumps to each fix. The geometry editor is now a full-width workbench like 3D location, with layers, a shortcut tool rail, undo/redo, a correctly fitted plan and a full 3D view. Review panels step through items with Previous/Next, explain why review is blocked and accept dates in the app's format. Parcel lookups show the real address error with a link to Project details. Clearer names for buildings, parcel edges and references, headed tables, and a limit comparison that highlights what actually limits the area. The financial study can adopt the parcel area and indicative GF from the saved site assessment.

- Project views: Coordinator and Planner overviews organize saved planning entries, dependencies, decisions and milestones by phase and discipline. Nerd keeps every module tab; both editors stay shared. Viewing a phase does not advance it or approve engineering work. Includes additive database migration 0052.

- Upload PDFs directly in the site assessment without changing tabs. Project sources retain the workflow context and propose document types from their content, with supporting evidence and an explicit unreviewed state.

- 3D location can locate a source-linked, approximate project extent when no placed model is available. Fit construction no longer mistakes the building at the address for the development; the outline links to its source plan and stays separate from surveyed or calculation geometry.

- **Berlin site assessment:** Review parcel and plan evidence, compare nearby buildings, edit buildable envelopes and massing in 2D/3D, and see which constraints limit the selected design. Keep exception scenarios separate and export source-linked assessments for preliminary authority discussions. Includes database migrations 0050 and 0051.

- Location imagery is saved server-side and reused across viewers and deployments, reducing requests to official map services. Aerial and rail-noise layers retain their last good image during provider outages or rate limits, without reusing images from another location. Includes database migration 0049.

- Corrected already-shipped acoustic updates to their verified release date. Production builds now reject undated release notes instead of publishing them as Unreleased.

- 3D location measurements float over the map without shifting the model. Save and reopen distances to any surface with an optional description and purpose; exterior-noise actions appear only after saving a road or railway purpose. Corner snapping can be switched off for free picking.

- 3D location now fills the project window and shares the building model's compact tool rail, visible shortcuts and narrow-window panels. Aerial imagery and rail-noise overlays stay visible when returning to the editor instead of turning into black rectangles.

- Project navigation stays pinned across dashboards, editors and other tabs, including on narrow screens. Only module content scrolls; Project details keeps its Edit button out of the tab row. Loading the project name, customer or status no longer shifts navigation.

- 3D location: **Fit construction** (Shift+F) brings the planned build back into view after zooming or panning. A teal outline and readable label keep it distinct from the surroundings. Sites without planning geometry highlight the existing footprint at the address instead, clearly labelled as reference geometry; otherwise the address remains marked. Selected reference buildings are outlined along their actual shape rather than an oversized box.

- Feasibility now compares scenarios in a compact summary with one input group at a time, clearer review status and validation, protected unsaved edits, and reports in the selected language. Click anywhere in a scenario row to switch scenarios; keyboard selection remains available. Zoning checks require a confirmed storey inventory and GFZ counting basis; Bebauungsplan suggestions retain height references and mandatory storey qualifiers. Site downloads are explicitly 2D, use interoperable GeoJSON and Unicode-safe DXF, and wait for location edits to be saved.

- **Feasibility**: a new project view compares keeping the building, densifying it or building new by residual land value, with sale or rental per scenario. Floor areas start from the approved GFZ and parcel area, cost standards are marked until reviewed, missing inputs are named, and **Download report** creates a PDF of the saved study for banks or investors. Includes database migration 0048.

- Building model: a **zoning check** compares GRZ, GFZ and Vollgeschosse with the approved Bebauungsplan limits once parcel area, Grundfläche and Geschossfläche per Vollgeschoss are entered and approved.

- 3D location: **Export site** downloads the surrounding buildings, trees, massing boxes and address point as DXF or GeoJSON in the official UTM grid, for CAD and GIS.

- Building model: **Read Bebauungsplan** now also proposes the Art und Maß der baulichen Nutzung from the plan's text (Baugebiet, GRZ, GFZ, Vollgeschosse, heights, Bauweise), each quoting its sentence and approved per value. Values drawn only in the Planzeichnung are not read.

- Exterior noise suggests the mapped roads and railways near the building, using class-based screening radii measured from the placed plan or the official footprint. Each suggestion can be added individually, or all at once. 3D location shows the same suggestions in a new Suggestions panel and highlights them on the map; later planning domains will add their own suggestions there.
- 3D location: when taking over a measurement, mapped roads and railways near the measured points are offered directly and the nearest is preselected; choosing one adds it as a noise source with the distance.

- Files Richtfest creates itself (environmental surveys and road/rail lookups, forwarded email and its attachments, public-data snapshots, generated PDFs) are now stored in production; previously these failed with "Direct bucket upload is required".

- 3D location: a finished measurement can be taken over as a road or railway's distance to facade in Exterior noise, for an existing source or a new one, with both measured points recorded as its basis.

- 3D location: official aerial imagery under the scene for Rheinland-Pfalz and Berlin sites, with a wider window loaded when zooming out; keyboard shortcuts for tools and views (V, G, M, H, A, T, 3, S, U, F, Esc), including a pan tool; measurements snap to building and plan corners, follow the pointer with a live distance and draw as bold lines with the value centred on them.

- 3D location shows mapped roads and railways and the federal rail noise map (EBA, Lden) as switchable layers, with a Surroundings view of 2 × 2 km. A floor plan can be placed on the site with two point pairs; facade distances to each road or railway are measured from it and can be taken over into Exterior noise with their basis.

- **Exterior noise**: a new project view lists the roads and railways around the site from official map data (now also for Hessen addresses, e.g. Frankfurt and Hanau) with class, route number and distance. Added sources collect traffic volume, speed, surface, train volumes and facade distance with their basis, and missing traffic data can be requested from the authority as an inquiry that tracks its answers.
- Inquiries: emails from classic Outlook (`.msg`) can be imported, and component data inquiries offer a **Follow-up** with only the items still open. Values the architect already sent are reviewed in Richtfest rather than asked again.

## 2026-10-17

- Building model: **Read noise requirements** reads a Bebauungsplan's text into the regulatory basis: Lärmpegelbereiche, maßgebliche Außenlärmpegel, required facade insulation, prescribed measures and the cited DIN 4109 edition, each quoted for review.
- Inquiries: **Import email (.eml)** fills an entry from an exported email and keeps the email and its attachments in Sources.
- Inquiries: each project gets a **forwarding address**, and each inquiry its own reply address. CC it on a request and replies are filed into the inquiry automatically; other mail waits in the project inbox to be filed or dismissed. Emails and attachments are kept in Sources. Requires the Resend receiving domain and webhook to be configured.
- Building model: **Read component data** proposes wall and ceiling construction, material, thickness and bulk density from the Baubeschreibung, quoting the source sentence.
- New **Inquiries** project view: each question to the architect, client or authority is a ticket that bundles the sent request with emails, call notes, documents and internal notes. The sound-insulation data request opens one directly, shows how many items are answered, and can read stated component values from a received reply as proposals for review.
- Sources show a **Document type** (plans, Baubeschreibung, Bebauungsplan, acoustic report, noise data, correspondence …), suggested from the file name and title page and confirmed with one click.

- Building model: **Sound insulation** starts with the project's regulatory basis: federal state, Bebauungsplan and its noise requirements, and the confirmed Landesbauordnung, VVTB and DIN 4109 editions.

- Building model: **Derive from plan** reads each storey's level from the plan title (for example "Grundriss 1. OG"), so ceilings know the storey above; levels can be corrected under **Sound insulation → Storeys**. **Color walls by role** fills the plan's walls by wall role with a legend.

- Building model: **Sound insulation** in the toolbar records the agreed requirement level, lists the walls and ceilings that need a sound insulation verification and whether their inputs are complete, and builds a data request per wall type that can be copied into an email to the architect. **Derive from plan** now also creates one ceiling per storey with its own component data. The calculation itself remains unavailable until a validated DIN 4109-2 tool exists.

- Building model walls, ceilings and rooms now carry shared component data (construction, material, thickness, bulk density, wall role, apartment, space type) with review per value. **Derive from plan** finds the rooms on both sides of each wall, detects facades, proposes apartment partition, corridor, stairwell, exterior or internal roles and measures wall thickness at the printed plan scale. Construction data can be copied to all walls of the same role and approved per wall type in one step, and agents see which sound-insulation inputs are still missing.

- Richtfest Docs gains a Sound insulation assessment page: the specialist workflow from requirement levels and regulatory hierarchy to exterior noise, and what Richtfest covers today.

- Building model plans zoom with a two-finger pinch on phones and tablets, and the project bar no longer overlaps on narrow phone screens.
- Building Model: planners can edit any room outline on the plan by dragging, adding and removing points, with the area updating live, or use **Magic select** to detect a room's outline with one click and then edit, confirm or name it as a new room. Every saved outline is logged as training data for plan detection. Existing plans are re-extracted automatically so magic select works on them. Includes database migration 0044.
- Building Model is now a workbench: one toolbar, an outliner of rooms by apartment with show/hide eyes, a tool rail (Select V, Magic select W, Edit points E, Pan H, Measure M), a sectioned properties panel with editable outline points in metres, and a status bar with Accept/Save on Enter. The plan can be panned at any zoom.
- Projects open without the workspace sidebar: a slim project bar keeps the project's views, and **← Projects** leads back to open another project.
- Building model plan parsing splits open-plan rooms (for example a living room and its hall) along straight wall-to-wall lines instead of jagged diagonal seams. Existing plans are re-extracted automatically.
- Building Model: an older plan set can be marked as superseded by a newer one. Its draft storeys, rooms and candidates leave the model and agent context without deleting the file, and it can be restored at any time. Includes database migration 0043.
- The Building Model plan view now draws each detected room as its actual outline instead of a rectangle around it, so L-shaped rooms, notches and door closures are visible where they were extracted.
- Building model plan parsing now reads plans whose walls, partitions and doors are drawn as outlines, as on the Bendenweg approval plans: outlined partitions bound rooms, door arcs drawn as many short lines are recognised so doorways close, and beds, kitchens and other furniture cut out of the floor fill count as room area instead of carving notches into rooms. Existing plans are re-extracted automatically.
- Building model plan parsing now handles doors and non-rectangular rooms. Openings between wall ends, including doors marked only by their swing arc, are closed so rooms no longer leak into each other or outdoors through windows. L-shaped rooms and corridors, curved walls and merged CAD wall fills are traced, and each room records which rooms its doors connect to (unreviewed). Room-label recognition covers more German names, and OCR labels show their source. Existing plans are re-extracted automatically whenever the parser improves, one page at a time while no new uploads are waiting; accepted and rejected candidates are kept. Plan parsing now runs in a background thread so large sheets no longer slow down the app.
- Building model processing fixes: deleting a plan PDF no longer fails; sections that mention a floor plan are no longer treated as floor plans; automatic processing applies only to newly uploaded project-evidence PDFs, with no backfill of older sources; repeatedly failing sources stop with a visible failed state; re-extracted geometry fences stale reviews; agent links open the linked object's own plan page; and agents see automatic draft storeys as unreviewed. Includes database migration 0042.

## 2026-10-16

- Visual crop follow-ups now retain typed, receipt-backed observations alongside earlier extraction without approving calculation inputs.

- Completed acoustic calculation runs can reassess a decision-free input review from saved extraction under the original remaining budget, without rerunning specialists or writing a report.

- Calculation and Report agents now message only agents in the current run family, keeping prior runs out of their discovery and inbox.

- Successive agent clarifications now retain earlier project decisions in order; explicit corrections affect conflicting facts without discarding unrelated constraints. Oversized accumulated guidance is rejected clearly rather than truncated.

- Acoustic agents use RLS-19 within the DIN 18005 planning workflow for road-noise assessment, reserve contour maps for aircraft research, and keep unavailable calculation inputs and other noise-source categories explicit.

- Projects can save source-backed environmental surveys with bounded official Rheinland-Pfalz road, rail, industry and aviation records. The survey preserves dated source receipts and Fraport layer metadata, and checks the site against published noise-contour extents. Flight paths and site-specific noise levels remain explicitly unresolved.

- Uploaded sources now retain reusable page models and PDF layer metadata. Agents can read compact source-backed blocks, while the document inspector shows page coverage, layer visibility and unresolved extraction limits. Existing project evidence can be prepared without AI calls; original files, reviews and reference exclusions remain intact.

- Acoustic extraction keeps large, sparse plan pages together and retains directly printed plan areas as receipt-bound, unreviewed observations; visual mappings and areas remain outside calculation inputs until explicitly approved by a person.

- Acoustic input review shows visual room candidates as partial, unreviewed observations linked to their exact source page and image-inspection receipt, with an on-demand source preview returned only when its rendered image hash still matches that receipt; candidates remain outside the calculation inventory.

- Project Sources now show each file’s purpose, making reference reports and test-only comparisons visibly distinct from agent evidence.

- Building model now opens the strongest identified floor-plan page instead of an arbitrary report cover, including for older automatically generated links. Projects with several PDFs provide an explicit source-PDF selector, and deliberate source or page choices remain fixed in shareable links.
- Building-model source PDFs now render through an authorized same-origin stream in production, avoiding private-bucket browser CORS failures while preserving signed redirects for explicit file downloads.
- Building-model plan overlays now preserve exact source geometry at every zoom. Labels, strokes and selection emphasis stay screen-sized, thin candidates keep a separate practical hit target, and selecting one candidate subdues unrelated overlays for source-plan review. Existing and Demolition views now disclose source-scoped hidden wall hypotheses and link directly to their Proposed-state review; the dedicated wall toggle and inspector keep PDF-relative geometry evidence distinct from unknown physical thickness and material. Technical source identifiers remain readable in narrow inspector layouts instead of collapsing into a one-character column. The review surface now opens directly into a plan-first workbench with compact source context, separate object and display-control tabs, independent panel scrolling and responsive canvas-first ordering.
- Automatic Building-model extraction now keeps construction, existing and demolition fills as separate evidence instead of merging them into one barrier map. Topology-v5 assigns rooms within apartment domains using printed-area capacity checks, recognizes Garderobe labels and closes only source-supported, doorway-sized gaps between collinear wall fragments for segmentation so room proposals do not escape through a portal. It also records conservative rectilinear shape-quality metrics and demotes severe tendrils or concavities instead of presenting them as spatial rooms, while retaining ordinary L-shaped rooms. Inferred closures and shape checks remain unreviewed evidence and never become wall, door or surveyed-boundary claims. Proposed wall and assembly candidates no longer appear in the Existing or Demolition views, construction assemblies start hidden, and automatic upgrades or explicit re-runs reuse the page's job while refreshing stale unreviewed geometry without changing accepted or rejected work. On reference page 2, 73 of 87 room labels receive spatial proposals across WE1–WE11 and 14 remain honest unresolved anchors. All results remain unreviewed; no physical scale, material, opening, continuity or completeness is claimed. Migration 0041 remains sufficient; no additional migration is required.

## 2026-10-15

- Project editors can now delete files from Resources or the document preview, with a confirmation covering every version. Deletion removes the stored files and extracted data, preserves conversations and reports, and records an audit event.

- Acoustic extraction keeps sparse plan drawings together with bounded, page-aware packets and stable source-backed room identities. Typed input choices and exact quotation recovery reduce avoidable retries without losing source text or accepting unsupported evidence; explicit numerical inputs remain available while other decisions await clarification.
- Blocked acoustic workflows assess independent progress once, ask focused questions and automatically save available room calculations as an unapproved partial sheet. Saving later answers advances the calculation without another extraction run or an extra Calculate action; unresolved rooms and engineering-release requirements remain visible.
- Agent replies now validate the recipient and original message before accepting a model response. Misaddressed replies get corrective feedback instead of stopping a calculation with a misleading project-access error; delivery permissions remain unchanged.
- Acoustic extraction now selects only source-version IDs supplied in its packet. Correction attempts distinguish invalid room references, duplicate rooms and non-verbatim quotations without exposing rejected source text or relaxing evidence checks.
- Combined calculation inputs now retain up to 1,000 room identifiers across source packets, while each extraction packet stays limited to 100. Missing inputs and unmatched room identities remain explicit rather than crashing aggregation or being silently merged.
- Agent cost displays now include known settled charges from interrupted calls without double counting later totals. Partial costs stay visibly incomplete; reservations are not charges.
- Calculation-sheet PDFs now include an ARC-inspired room overview and calculation details, plus a two-page numerical Prüfbericht highlighting blockers, shortfalls and low reserves. Sources, scenario notes and every declared room remain traceable; engineering rules and approval requirements are unchanged.

- Exterior-noise workflows now pause before further AI work when room calculations are blocked, including runs outside chat. Saved reasons distinguish incomplete inputs from calculated results below target; explicitly requested model-free sheets can still show unsupported-room outcomes.

- Acoustic extraction failures now retain safe field-level diagnostics for correction attempts, including larger room-fact packets and nested source references. Validation rules, models and spending/retry allowances remain unchanged; no run restarts automatically.

- Project chat now proposes the right outcome directly in the conversation instead of requiring a mode switch. Calculation sheets are distinct from full reports; unclear requests ask for a choice. Confirm the outcome and cost allowance before work starts, with saved proposals protected against duplicate starts.

- Added opt-in Jev image triage for new project-source uploads and agent questions. Revision-linked labels and suggested regions are reused without sending image pixels to the calling model; direct visual inspection, evidence checks and human review remain available and separate. Disabled by default, with no automatic backfill or database migration.

- Acoustic workflows now combine room data across documents and clarify missing or conflicting values directly in chat. Rounded choices, plain-language questions and expandable sources keep the form simple. Answers are saved with their history; confirmed inputs produce a draft calculation sheet without another AI call. New runs wait for missing inputs before report writing; existing checkpoints keep their behavior.

- Landing-page images, icons and share previews now load correctly on the main website as well as the preview URL.

- Agent activity now uses compact, expandable Trace rows in conversations and run threads. Current tasks, queued work and unreviewed findings stay readable, with timestamped history and failure details on demand. Agent execution, source links and approvals are unchanged.

- Project conversations can request a calculation-only Schallschutznachweis or select a full concept format. New exterior-noise workflows extract source-backed room inputs, automatically calculate every declared room, and save a result or blocker without optional agent arithmetic calls. Calculation sheets skip report writing and editorial passes; configured independent review and human release remain separate.
- Added an offline room-by-room exterior-noise reference comparison and deterministic room tables with calculation details. Missing inputs and conflicting evidence stay visible; matching a reference does not grant compliance approval. Existing runs keep their saved behavior; no paid run starts automatically.
- Approved room-input revisions can now serve as the basis for calculation scenarios. Planners adjust numeric inputs and save a new draft without AI calls or repeated source extraction; original inputs, change reasons, source versions and review boundaries remain traceable.

- Reports can use a separate writing model without changing their reviewers. Independent checks now distinguish omitted packet sections from missing chapters and no longer demand that assembled reports fit a single-response length limit. Existing runs keep their model settings; no paid run starts automatically.

- Astra report calls now cache shared context separately from changing writing packets, without reducing evidence or review checks. Patch editing no longer receives the unrelated component catalogue. Cache-write costs are included in new call estimates and reservations; actual savings depend on provider reuse. No paid run restarts automatically.

- Astra visual-review reservations now account for images without treating their encoded data and duplicate SDK metadata as report text. Evidence, image quality, models and review checks stay unchanged; numeric admission diagnostics explain future stops. This corrects reserved estimates, not past charges, and starts no paid run automatically.

## 2026-10-14

- Acoustic report editing now groups changes instead of rewriting unchanged prose, retaining saved work and independent checks for changed evidence. Edit recovery retains rejected wording alongside review feedback and rechecks changed repairs; editors distinguish missing visual receipts from contradictory evidence. Model calls reserve one actual step at a time, preserving earlier spend and cancellation safeguards without raising budgets, changing models or automatically restarting stopped runs.

- Acoustic reports now consolidate repeated fragments with a separate preservation check, retaining source associations and exact visual-inspection limits. Large unfinished narrative batches also use smaller, lossless writing packets; retries retain completed pieces without raising the spending cap. Source registers use a bounded inventory-writing contract for document dates, revisions and coverage limits, without repeating technical assessments or discarding source text. Assumption-only calculated results without source provenance stay out of report tables without changing the ledger; PDF export shares only byte-identical source files' matching pages with provenance cross-references. Start a fresh Report to apply prose changes to a completed report; existing drafts stay unchanged.

- Report “Save as PDF” downloads the selected revision directly, including its original attachments. PDFs now prepare in the background when reports are saved and are reused for fast downloads, with fresh approval/revision labels and source checks. Older reports prepare when opened; a first download may still wait. No new agent run is needed.

- Large acoustic reports now save and verify final edits in smaller pieces, subdividing unfinished edits instead of repeating requests that exceed the output limit. Retries reuse completed edits and all drafted sections; calculation appendices stay unchanged and no longer consume editing context. Editors receive the exact section format and specific repair feedback for incomplete output or missing references. Spending limits and timeouts are unchanged.

- Calculation appendices now render saved arithmetic directly, keeping exact inputs, results and review limits. Imported evidence uses smaller, saved writing packets and a lower output allowance; retries retain completed report pieces without raising spending limits or changing models.

- Restored the full automated test suite with current invitation, agent recovery and source-evidence expectations. Repeated API checks no longer offboard shared demo users or share authentication rate-limit counters; application behavior is unchanged.

- Parallel agent calls now wait for temporary spending reservations instead of failing, with exact waiting and stop reasons in activity and recovery previews. Unfinished report Open issues reuse saved specialist findings; outstanding visual checks remain explicit in the report without becoming unsupported section citations. Saved work and spending limits are preserved.

- Agent recovery now previews saved work and requires confirmation of additional spending from both the conversation and run details. Shared spend/retry guards and explicit interrupted-attempt records prevent silent replacement calls; source inspection reserves a final answer step, and report citation feedback avoids unnecessary retries without weakening evidence checks.

- Project chat now has a compact composer with attachments and optional effort/mode settings. Recommendations appear in the conversation and still require Apply then Send for Team or Report. Mobile chat puts threads, project sections, resources and workspace navigation into one hamburger menu, leaving room for the conversation. Agent execution is unchanged.

- Agent calls now stop waiting when their deadline expires or cancellation is requested, even if the provider stream stays open. Deferred visual reads are recorded and continued within the existing revision allowance without redoing completed findings; any remaining inspection gaps stay explicit instead of being called unreadable sources.

## 2026-10-13

- Reports now start from a goal and project evidence without requiring a template or attachments. File-purpose controls keep reference reports and comparison-only material out of agent evidence while preserving originals and human previews. Fresh Reports exclude earlier conversation answers and document-comment excerpts; existing reports remain unchanged.

- Affinity originals can now be linked to a confirmed full PDF export at exact revisions. Agents can select and cite that PDF without confusing it with a cover preview; new revisions never inherit links or approval. Stale historical attempt records were reconciled without deleting run history or inventing missing usage.

- Project agents can inspect exact source pages and crops, index documents in smaller batches, and draft independent report sections in parallel. Failed source processing can be recovered without re-uploading or changing versions, citations or reviews. Processing diagnostics and retry checkpoints preserve clear limits; visual observations remain unreviewed.

- Project agents now default to Suggest: Jev checks the mode on Send, with Chat as the safe fallback for search and questions. Team and Report recommendations require Apply and Send; explicit modes skip the check, and typing never triggers paid inference. Report creation requires a template and selected sources. Opted-in Jev knowledge ranking also works in direct Chat runs.

- Main and specialist chats now follow new output at the bottom, preserve your place while reading or selecting transcript text, and resume following with Latest. Unrelated text selections and keypresses no longer pause the chat.

- Failed agent calls now show the provider’s redacted reason, error code, parameter and request ID, including billing and schema failures. Saved run diagnostics and correlated server logs cover supervisor, direct and Jev calls without retaining raw errors or credentials. Fixed OpenAI rejecting the company-search tool schema; Unicode search-term validation remains enforced by the application.

- Project resource tabs now have comfortable horizontal padding in both Dense and Normal display modes. Workspace tabs keep a consistent font weight so switching tabs no longer shifts neighboring labels.

- Added opt-in TypeSafe Jev summary routing and supervised company-knowledge reranking, with safe fallbacks, explicit credential setup and tracked usage. Reviews and approvals remain unchanged; neither option promises lower total cost.

- Acoustic concepts now consolidate the assembled report and separately check that evidence is preserved before optional source review and publication. Progress shows both stages; retries retain saved edits and checks without changing calculation appendices or original attachments.

- Agents can discover company-knowledge categories, search within a folder or unfiled entries, and retain category, source and chapter labels alongside approved references. Search stays private and approval-aware without embeddings or extra AI search calls.

- Agent messages now explicitly support “no reply target” in strict provider responses, avoiding forced reply IDs for new messages while preserving reply validation and duplicate-delivery protection.

- Company knowledge now opens with a question bar and follow-up chat. Its compact library groups source and chapter beneath each title, keeps selection actions in a floating bar, and supports confirmed, audited bulk approval. A controlled organization pass can categorize the imported Baukosten training entries without changing their original content or approvals.

- Agent reviews now group evidence by model capacity instead of small file batches and avoid duplicate report input, reducing repeated work and cost. Retries preserve completed reviews and unresolved findings.

- Specialist agents can search company knowledge concurrently without blocking each other's searches. Search limits, approval checks and cancellation safeguards remain in place.

- Purely visual changes can deploy after verification without separate approval; functional and mixed changes still require an explicit deployment request.

- Project agents can search approved company knowledge on demand. Retrieved excerpts and entry references stay with their findings through report drafting and review, separate from project evidence; retries recheck approval and changed content.

- Project resource navigation is back at the top of the right sidebar, with tabs for Artifacts, Shared work, Agents and Sources. The left rail is dedicated to active and archived threads.

- Component catalog rows are clickable across all columns, with keyboard access and standard open-in-new-tab behavior.

- Archiving and restoring threads no longer keeps the action busy while the workspace refreshes after a successful save.

- Added a tenant-private Components catalog with four supplier-reference starter records, a compact side inspector, an import dialog, revision history and human catalog review. Full records pair private original supplier PDFs with source-linked facts and review, including exact-page citations and a Facts/Document switch on narrow screens. Explicit matching-PDF uploads preserve revision and review decisions. Agents use only current reviewed matches and retain source conditions and warnings; engineering approval and commercial-offer comparison remain separate.

- Company knowledge can be organized into categories and searched with natural-language questions. Answers include linked source excerpts and review badges; private search history is saved, and categories never change approval or agent assignments. AI search requires a configured provider.

- Shared work now uses compact task rows with expandable instructions, readable review statuses and a single header. Completed and cancelled tasks stay accessible without dominating the list.

- Chat scrollbars now blend into light and dark themes instead of showing a bright track in dark mode.

- Specialist agents now retry invalid source citations with targeted correction feedback while preserving completed work. Failed calls retain safe, inspectable diagnostic records, including rejected source identifiers, without saving raw provider errors or rejected text.

- Team administrators can create and edit workspace roles, choose their permissions and assign them to members or invitations. Changes apply to everyone with that role, with audit history and protection against removing the last administrator.

- Account settings no longer hide password setup when an older session needs renewed sign-in. Session management now shows a clear sign-in prompt, and authentication errors return usable messages instead of server errors.

- Sound-insulation agents can use five deterministic tools for sound levels, single-band sound reduction and room-based exterior-noise targets and façade screening. Results keep inputs, sources or assumptions, formulas and review status; incomplete or unsupported exterior-noise cases return a blocking reason rather than a number. These are reviewable calculations, not certified engineering verification.

- Company knowledge now has a searchable review screen with draft and approved filters, source caveats, direct links and explicit approval. Imported training knowledge stays unapproved until a permitted reviewer confirms it; agent assignments remain separate.

- Project agents can exchange questions and findings across threads in the same project. Messages appear in both chats with linked sender and recipient names, including late arrivals; delivery never interrupts or automatically restarts an agent.

- Specialist source reviews now use larger, model-aware batches and fill available parallel slots immediately instead of waiting for the slowest specialist. Retries preserve saved findings and historical batch layouts; output limits and review safeguards remain unchanged.

- Downloaded reports now carry Richtfest branding on generated pages, with clear revision and review status. Imported plans and calculation pages keep their original artwork and unverified-source labels. Existing reports can be downloaded again without rerunning the agent.

- Acoustic reports now use larger, model-aware source batches and parallel drafting instead of many tiny sequential requests. New outlines avoid duplicate page coverage, incomplete large batches fall back to smaller saved pieces, and retries preserve completed work. Output-token limits and review safeguards remain unchanged.

- Acoustic concept reports now treat section length as a writing target instead of failing on character counts. Complete text, tables and citations are preserved; Retry run resumes saved work after older character-limit failures. Token limits and review safeguards remain unchanged.

- Agent runs now retain structured intermediate results and tool receipts. Retry reuses saved work without duplicating drafts or questions; Run again starts fresh. Saved inputs, outputs and review links provide a foundation for future training datasets.

## 2026-10-12

- Acoustic reports assembled from saved sections can now exceed the per-response character limit without losing content. Retrying an older combined-report limit failure resumes saved work instead of starting over; model limits and review requirements stay unchanged.

- Added an opt-in public-data catalogue with scheduled Berlin building/tree imports, retained source evidence and version-pinned project context. Projects can inspect provenance and import health, then explicitly confirm adoption of newer releases. Failed refreshes preserve context, planning objects and notes.

- Short acknowledgements such as “thanks” or “danke” now stay in project chat without starting a new agent run or redirecting an active one. Follow-up requests and attached sources still trigger agent work.

- App updates now retain older frontend files so open tabs can load account security and other deferred screens without a forced reload. New releases verify file retention before accepting traffic; authentication load failures keep their underlying browser error available for diagnosis.

- Retrying a timed-out project agent now resumes saved specialist work, report sections and review progress instead of starting over. Existing failed runs can resume too; model settings and approval requirements stay unchanged.

- Acoustic concepts now enforce the requested template, read complete saved PDF evidence and write resumable sections. PDF exports include numbered contents and original plan/calculation pages as unverified sources. Token truncation and document-size limits stop incomplete reports and show distinct recovery guidance.

- Project threads now have their own artifact previews, tasks and run links. Open documents and PDFs directly from chat, and review generated documents with persistent passage highlights and revision-specific comments that carry into continuing agent work.

- Missing app files after an update now show a reload prompt instead of crashing the conversation. Unsent text stays accessible, Markdown remains readable as plain text, and reloading requires confirmation. Failed page loads also offer recovery within the app.

- Rate-limited project agents now wait for provider cooldowns across worker restarts, distinguish reported quota failures from throttling, and resume saved drafts, specialist work and independent-review progress when retried. Unclassified older 429 errors remain explicitly uncertain.

- Agent progress now names the sources and revisions being reviewed, shows batch progress and saved findings marked as unreviewed, and updates in place as specialists work. The full timestamped history and retry details stay available on expansion.

- Project agents can read text in PNG, JPEG, WebP and BMP images and use configured visual interpretation for text-free diagrams. Affinity Publisher files contribute embedded-preview evidence only, clearly distinguished from a full document; visual inferences remain unreviewed and full Publisher reading still requires a PDF export.

- Open tabs now show “New updates available” above the profile in the navigation rail when a different app build is available. Click to reload when ready; deployments no longer need a manual refresh to discover updates.

- Corrected release-note dates for shipped updates and made dated changelog sections a required deployment step.

- Agent runs in different threads now start independently when capacity is available, rather than waiting for an entire batch to finish. The existing three-run limit per worker remains in place.

- Projects now have an Analytics tab for exploring agent-run costs, including all subagents, with project-wide token and cost totals, usage by model, and average tokens per fully measured run. Partial or missing data is clearly marked, and older runs remain browsable.

- Agent usage recording now retries received token counts during error recovery if their first save fails, instead of treating an unsuccessful save as recorded. Historical or unreported usage remains explicitly unavailable.

- Added Innenlärm and Außenlärm concept draft formats based on the completed reference reports, with distinct sections, project details, tables and source-linked plan/calculation inventories. Existing acoustic reviews keep their default format. These are draft structures, not new calculations or replicas of the original page design; template uploads in agent settings remain planned.

- Agent model settings now expose summary, rationale and document character limits plus a per-call timeout for each effort preset. New runs use saved limits; existing runs keep their original settings. Timeout failures point to the setting instead of a generic connection error.

- The 3D location editor now supports Rheinland-Pfalz addresses, including Alzey, using official building footprints and heights. Scenes from a different address are preserved but hidden by default. Unavailable trees, terrain and LiDAR are clearly identified.

- Account settings offers a single recovery message with Reload app for unavailable sign-in code or Try again for failed security details. Failed passkey loads no longer appear as an empty list, and unavailable security actions stay disabled.

- Aligned agent model settings and optional specialist controls across screen sizes and density modes. Role settings now explain that blank instructions retain built-in behavior.

- Agent model settings use one compact role table with inline controls, stable rows for optional specialists, grouped execution limits and a direct connection-settings link. Enabling a specialist no longer inserts a form or shifts the page.

- Docs now builds its changelog directly from the shared release notes, avoiding a separate copy. Commit guidelines require release notes and affected documentation alongside each completed change.

- Added opt-in sound-insulation, construction-law and cost-options specialists with separate models and role guidance. Sound-insulation reviews use a consistent German/English document template with revision-linked room/component references in preview and PDF. Existing presets stay unchanged; engineering calculations and compliance approval remain unavailable.

- Project sources are processed once per revision and reused from saved text and structured, source-linked facts. IFC properties and declared quantities import without AI; documents use one bounded structuring pass when configured. Conflicting claims and human reviews remain separate, and agents reuse saved evidence instead of repeatedly investigating originals.

- Project details now offer searchable address selection with Geoapify, retaining the selected coordinates and source attribution. Manual entry remains available for missing addresses or unconfigured search; manual edits clear old search metadata without moving existing 3D scenes.

- Project specialists read large source sets in smaller, checkpointed batches without dropping extracted text. Evidence and synthesis calls have more time to finish; timeouts now stop unchanged retries and show specific guidance instead of suggesting a token increase or connection repair.

## 2026-10-10

- Added a full-width project 3D location editor using addresses saved in project details: official Berlin building/tree context, on-demand 2021 LiDAR where covered, versioned IFC overlays, editable vehicle envelopes, massing and planning notes. Address changes never move existing scenes. Architectural lighting, shadows and clearer materials improve depth. Switch trees between schematic markers and illustrative foliage; measurements use schematic trees. Survey, alignment and illustrative-geometry limits stay explicit; this is not fire-access certification. Conversation and other app pages now use the full available width.

- Project threads use a first-message title if AI naming is unavailable, and older numbered threads recover their titles when reopened. Manual names are preserved.

- Keep the mobile app at 100% scale with page-zoom gestures disabled and touch scrolling preserved; use readable 16px form text on mobile to avoid focus-triggered zoom, and fix sign-in content overflowing narrow screens.

- Added an opt-in local demo project with PDF sources, concept revisions and agent failure scenarios for portal testing; repeat seeding preserves edits and settings without live model calls.

- Project agents produce a separate formatted draft document with named source versions and readable Unicode PDFs. Chat explains character-limit versus token-limit failures; confirmed token truncation offers Yes / No / Describe, with an administrator-approved increase for new runs only. Automatic retries now tell the agent which output rules failed and ask it to shorten overlong summaries rather than repeating the same request unchanged.

- Project agents read PDFs beyond page ten, with German/English OCR for scanned pages, original page references and explicit extraction limits. Failed provider attempts retain safe diagnostic details and reported token usage for troubleshooting.

- Project agent runs record per-call settings, retries and reported usage, including failures without usage. Human reviews can optionally score the original generated outcome and rework needed, with notes retained for approval and rejection; scores do not approve artifacts or validate engineering results.

- Subagents now show their own token usage and estimated cost in run lists and details, while the supervisor keeps the combined total. Previously recorded costs remain unchanged.

- Removed the redundant outer circle around callout icons.

- Added reusable orb setup with the pinned toolchain, cached dependencies, local test database, PDF/OCR tools and supervised development services.

- Serve the public landing page on `richtfest.ai` while preserving existing domain aliases; use `app.richtfest.ai` for the app.

- Project agent runs retry temporary provider failures and invalid responses, including truncated and schema-invalid Mastra responses, with up to three attempts instead of treating them as connection failures. Failed runs show a clear outcome with run details and a retry action. Completed reviews now include a downloadable PDF attachment in the conversation for the exact saved artifact revision.

- Project conversations render assistant Markdown with readable headings, lists, tables and code while keeping user messages literal.

- Omit unset conversation message IDs from read-state saves, and save reading positions only for persisted messages, preventing composer draft-save errors on empty threads and temporary agent-run rows.

- Specialist source reviews now receive citation IDs only for readable source text, while unreadable assigned files remain visible as coverage gaps.

- Added Help & feedback in navigation: just type to ask about Richtfest, request a feature or report a bug, with OpenUI answers, reviewed submissions, and a workspace-scoped JSON queue that Amp can retrieve after sign-in.

- Recheck server messages whenever a project conversation is reopened, so newly saved agent answers do not stay hidden behind a fresh client cache.

- Invite users with their name; pending invitations show each person’s name and email.

- Serve the public Richtfest landing page from the Railway service, with a preview URL while the custom domain is being activated.

- Project agent failures and cancellations now show recorded reasons in run details and sub-agent lists, including why child runs stopped when their supervisor failed. Older runs with only a generic error are labeled as having no specific recorded reason.

- Start a project chat thread by writing and sending the first message in the workspace.

- Supervisor workers now advance queued project runs through persisted Mastra workflow checkpoints provisioned by the standard application migration; worker startup, polling failures and per-run execution failures are visible in API logs with run context.
- Project status is selected from translated Planning, Active and Completed options.
- Project agent conversations distinguish queued runs from active work while keeping the crane visible in a waiting pose; running work shows live activity, source and specialist links, and a shimmering current-task line.
- Project run details distinguish worker queue wait, supervisor phase and provider-call duration while work is active.
- While a project agent run is active, the empty composer send control becomes Stop; typing a message restores Send.
- Project message action links now share the same hover treatment as adjacent buttons.
- Project chat steers only queued or running agent work; messages after a run finishes start a fresh run.
- Copy your own project chat messages with a compact button.
- Project details now edit inline on the page, with Save and Cancel actions.
- Split Settings into navigable sections for AI connections, agent model settings, agents and account settings.
- Agent model settings accept output caps up to GPT-6's 128,000-token output limit.
- Project agent work groups active and done runs, shows live runtime and per-agent token usage, and estimates cost where model pricing is known.
- Project thread hover highlights now span the row behind rename and archive actions.
- Local development can sign in with seeded test identities when the non-production `ALLOW_DEV_AUTH` flag is enabled.
- Agent model presets can opt into a separate independent source review before a draft is saved; it remains off by default.

- Project agents now assign source reviews for file-based work and distinguish readable unreviewed sources from findings awaiting human review.

- Added a Docs changelog page with the current release history in the Docs sidebar.

- Moved “Back to projects” into the app header while viewing a project.

- Project details can now be edited, including the name, customer and status; the status badge sits beside the project title.

- Project threads show a small accent dot for unread messages and clear it after you reach the latest message.

- Added an animated crane below the latest chat response to show when project agents are working.

- Users can rename project threads manually from the thread list.

- Project threads receive a concise model-generated title after their first message, using the active provider's economical model.
- Added Agent controls for workspace role instructions, routing hints and approved company knowledge; each supervisor run keeps the guidance it started with.

- Project workspace can show an embedded visual preview for Affinity Publisher files while keeping the original download available.

- Project agents can discover the latest ready source files from a bounded project inventory and review exact versions without requiring them to be attached first.

- Kept the project message send button in place while the draft save status changes.

- Send project workspace messages with Enter; use Shift+Enter for a new line.

- Changed saved agent model settings confirmation to a compact neutral status badge.

- Clarified saved AI credentials in Settings with a masked key placeholder and a quieter saved status.

- Added editable customer company/contact details, addresses and separate billing details, including invoice email, tax IDs, payment terms and one-click address copying. Existing customers can keep these fields empty.

- Project chat now clearly warns when agent replies are unavailable, confirms that sent messages were saved, and links to AI connection settings.

- Added provider-backed model selectors to agent model settings, with GPT 6 and Claude Opus 5.5 / Sonnet 5.5 models surfaced first.

- Refresh now shows workspace navigation immediately instead of a full-screen loading splash; protected content waits for session verification, and connection failures offer retry without losing the shell.

- Added branded social link previews with a construction illustration, clear title and description; private project details stay out of shared previews.

- Added safe first-administrator provisioning for a new production workspace and corrected the sign-in email-delivery status for configured Resend accounts.

- Refreshed sign-in emails with Richtfest branding, a clear sign-in button and plain-text fallback. Sign-in now offers a reload action when an old tab cannot load its code after deployment.

- Reduced the deployment image size and separated the typecheck, web and docs build stages for parallel builds and better caching. A pinned mirror of the same Bun image avoids Docker Hub rate limits. Production routing now uses the same port as the API.

- Defined the Railway project in code (`.railway/railway.ts`): one `richtfest-monorepo` service built from the Dockerfile, Postgres and the private file bucket in EU West. This replaces the deprecated `railway.json` and avoids Railway's per-package monorepo import. The production image now installs dependencies the same way as local development, which fixes the failing web typecheck in the Docker build.

- Project sources support selecting and uploading multiple files in one action, with per-file progress and failure results; browser uploads use a private bucket policy scoped to the app origin.

- Added a saved light and dark appearance preference in Account settings.

- Refined the overview metrics, project table sorting controls, and passive empty states for a calmer dashboard.

- Replaced the project conversation selector with a thread rail, including durable archive and restore actions that preserve messages and agent work.

- Added Vercel AI Gateway credentials and workspace provider selection in Settings; project agent controls now use the selected provider and expose only effort controls.

- Moved language and density preferences into Account settings, removed duplicate shell controls, and made the sidebar profile open account settings.

- Made email-link sign-in the primary login workflow, with password and explicit passkey actions as secondary fallbacks and lifecycle-safe browser passkey autofill.

- Simplified project chat with a quieter composer, circular send control, on-demand search, contextual message actions and no repeated agent labels. Jump to latest now disappears at the bottom. Supervisor results include saved artifact previews that open the exact revision for review. Subagents appear as named status rows that open focused threads for their assignments and results. Shared work uses compact conversation and agent lists, with clear links and details on demand.

- Added an opt-in Mastra supervisor for project chats: durable specialist assignments, restart recovery, follow-up steering, cancellation and human review. Workspace admins configure model presets; users choose effort through existing Richtfest controls. Added the runtime architecture diagram and setup guide to Docs.
- Added the chat-first project workspace with durable conversations and reader position, exact document revisions and annotations, streamed provider runs, visible source-review delegation, and an explicit review action that publishes the exact artifact revision as a source-linked reviewed finding. Generated OpenUI is restricted to the registered Richtfest component library, while engineering calculations remain unavailable until a validated deterministic tool exists.
- Applied the approved shadcn/ui `b6F9Mslb0` preset across the workspace, with neutral surfaces, indigo actions, Inter typography, Lucide icons, and reusable dense/normal controls; language and density preferences persist per user.
- Added the persisted project-onboarding workflow: customers, projects, direct file attachment and download, shared conversations and tasks, source-linked knowledge review, and tenant-scoped activity history.
- Added invite-only accounts with magic-link entry, password and passkey enrollment, secure sessions, role management, offboarding, and a development-only email outbox when Resend is not configured.
- Added encrypted personal and workspace AI connection settings with an explicit provider choice and an honest unavailable-execution state.
- Added Fumadocs documentation behind sign-in and Railway-ready packaging for Postgres, private Bucket direct uploads, and local backup/recovery checks.
- Extracted the 24-file local reference project into a reproducible page-level evidence set, retaining duplicate, bundle, and unsupported-format findings without uploading source material.
