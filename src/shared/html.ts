// E-mail-safe design tokens (pdr 0004), shared by the e-mails and the timeline page.
export const FONT =
  "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const INK = '#1a1a1a'; // primary text, ~17.5:1 on white
export const MUTED = '#55606e'; // secondary text (labels, footer, deadline), ~6.4:1 on white
export const ACCENT = '#1d4ed8'; // functional accent: amount + reply instruction, ~6.7:1 on white
export const ACCENT_TINT = '#eef2ff'; // pale background for accent blocks
export const RULE = '#e5e7eb'; // hairline divider

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "gestor@acme.test" -> "g***@acme.test" (pdr 0006). */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
