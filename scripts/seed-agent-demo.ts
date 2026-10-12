import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { env } from "../richtfest-os/apps/api/src/env";
import { memberships, tenants, users } from "../richtfest-os/apps/api/src/db/schema";
import { projectsDeps } from "../richtfest-os/apps/api/src/app-hosts";
import { resolveAgentPreset } from "../richtfest-os/apps/api/src/agent-presets";
import { recordAudit } from "../richtfest-os/apps/api/src/audit";
import { projects, files, fileVersions, sourceExtractions, sourceModels } from "../richtfest-apps/projects/src/schema";
import { conversations, messages, artifacts, artifactRevisions, agentRuns,
  agentRunEvents, agentRunAttempts, supervisorRuns } from "../richtfest-apps/knowledge/src/schema";
import { artifactPdf } from "../richtfest-apps/knowledge/src/artifact-pdf";
import { formatRunFailureReason } from "../richtfest-apps/knowledge/src/run-reasons";

// This command deliberately has no production override or reset mode.
const database = new URL(env.DATABASE_URL);
if (env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname)
  || database.searchParams.has("host") || process.env.PGHOSTADDR)
  throw new Error("Demo seed requires a loopback development database without host overrides.");
if (env.BUCKET || env.ENDPOINT)
  throw new Error("Demo seed requires local file storage, not a bucket.");

// Reuse the existing identity seed only after the local-only checks.
const identities = Bun.spawnSync(["bun", "run", "db:seed"], { stdout: "inherit", stderr: "inherit" });
if (identities.exitCode !== 0) throw new Error("Development identity seed failed.");

