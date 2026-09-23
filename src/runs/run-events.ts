import { Prisma } from '../generated/prisma/client';
import { Db } from '../prisma/db';

export type RunEventType =
  | 'CREATED'
  | 'CLAIMED'
  | 'LEASE_LOST'
  | 'RETRY_SCHEDULED'
  | 'APPROVAL_REQUESTED'
  | 'APPROVAL_SENT'
  | 'DECISION_RECEIVED'
  | 'RESUMED'
  | 'ACTION_RECORDED'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXPIRED';

export async function appendRunEvent(
  db: Db,
  runId: string,
  type: RunEventType,
  data: Record<string, unknown> = {},
): Promise<void> {
  await db.runEvent.create({
    data: { runId, type, data: data as Prisma.InputJsonValue },
  });
}
