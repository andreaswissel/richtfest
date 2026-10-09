const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]!));

/** Presentation only: the auth provider owns the destination and token lifetime. */
export const createMagicLinkEmail = (url: string) => {
  const safeUrl = escapeHtml(url);
  return {
    subject: "Your Richtfest sign-in link",
    text: `Sign in to Richtfest\n\nUse the link below to sign in to your Richtfest workspace.\n\n${url}\n\nIf you didn’t request this link, you can safely ignore this email.\n\nRichtfest`,
    html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Your Richtfest sign-in link</title></head>
<body style="margin:0;padding:0;background-color:#f5f5f5;color:#171717;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f5f5f5;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:580px;background-color:#ffffff;border-top:3px solid #4f46e5;">
        <tr><td style="padding:32px 28px 0;font-size:20px;line-height:28px;font-weight:700;letter-spacing:-0.5px;">Richtfest</td></tr>
        <tr><td style="padding:32px 28px 0;">
          <h1 style="margin:0;font-size:26px;line-height:34px;font-weight:600;letter-spacing:-0.5px;">Sign in to Richtfest</h1>
          <p style="margin:14px 0 0;font-size:15px;line-height:24px;color:#525252;">Use the link below to sign in to your Richtfest workspace.</p>
        </td></tr>
        <tr><td style="padding:26px 28px 0;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" bgcolor="#4f46e5" style="border-radius:5px;">
            <a href="${safeUrl}" style="display:inline-block;border:1px solid #4f46e5;border-radius:5px;padding:12px 20px;font-size:15px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;">Sign in to Richtfest</a>
          </td></tr></table>
        </td></tr>
        <tr><td style="padding:26px 28px 28px;">
          <p style="margin:0 0 8px;font-size:13px;line-height:20px;color:#737373;">If the button doesn’t work, copy and paste this link into your browser:</p>
          <a href="${safeUrl}" style="font-size:13px;line-height:20px;color:#525252;text-decoration:underline;overflow-wrap:anywhere;word-break:break-all;">${safeUrl}</a>
        </td></tr>
        <tr><td style="padding:22px 28px 26px;border-top:1px solid #e5e5e5;">
          <p style="margin:0;font-size:13px;line-height:20px;color:#737373;">If you didn’t request this link, you can safely ignore this email.</p>
          <p style="margin:14px 0 0;font-size:12px;line-height:18px;color:#737373;">Richtfest</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  };
};
