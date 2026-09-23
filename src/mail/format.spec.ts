import { formatBRL, formatDeadline } from './format';

describe('format', () => {
  it('formats cents as BRL with a plain space', () => {
    expect(formatBRL(84000)).toBe('R$ 840,00');
    expect(formatBRL(123456789)).toBe('R$ 1.234.567,89');
  });
  it('formats deadlines in America/Sao_Paulo', () => {
    const s = formatDeadline(new Date('2026-09-25T17:30:00Z'));
    expect(s).toContain('25/09/2026');
    expect(s).toContain('14:30');
  });
});
