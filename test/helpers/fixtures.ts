import { ReimbursementInput } from '../../src/runs/reimbursement-input';

export function validInput(
  patch: Partial<ReimbursementInput> = {},
): ReimbursementInput {
  return {
    description: 'Hotel em SP para visita a cliente',
    amountCents: 84000,
    category: 'TRAVEL',
    requesterEmail: 'ana@acme.test',
    approverEmail: 'gestor@acme.test',
    ...patch,
  };
}
