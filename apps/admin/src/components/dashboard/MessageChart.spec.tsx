// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProfiles: vi.fn(),
  getMessageTrend: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: mocks,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children, minWidth }: { children: React.ReactNode; minWidth?: number }) => (
    <div data-testid="responsive-container" data-min-width={minWidth}>{children}</div>
  ),
  AreaChart: ({ children }: { children: React.ReactNode }) => <svg>{children}</svg>,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

import MessageChart from './MessageChart';

beforeEach(() => {
  mocks.getProfiles.mockResolvedValue({
    data: [{ id: 'profile-1' }],
    status: 200,
  });
  mocks.getMessageTrend.mockResolvedValue({
    data: [{ period: '2026-01-01T00:00:00.000Z', incoming: 1, outgoing: 2 }],
    status: 200,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MessageChart responsive measurement', () => {
  it('gives Recharts a non-negative minimum width before its first measurement', async () => {
    render(<MessageChart />);

    await waitFor(() => expect(mocks.getMessageTrend).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('responsive-container').getAttribute('data-min-width')).toBe('0');
  });
});
