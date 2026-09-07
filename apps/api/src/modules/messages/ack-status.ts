import { prisma } from '@multiwa/database';

const ACK_STATUSES = new Set([
  'pending',
  'sent',
  'delivered',
  'read',
  'played',
  'failed',
]);
const RETRYABLE_DB_CODES = new Set(['P2034', '40P01', '40001', '55P03']);

interface MessageAckStore {
  message: {
    updateMany(args: {
      where: { profileId: string; messageId: string };
      data: { status: string };
    }): Promise<{ count: number }>;
  };
}

export interface AckRetryOptions {
  retries?: number;
  baseDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onRetry?: (details: { attempt: number; code: string; delayMs: number }) => void;
}

export type AckUpdateResult =
  | { applied: true; count: number; status: string }
  | { applied: false; reason: 'invalid_profile_id' | 'invalid_message_id' | 'invalid_status' };

function validIdentifier(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function retryableCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const value = error as Record<string, any>;
  return [value.code, value.meta?.code, value.cause?.code, value.originalError?.code]
    .find(candidate => typeof candidate === 'string' && RETRYABLE_DB_CODES.has(candidate)) || '';
}

export function isRetryableAckDbError(error: unknown): boolean {
  return Boolean(retryableCode(error));
}

async function updateWithRetry(
  operation: () => Promise<{ count: number }>,
  options: AckRetryOptions,
): Promise<{ count: number }> {
  const retries = Number.isFinite(options.retries)
    ? Math.max(0, Math.min(3, Number(options.retries))) : 2;
  const baseDelayMs = Number.isFinite(options.baseDelayMs)
    ? Math.max(1, Math.min(1000, Number(options.baseDelayMs))) : 20;
  const sleep = options.sleep || ((milliseconds: number) =>
    new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const onRetry = options.onRetry || (details => console.warn(
    `[ACK] Retrying transient database conflict ${details.code} ` +
    `(attempt ${details.attempt}, ${details.delayMs}ms)`,
  ));
  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !isRetryableAckDbError(error)) throw error;
      attempt += 1;
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      onRetry({ attempt, code: retryableCode(error), delayMs });
      await sleep(delayMs);
    }
  }
}

export async function applyMessageAck(
  profileId: unknown,
  messageId: unknown,
  status: unknown,
  store: MessageAckStore = prisma,
  retryOptions: AckRetryOptions = {},
): Promise<AckUpdateResult> {
  if (!validIdentifier(profileId, 128)) {
    return { applied: false, reason: 'invalid_profile_id' };
  }
  if (!validIdentifier(messageId, 512)) {
    return { applied: false, reason: 'invalid_message_id' };
  }
  if (typeof status !== 'string' || !ACK_STATUSES.has(status)) {
    return { applied: false, reason: 'invalid_status' };
  }
  const result = await updateWithRetry(() => store.message.updateMany({
    where: { profileId, messageId },
    data: { status },
  }), retryOptions);
  return { applied: true, count: result.count, status };
}
