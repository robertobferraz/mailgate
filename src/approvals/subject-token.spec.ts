import { SUBJECT_TOKEN_RE } from '../mail/templates';
import { newSubjectToken } from './subject-token';

describe('newSubjectToken', () => {
  it('produces 8 base32 chars that the subject regex recognizes', () => {
    for (let i = 0; i < 200; i++) {
      const t = newSubjectToken();
      expect(t).toMatch(/^[a-z2-7]{8}$/);
      expect(SUBJECT_TOKEN_RE.exec(`Re: [mailgate #${t}] x`)?.[1]).toBe(t);
    }
  });
  it('is practically unique', () => {
    expect(new Set(Array.from({ length: 1000 }, newSubjectToken)).size).toBe(
      1000,
    );
  });
});
