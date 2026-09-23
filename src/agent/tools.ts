import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

export const REQUEST_APPROVAL = 'request_approval';
export const RECORD_DECISION = 'record_decision';

export const TOOLS: Anthropic.Tool[] = [
  {
    name: REQUEST_APPROVAL,
    description:
      'Pausa a análise e envia ao gestor um e-mail pedindo aprovação humana. Obrigatório antes de aprovar valores acima do limite de aprovação automática.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'recommendation', 'rationale'],
      properties: {
        summary: {
          type: 'string',
          description:
            'Resumo do pedido para o gestor, em português, até 600 caracteres.',
        },
        recommendation: { type: 'string', enum: ['APPROVE', 'REJECT'] },
        rationale: {
          type: 'string',
          description: 'Justificativa da recomendação, em português.',
        },
      },
    },
  },
  {
    name: RECORD_DECISION,
    description:
      'Registra a decisão final sobre o reembolso. Chame uma única vez por pedido.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['decision', 'reason'],
      properties: {
        decision: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
        reason: {
          type: 'string',
          description: 'Motivo da decisão, em português.',
        },
      },
    },
  },
];

export const requestApprovalInput = z.object({
  summary: z.string().min(1),
  recommendation: z.enum(['APPROVE', 'REJECT']),
  rationale: z.string().min(1),
});

export const recordDecisionInput = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().min(1),
});
