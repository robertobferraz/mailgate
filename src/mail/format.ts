const brl = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});
const deadline = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  dateStyle: 'short',
  timeStyle: 'short',
});

/** 84000 -> "R$ 840,00" (Intl uses NBSP; e-mails get a plain space). */
export function formatBRL(cents: number): string {
  // eslint-disable-next-line no-irregular-whitespace -- intentional NBSP -> plain space
  return brl.format(cents / 100).replace(/ /g, ' ');
}

export function formatDeadline(d: Date): string {
  // eslint-disable-next-line no-irregular-whitespace -- intentional NBSP -> plain space
  return deadline.format(d).replace(/ /g, ' ');
}
