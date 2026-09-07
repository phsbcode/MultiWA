import { describe, expect, it, vi } from 'vitest';
import { applyMessageAck, isRetryableAckDbError } from './ack-status';

function store() {
  return { message: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
}

describe('applyMessageAck', () => {
  it.each([undefined, null, '', ' ', 'bad\nvalue', 'x'.repeat(513)])(
    'performs no write for malformed provider message id %s',
    async messageId => {
      const database = store();
      await expect(applyMessageAck('profile-a', messageId, 'delivered', database))
        .resolves.toEqual({ applied: false, reason: 'invalid_message_id' });
      expect(database.message.updateMany).not.toHaveBeenCalled();
    },
  );

  it('performs no write for a malformed profile or unsupported status', async () => {
    const database = store();
    await expect(applyMessageAck('', 'message-a', 'delivered', database))
      .resolves.toEqual({ applied: false, reason: 'invalid_profile_id' });
    await expect(applyMessageAck('profile-a', 'message-a', 'unknown', database))
      .resolves.toEqual({ applied: false, reason: 'invalid_status' });
    expect(database.message.updateMany).not.toHaveBeenCalled();
  });

  it('updates by profile and provider message id together', async () => {
    const database = store();
    await expect(applyMessageAck('profile-a', 'message-a', 'read', database))
      .resolves.toEqual({ applied: true, count: 1, status: 'read' });
    expect(database.message.updateMany).toHaveBeenCalledWith({
      where: { profileId: 'profile-a', messageId: 'message-a' },
      data: { status: 'read' },
    });
  });

  it('retries recognized transient conflicts and reports each retry', async () => {
    const database = store();
    const conflict = Object.assign(new Error('conflict'), { code: '40P01' });
    database.message.updateMany.mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict).mockResolvedValue({ count: 1 });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();
    await expect(applyMessageAck('profile-a', 'message-a', 'delivered', database,
      { sleep, onRetry })).resolves.toMatchObject({ applied: true });
    expect(database.message.updateMany).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[20], [40]]);
    expect(onRetry.mock.calls.map(call => call[0])).toEqual([
      { attempt: 1, code: '40P01', delayMs: 20 },
      { attempt: 2, code: '40P01', delayMs: 40 },
    ]);
  });

  it('rethrows the original conflict after bounded retries', async () => {
    const database = store();
    const conflict = Object.assign(new Error('conflict'), { code: 'P2034' });
    database.message.updateMany.mockRejectedValue(conflict);
    await expect(applyMessageAck('profile-a', 'message-a', 'delivered', database,
      { sleep: async () => {}, onRetry: () => {} })).rejects.toBe(conflict);
    expect(database.message.updateMany).toHaveBeenCalledTimes(3);
  });

  it('does not retry unrelated database errors', async () => {
    const database = store();
    const error = Object.assign(new Error('unique constraint'), { code: 'P2002' });
    database.message.updateMany.mockRejectedValue(error);
    await expect(applyMessageAck('profile-a', 'message-a', 'delivered', database,
      { sleep: async () => {}, onRetry: () => {} })).rejects.toBe(error);
    expect(database.message.updateMany).toHaveBeenCalledTimes(1);
    expect(isRetryableAckDbError({ cause: { code: '40001' } })).toBe(true);
    expect(isRetryableAckDbError({ code: 'P2002', cause: { code: '40P01' } })).toBe(true);
    expect(isRetryableAckDbError({ message: 'deadlock detected' })).toBe(false);
  });
});
