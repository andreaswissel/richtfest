# Building model and future site context

Status: future integration boundary for the shared project model. This note records direction only; it does not define validated acoustic calculation rules.

## Connected model

The overall project model includes both the building and its site context. Building Model and Site Context are separate views over connected project records, and project chat reads and proposes changes against those same records rather than maintaining a parallel interpretation.

The existing Location view and public-data infrastructure remain the foundation for site context. Building position, orientation and local plan coordinates may connect the two views with an explicit unknown, approximate or reviewed status; ordinary plan work must not require georeferencing.

## Future investigation workflow

A planner may investigate and review:

- nearby roads and their classifications;
- rail infrastructure;
- airport noise or noise-map coverage;
- other relevant environmental sources; and
- the distance and spatial relationship from each source to a particular facade.

Store source geometry and source records separately from discipline-specific assessed inputs and results. Every item needs its evidence date, source revision, review state, coordinate-alignment status and measurement method. A road category and a distance are context, not sufficient evidence for a computed decibel value.

Where it is cheap and coherent, the shared model may accept manually entered, evidence-linked and explicitly reviewed context references. Those references should use stable project and building-element identities so a facade can later participate in acoustic, fire, thermal or cost workflows without copying its identity into a second store.

## Deferred work

The current Building Model V1 does not expand into automatic environmental assessment. Defer:

- automatic road, rail, airport and other source discovery;
- traffic-volume and traffic-composition evidence ingestion;
- noise-map ingestion and coverage reconciliation;
- validated acoustic propagation and assessment methods; and
- broader geographic data-provider coverage.

These capabilities must arrive as reviewed, source-linked extensions of the existing Location and public-data workflows. Deterministic calculations require a separately validated method and typed inputs; meeting notes, inferred map categories and visual distances are not calculation authority.
