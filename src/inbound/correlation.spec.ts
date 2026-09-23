import { extractSubjectToken } from './correlation';

describe('extractSubjectToken', () => {
  it.each([
    ['Re: [mailgate #abcd2345] Reembolso', 'abcd2345'],
    ['RES: [MAILGATE #ABCD2345] Reembolso', 'abcd2345'],
    ['Fwd: nada aqui', null],
    ['[mailgate #abc] curto', null],
  ])('%s -> %s', (s, t) => expect(extractSubjectToken(s)).toBe(t));
});
