import { describe, expect, test } from "bun:test";
import { createMagicLinkEmail } from "./magic-link-email";

describe("magic-link email", () => {
  test("keeps the sign-in subject and destination in both delivery formats", () => {
    const url = "https://example.com/api/auth/magic-link/verify?token=example-only&callbackURL=%2F";
    const email = createMagicLinkEmail(url);
    expect(email.subject).toBe("Your Richtfest sign-in link");
    expect(email.text).toContain(url);
    expect(email.text).toContain("Sign in to Richtfest");
    expect(email.text).toContain("you can safely ignore this email");
    expect(email.html.match(/href="([^"]*)"/g)).toEqual([
      `href="${url.replaceAll("&", "&amp;")}"`,
      `href="${url.replaceAll("&", "&amp;")}"`,
    ]);
    expect(email.html).toContain("Sign in to Richtfest</a>");
    expect(email.html).toContain("you can safely ignore this email");
  });

  test("escapes HTML metacharacters without altering the plain-text URL", () => {
    const url = `https://example.com/verify?token=example&value="<'test'>"`;
    const email = createMagicLinkEmail(url);
    const escaped = "https://example.com/verify?token=example&amp;value=&quot;&lt;&#39;test&#39;&gt;&quot;";
    expect(email.html.match(/href="([^"]*)"/g)).toEqual([`href="${escaped}"`, `href="${escaped}"`]);
    expect(email.html).toContain(`>${escaped}</a>`);
    expect(email.html).not.toContain(url);
    expect(email.text).toContain(url);
  });
});
