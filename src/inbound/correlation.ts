import { SUBJECT_TOKEN_RE } from '../mail/templates';

export function extractSubjectToken(subject: string): string | null {
  const m = SUBJECT_TOKEN_RE.exec(subject);
  return m ? m[1].toLowerCase() : null;
}