const { db, pool } = createDatabase(env.DATABASE_URL);
try {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.name, "Alpha"));
  const [actor] = await db.select().from(users).where(eq(users.email, "andreas@richtfest.local"));
  if (!tenant || !actor || !(await db.select().from(memberships).where(and(
    eq(memberships.tenantId, tenant.id), eq(memberships.userId, actor.id),
  ))).length) throw new Error("Seeded Alpha administrator is missing.");
  const tenantId = tenant.id, actorId = actor.id;
  const id = (label: string) => {
    const hex = createHash("sha256").update(`${tenantId}:agent-demo-v1:${label}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  const projectId = id("project");
  const storage = projectsDeps(db, { actor: { id: actorId, tenantId, permissions: new Set() } } as unknown as Parameters<typeof projectsDeps>[1]).fileStorage;
  if (storage.kind !== "local") throw new Error("Demo seed requires the local storage adapter.");
  // Match the existing preset so Yes can exercise the real guarded PATCH. Never overwrite settings.
  const policy = await resolveAgentPreset(db, tenantId, "medium", "openai");
  const createdAt = new Date("2026-01-12T09:00:00Z");
  const at = (minutes: number) => new Date(createdAt.getTime() + minutes * 60_000);
  const sourceVersions = [
    { key: "brief-v1", file: "brief", name: "Projektbrief Lindenhof.pdf", version: 1,
      content: "# Projektbrief – ursprünglicher Stand\n\n**Fiktive Testdaten. Nicht zur Planung verwenden.**\n\nWohnhaus Lindenhof, acht Wohnungen, zwei Obergeschosse. Der Hof soll barrierearm erreichbar sein.\n\n## Offene Punkte\n\n- Lageplan und amtliche Grundstücksdaten fehlen.\n- Brandschutz und Schallschutz müssen fachlich geprüft werden.\n- Keine freigegebenen Maße oder Berechnungen vorhanden." },
    { key: "brief-v2", file: "brief", name: "Projektbrief Lindenhof.pdf", version: 2,
      content: "# Projektbrief – überarbeiteter Stand\n\n**Fiktive Testdaten. Nicht zur Planung verwenden.**\n\nWohnhaus Lindenhof, sechs statt acht Wohnungen, zwei Obergeschosse. Der Hof soll barrierearm erreichbar sein.\n\n## Änderung gegenüber Version 1\n\nDie Anzahl der Wohnungen wurde von acht auf sechs geändert. Die frühere Fassung bleibt als Quelle erhalten.\n\n## Offene Punkte\n\nGrundstücksdaten, Bauteilmaße und die fachliche Prüfung sind weiterhin offen." },
    { key: "components-v1", file: "components", name: "Bauteilübersicht – Müller.pdf", version: 1,
      content: "# Bauteilübersicht\n\n**Fiktive Testdaten. Keine geprüften Bauteile oder Bemessungswerte.**\n\n| Bauteil | Vorschlag | Nachweis |\n| --- | --- | --- |\n| Außenwand | Aufbau mit Fachplaner festlegen | Offen |\n| Wohnungstrenndecke | Anschlüsse und Flanken prüfen | Offen |\n| Türen | Anforderungen nach Nutzung bestimmen | Offen |\n\n## Zeichensatzprüfung\n\nÄ, Ö, Ü, ß – R′w ≥ 53 dB; L′n,w ≤ 46 dB. Diese Zahlen dienen ausschließlich dem PDF-Rendering-Test, nicht als Projektanforderung." },
  ];
  const storedSources: Array<(typeof sourceVersions)[number] & { storageKey: string; sizeBytes: number; checksum: string }> = [];
  for (const source of sourceVersions) {
    const storageKey = `${tenantId}/${projectId}/${id(source.file)}/${id(source.key)}`;
    let stored = await storage.head(storageKey);
    if (!stored) {
      const pdf = await artifactPdf({ title: source.name, content: source.content, version: source.version,
        projectId, sources: [], sourceVersionIds: [], status: "Synthetic demo / Not approved" });
      stored = await storage.saveStream(storageKey, Readable.from([pdf]), "application/pdf");
    }
    storedSources.push({ ...source, storageKey, ...stored });
  }
  const concept = (version: number) => `# Planungskonzept Lindenhof

> Fiktiver Demonstrationsentwurf. Keine technische Freigabe oder validierte Berechnung.

## 1. Ziel und Grundlagen

Ein kompakter Entwurf für ${version === 1 ? "acht" : "sechs"} Wohnungen mit gut nutzbaren gemeinschaftlichen Außenflächen. Grundlage: [${id(`brief-v${version}`)}].

## 2. Vorgeschlagene Maßnahmen

| Bereich | Vorschlag | Nächste Entscheidung |
| --- | --- | --- |
| Nutzung | ${version === 1 ? "Acht" : "Sechs"} Wohnungen vorsehen | Raumprogramm bestätigen |
| Erschließung | Barrierearmen Zugang zum Hof prüfen | Höhen und Wege vermessen |
| Außenwand | Aufbau und Anschlüsse abstimmen | Fachplaner einbinden |
| Wohnungstrenndecke | Flankenübertragung berücksichtigen | Nachweis beauftragen |

Die Bauteilübersicht benennt offene Prüfungen, keine freigegebenen Konstruktionen [${id("components-v1")}].

## 3. Versionskonflikt

${version === 1 ? "Dieser Entwurf verwendet den ursprünglichen Projektbrief (acht Wohnungen). Die neuere Quelle muss vor einer Freigabe abgeglichen werden." : "Der überarbeitete Projektbrief nennt sechs statt acht Wohnungen. Dieser Entwurf verwendet Version 2; Version 1 bleibt nachvollziehbar."}

## 4. Offene Punkte und Freigabe

- Grundstück, Ausrichtung und Abmessungen anhand der Originalunterlagen prüfen.
- Brand-, Schall- und Wärmeschutz durch die zuständigen Fachplaner bearbeiten lassen.
- Annahmen und Raumprogramm mit der Bauherrschaft bestätigen.
- Erst nach Prüfung als freigegebenen Wissensstand übernehmen.

**Entscheidung:** Als Gesprächsgrundlage prüfen, nicht zur Ausführung freigeben.`;

  await db.transaction(async tx => {
    const inserted = await tx.insert(projects).values({ id: projectId, tenantId, name: "DEMO · Wohnhaus Lindenhof", createdBy: actorId, createdAt }).onConflictDoNothing().returning();
    for (const source of storedSources) {
      await tx.insert(files).values({ id: id(source.file), tenantId, projectId, name: source.name, sourceType: "upload", createdBy: actorId, createdAt }).onConflictDoNothing();
      await tx.insert(fileVersions).values({ id: id(source.key), tenantId, fileId: id(source.file), version: source.version,
        status: "ready", storageKey: source.storageKey, sizeBytes: source.sizeBytes, checksum: source.checksum,
        mimeType: "application/pdf", sourceMetadata: { synthetic: true, fixture: "agent-demo-v1" }, createdBy: actorId, createdAt }).onConflictDoNothing();
      await tx.insert(sourceExtractions).values({ versionId: id(source.key), tenantId }).onConflictDoNothing();
      await tx.insert(sourceModels).values({ versionId: id(source.key), tenantId }).onConflictDoNothing();
    }
    for (const [key, title] of [["concept", "01 · Konzept und Quellen"], ["tokens", "02 · Tokenlimit – Entscheidung testen"], ["characters", "03 · Zeichenlimit – kein Tokenproblem"]]) {
      await tx.insert(conversations).values({ id: id(key), tenantId, projectId, title, createdBy: actorId, createdAt }).onConflictDoNothing();
      await tx.insert(messages).values({ id: id(`${key}-intro`), tenantId, conversationId: id(key), authorId: actorId,
        body: key === "concept" ? "Demo: Bitte erstelle ein prüfbares Planungskonzept aus den fiktiven PDF-Quellen. Öffne den Anhang und vergleiche Revision 1 und 2 sowie die Quellversionen."
          : key === "tokens" ? "Demo: Dieser gespeicherte Fehler simuliert ein Tokenlimit beim Quellenprüfer. Teste Ja, Nein oder Beschreiben. Ja ändert nur die lokale OpenAI/Mittel-Vorgabe; kein Lauf wird gestartet."
          : "Demo: Die Zusammenfassung überschreitet 10.000 Zeichen. Das ist kein Tokenlimit. Hier soll keine Erhöhung der Tokens angeboten werden.",
        createdAt }).onConflictDoNothing();
    }
    for (const version of [1, 2]) {
      await tx.insert(artifacts).values({ id: id("artifact"), tenantId, projectId, title: "Planungskonzept Lindenhof · Demo", type: "draft", createdBy: actorId, runId: id("completed-run"), createdAt: at(2) }).onConflictDoNothing();
      await tx.insert(artifactRevisions).values({ id: id(`revision-${version}`), tenantId, artifactId: id("artifact"), version,
        title: "Planungskonzept Lindenhof · Demo", content: concept(version), sourceVersionIds: [id(`brief-v${version}`), id("components-v1")],
        createdBy: actorId, createdAt: at(version + 1) }).onConflictDoNothing();
    }
    const summary = "Der fiktive Konzeptentwurf ist bereit zur Prüfung: gegliederte Maßnahmen, offene Entscheidungen und benannte Quellen. Der erste Anhang zeigt die historische Revision 1; die neuere Revision 2 berücksichtigt sechs statt acht Wohnungen. Keine fachliche Freigabe.";
    await tx.insert(agentRuns).values({ id: id("completed-run"), tenantId, projectId, conversationId: id("concept"), messageId: id("concept-intro"),
      goal: "Demo: Planungskonzept aus fiktiven Quellen erstellen", provider: "openai", modelPolicy: policy, status: "needs_review",
      outputSummary: summary, requestedBy: actorId, correlationId: id("completed-correlation"), createdAt, startedAt: at(1), finishedAt: at(3) }).onConflictDoNothing();
    await tx.insert(supervisorRuns).values({ runId: id("completed-run"), tenantId, phase: "done", modelPolicy: policy,
      review: { result: { artifactId: id("artifact"), revisionId: id("revision-1"), generation: 0 } } }).onConflictDoNothing();
    for (const version of [1, 2]) await tx.insert(messages).values({ id: id(`concept-result-${version}`), tenantId, conversationId: id("concept"), authorId: actorId,
      actorKind: "agent", body: version === 1 ? summary : "Überarbeiteter Demo-Entwurf: sechs Wohnungen gemäß Projektbrief v2. Bitte Quellen und offene Punkte vor einer Freigabe prüfen.",
      openui: `root = ArtifactPdf(${JSON.stringify(id("artifact"))}, ${JSON.stringify(id(`revision-${version}`))})`,
      sourceVersionIds: [id(`brief-v${version}`), id("components-v1")], runId: version === 1 ? id("completed-run") : null, createdAt: at(version + 1) }).onConflictDoNothing();
    for (const key of ["tokens", "characters"]) {
      const parentId = id(`${key}-run`), childId = id(`${key}-child`), callId = id(`${key}-call`);
      const error = formatRunFailureReason("specialist", "validation");
      const diagnostics = key === "tokens" ? { errorId: "STRUCTURED_OUTPUT_TRUNCATED", finishReason: "length" }
        : { errorId: "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED", finishReason: "stop", issues: [{ code: "too_big", path: ["summary"], maximum: 10000 }] };
      for (const runId of [parentId, childId]) await tx.insert(agentRuns).values({ id: runId, tenantId, projectId, conversationId: id(key),
        messageId: runId === parentId ? id(`${key}-intro`) : null, parentRunId: runId === childId ? parentId : null,
        specialistRole: runId === childId ? "source_reviewer" : null, sourceVersionIds: [id("brief-v2"), id("components-v1")],
        goal: `Demo: ${key === "tokens" ? "Tokenlimit" : "Zeichenlimit"} beim Quellenreview`, provider: "openai", modelPolicy: policy,
        status: "failed", error, requestedBy: actorId, correlationId: id(`${key}-correlation`), createdAt, startedAt: at(1), finishedAt: at(5) }).onConflictDoNothing();
      await tx.insert(supervisorRuns).values({ runId: parentId, tenantId, phase: "failed", modelPolicy: policy }).onConflictDoNothing();
      for (const attempt of [1, 2, 3]) {
        await tx.insert(agentRunAttempts).values({ id: id(`${key}-attempt-${attempt}`), tenantId, runId: childId, operationId: callId,
          phase: "specialist", generation: 0, attemptNumber: attempt, provider: "openai", status: "failed", failureCategory: "validation", usageStatus: "missing",
          settings: { ...policy.specialists.source_reviewer, synthetic: true }, response: { finishReason: diagnostics.finishReason }, startedAt: at(attempt), completedAt: at(attempt + 1) }).onConflictDoNothing();
        await tx.insert(agentRunEvents).values({ id: id(`${key}-event-${attempt}`), tenantId, runId: parentId,
          eventType: attempt === 3 ? "provider_call_failed" : "provider_call_retrying", resultSummary: "specialist",
          paramsSummary: JSON.stringify({ runId: childId, callId, attempt, diagnostics }), createdBy: actorId, createdAt: at(attempt + 1) }).onConflictDoNothing();
      }
    }
    if (inserted.length) await recordAudit(tx, actorId, tenantId, "development.demo_seeded", "project", projectId, { fixture: "agent-demo-v1", synthetic: true }, { actorType: "system" });
  });
  console.log("Seeded DEMO · Wohnhaus Lindenhof. Re-running preserves edits and preset settings. No provider calls were made.");
  for (const key of ["concept", "tokens", "characters"])
    console.log(`${key}: /projects/${projectId}?conversation=${id(key)}&panel=${key === "concept" ? "artifacts" : "runs"}`);
  console.log(`Local files: ${env.FILE_STORAGE_PATH}`);
} finally {
  await pool.end();
}
