import { escapeHtml, maskEmail } from './html';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});

describe('maskEmail', () => {
  it('keeps the first letter and the domain', () => {
    expect(maskEmail('gestor@acme.test')).toBe('g***@acme.test');
  });
  it('masks a one-letter local part', () => {
    expect(maskEmail('g@acme.test')).toBe('g***@acme.test');
  });
  it('returns *** for something that is not an address', () => {
    expect(maskEmail('nope')).toBe('***');
  });
});
