# Bendenweg: Normenbeschaffung für die Außenlärmberechnung

Stand: 15. Oktober 2026. Status: Beschaffung offen; kein freigegebener Rechenkern.

## Festgelegtes Vorgehen

Der Fachplaner hat für dieses Vorhaben DIN 18005 und RLS-19 als Grundlage der Straßenlärmermittlung benannt. Lärmkartierungen werden im vereinbarten Workflow nur für Fluglärm verwendet. Vorhandene Straßenlärmkarten bleiben als Originalquellen erhalten, ersetzen jedoch keine RLS-19-Berechnung. Straßen-Beurteilungspegel und maßgeblicher Außenlärmpegel La für den Fassadennachweis sind getrennte Größen; ihre Überführung benötigt eine belegte fachliche Grundlage.

## Prüfung des vorhandenen Firmenwissens

Geprüft wurde der für die lokale Bendenweg-Verifikation verwendete, bereinigte Produktionssnapshot, nicht der aktuelle Livebestand: 270 freigegebene Firmenwissenseinträge. Die Suche in Titel und Inhalt nach DIN 18005, RLS-19 und dem ausgeschriebenen Richtlinientitel ergab zwei Schulungsuntertitel:

- `f8e5279a-2ddf-4396-8517-5248ec263af8`: „Schallschutz · ARCenergie · 05.003 · RECHT/NORM | Richtlinien für den Lärmschutz an Straßen - RLS 19“.
- `3cb51b35-6cb4-429f-93dc-a1d77da8bca8`: „Schallschutz · ARCenergie · 03.036 · Zusammenrechnung der einzelnen Außenlärm Quellen“.

Beide enthalten Unterrichtstranskripte, keine normativen Volltexte; ihre strukturierten `source_refs` sind leer. Die Texte selbst warnen vor ungeprüften Untertiteln und ersetzen trotz des Datenbankstatus „approved“ keine fachlich geprüfte Normgrundlage. Der RLS-Beitrag beschreibt außerdem ein damaliges Programm mit RLS-90-Unterstützung; daraus folgt keine verfügbare oder validierte RLS-19-Integration. Ältere Schulungsaussagen zur Verwendung von Straßenlärmkarten überschreiben die aktuelle Entscheidung des Fachplaners nicht.

Eine Dateinamensuche nach 18005/RLS in den bereitgestellten Ordnern `reference-project` und `Baukostenoptimierer_Trainingspaket` ergab keine entsprechenden Volltexte. Das ist keine vollständige Inhaltsprüfung aller Dokumente. Fertige Referenznachweise und akustisch markierte Pläne wurden nicht zur Herleitung von Berechnungsregeln verwendet.

## Zu beschaffen oder nachzuweisen

| Grundlage | Benötigter Umfang | Bezugsquelle / Status |
| --- | --- | --- |
| DIN 18005 | Nutzbarer vollständiger Text der einschlägigen Ausgabe; projektspezifische Anwendbarkeit und erforderliche Beiblätter klären | [DIN 18005:2023-07 bei DIN Media](https://www.dinmedia.de/de/norm/din-18005/363829655); Volltext im geprüften Bestand nicht gefunden |
| RLS-19 | Vollständige Ausgabe 2019 mit einschlägigen Berichtigungen und Ergänzungen, Gleichungen, Tabellen, Geltungsgrenzen und Ausbreitungsverfahren | [FGSV RLS-19](https://www.fgsv-verlag.de/rls-19-fgsv-reader); Volltext im geprüften Bestand nicht gefunden |
| Versions- und Korrekturstand | Anwendbare Berichtigungen/Ergänzungen bei Beschaffung prüfen und eindeutig festhalten | Unter anderem [FGSV-Berichtigung vom 18.02.2020](https://fgsv-verlag.de/pub/media/pdf/052.k.18022020.pdf); nicht als abschließende Liste verstehen |
| Unabhängige Verifikation | Zum gewählten Regelstand passende Referenzfälle samt erwarteten Ergebnissen und Toleranzen | [TEST-20 Version 3.0, 11.07.2025](https://www.din.de/resource/blob/1220980/7b5908333df9806a263fdacf02e8382b/testaufgaben-zu-rls-19-data.pdf) ist als Entwurf gekennzeichnet; Eignung und freigegebenen Stand prüfen |

Alternativ ist ein bereits validiertes RLS-19-Rechenprogramm mit dokumentierter Version, verfügbarer Schnittstelle, Lizenz und Ergebnisprovenienz anzubinden. Es wurde weder eine Beschaffung ausgelöst noch ein Anbieter ausgewählt.

## Freigabekriterien für die Implementierung

- Nutzungsrechte, Herausgeber, Ausgabe, Berichtigungsstand und genaue Fundstellen dokumentieren; bereitgestellte Volltexte kontrolliert im Firmenwissen verfügbar machen.
- Berechnungsvorschriften und Anwendungsgrenzen aus diesen Quellen implementieren oder eine validierte Integration nachweisen. Keine Rekonstruktion aus Schulungsuntertiteln, Suchauszügen oder dem fertigen Bendenweg-Nachweis.
- Projektbezogene Verkehrsdaten, Zeitbezug, Fahrzeuggruppen, Geschwindigkeiten, Straßenoberfläche, Geometrie und weitere nach dem vollständigen Verfahren erforderliche Eingaben quellenbezogen erheben. Fehlende Werte bleiben offen; Straßennamen liefern keine Verkehrszählung.
- Numerische Verifikation vor Aktivierung des Rechenkerns durchführen. Der Nutzer hat Offline-Tests vorerst ausgesetzt: eine erforderliche Ausnahme dafür zuerst ausdrücklich abstimmen.
- Fachtechnische Prüfung/Freigabe bleibt vom rechnerischen Entwurf getrennt. Bis dahin meldet die Anwendung RLS-19-Berechnungen als nicht verfügbar und erzeugt keine Ersatzpegel.

Die Normenbeschaffung löst nicht automatisch die noch offenen Raum-, Fassaden- und Bauteilzuordnungen. Unabhängige Quellen- und Zuordnungsarbeit kann weitergehen; der vollständige Schallschutznachweis bleibt offen.
