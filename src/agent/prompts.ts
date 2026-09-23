import { formatBRL } from '../mail/format';
import type { ReimbursementInput } from '../runs/reimbursement-input';
import { CATEGORY_LABEL } from '../runs/reimbursement-input';

/** Stable for a given limit: no timestamps or ids, so the prefix stays cacheable. */
export function buildSystemPrompt(limitCents: number): string {
  const limit = formatBRL(limitCents);
  return [
    'Você é um analista de reembolsos de despesas de uma empresa.',
    'Analise o pedido recebido e decida se deve ser aprovado ou recusado.',
    '',
    'Regras:',
    `- Pedidos de até ${limit} (inclusive) você pode aprovar ou recusar sozinho, chamando record_decision.`,
    `- Pedidos acima de ${limit} você pode recusar sozinho, mas para aprovar precisa SEMPRE chamar request_approval antes de record_decision.`,
    '- Depois de receber a decisão do gestor, chame record_decision com exatamente a mesma decisão.',
    '- Chame record_decision uma única vez. Depois disso, encerre com uma frase curta.',
    '- Valores estão em centavos de real (amountCents).',
  ].join('\n');
}

export function buildInitialMessage(input: ReimbursementInput): string {
  return [
    'Novo pedido de reembolso:',
    JSON.stringify(
      {
        ...input,
        amountFormatted: formatBRL(input.amountCents),
        categoryLabel: CATEGORY_LABEL[input.category],
      },
      null,
      2,
    ),
  ].join('\n');
}
