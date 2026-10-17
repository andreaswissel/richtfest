import { expect, test } from "bun:test";
import { importEmail } from "../src/components/inquiries/email-import";

const eml = (from: string) => new File([`From: ${from}
To: Richtfest <team@richtfest.ai>
Subject: =?utf-8?Q?AW:_Bauteildaten_f=C3=BCr_den_Nachweis?=
Date: Fri, 16 Oct 2026 14:05:00 +0200
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: text/plain; charset=utf-8

Außenwände Kalksandstein 36,5 cm.
--b1
Content-Type: application/pdf; name="Angaben.pdf"
Content-Disposition: attachment; filename="Angaben.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQK
--b1--
`], "reply.eml", { type: "message/rfc822" });

test("an exported email fills subject, time, text and attachments; its sender decides the direction", async () => {
  const received = await importEmail(eml("Anna Muster <a.muster@muster-architekten.de>"), "andreas@richtfest.ai");
  expect(received).toMatchObject({ subject: "AW: Bauteildaten für den Nachweis", body: "Außenwände Kalksandstein 36,5 cm.", occurredAt: "2026-10-16T12:05:00.000Z",
    direction: "incoming", from: "Anna Muster <a.muster@muster-architekten.de>" });
  expect(received.attachments.map((file) => [file.name, file.type, file.size])).toEqual([["Angaben.pdf", "application/pdf", 9]]);
  // A colleague's message from the same domain counts as sent.
  expect((await importEmail(eml("Kollegin <k@richtfest.ai>"), "andreas@richtfest.ai")).direction).toBe("outgoing");
});
