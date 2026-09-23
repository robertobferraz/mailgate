import { z } from 'zod';

export const CATEGORIES = [
  'TRAVEL',
  'MEALS',
  'EQUIPMENT',
  'TRAINING',
  'OTHER',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  TRAVEL: 'Viagem',
  MEALS: 'Alimentação',
  EQUIPMENT: 'Equipamento',
  TRAINING: 'Treinamento',
  OTHER: 'Outros',
};

const email = z.string().trim().toLowerCase().email();

export const reimbursementInputSchema = z
  .object({
    description: z.string().trim().min(1).max(2000),
    amountCents: z.number().int().min(1).max(100_000_000),
    category: z.enum(CATEGORIES),
    requesterEmail: email,
    approverEmail: email,
  })
  .strict();

export type ReimbursementInput = z.infer<typeof reimbursementInputSchema>;
