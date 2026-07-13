import { test, expect, describe } from 'bun:test';
import {
  enqueueApproval,
  resolveApproval,
  purgeExpiredApprovals,
  getApprovalQueue,
  DEFAULT_APPROVAL_HISTORY_LIMIT,
  type ApprovalItem,
} from './approvals';
import { createStateStore } from './state';
import type { Decision } from '../types/index';

const decision: Decision = {
  action: 'test-action',
  params: {},
  rationale: 'test',
  confidence: 1,
  risk: 'low',
  requiresApproval: true,
};

function enqueue(state: ReturnType<typeof createStateStore>, i: number, ttlMs?: number): ApprovalItem {
  return enqueueApproval(
    state,
    {
      decision,
      actionId: 'test-action',
      params: { index: i },
      loopIteration: i,
    },
    ttlMs
  );
}

describe('approval history cap', () => {
  test('resolveApproval trims history to DEFAULT_APPROVAL_HISTORY_LIMIT', () => {
    const state = createStateStore();
    const total = DEFAULT_APPROVAL_HISTORY_LIMIT + 25;

    for (let i = 0; i < total; i += 1) {
      const item = enqueue(state, i);
      resolveApproval(state, item.id, 'approved');
    }

    const queue = getApprovalQueue(state);
    expect(queue.pending).toHaveLength(0);
    expect(queue.history).toHaveLength(DEFAULT_APPROVAL_HISTORY_LIMIT);
    // Oldest entries are dropped; the most recent ones are retained.
    expect(queue.history[0]?.loopIteration).toBe(25);
    expect(queue.history[queue.history.length - 1]?.loopIteration).toBe(total - 1);
  });

  test('resolveApproval respects a custom maxHistory', () => {
    const state = createStateStore();

    for (let i = 0; i < 10; i += 1) {
      const item = enqueue(state, i);
      resolveApproval(state, item.id, 'denied', {}, 3);
    }

    const queue = getApprovalQueue(state);
    expect(queue.history).toHaveLength(3);
    expect(queue.history.map(item => item.loopIteration)).toEqual([7, 8, 9]);
    expect(queue.history.every(item => item.status === 'denied')).toBe(true);
  });

  test('purgeExpiredApprovals trims history to the cap', () => {
    const state = createStateStore();
    const ttlMs = 1000;

    for (let i = 0; i < 8; i += 1) {
      enqueue(state, i, ttlMs);
    }

    const expired = purgeExpiredApprovals(state, ttlMs, Date.now() + ttlMs + 1, 5);

    expect(expired).toHaveLength(8);
    const queue = getApprovalQueue(state);
    expect(queue.pending).toHaveLength(0);
    expect(queue.history).toHaveLength(5);
    expect(queue.history.every(item => item.status === 'expired')).toBe(true);
    // The most recently appended history entries are retained (purge walks
    // pending in reverse, so within one batch newer items are appended first).
    const iterations = queue.history.map(item => item.loopIteration).sort((a, b) => a - b);
    expect(iterations).toEqual([0, 1, 2, 3, 4]);
  });

  test('repeated purge cycles never grow history beyond the cap', () => {
    const state = createStateStore();
    const ttlMs = 1000;
    const cap = 4;
    let now = Date.now();

    for (let cycle = 0; cycle < 20; cycle += 1) {
      enqueue(state, cycle, ttlMs);
      now += ttlMs + 1;
      purgeExpiredApprovals(state, ttlMs, now, cap);
      expect(getApprovalQueue(state).history.length).toBeLessThanOrEqual(cap);
    }

    const queue = getApprovalQueue(state);
    expect(queue.history).toHaveLength(cap);
    expect(queue.history.map(item => item.loopIteration)).toEqual([16, 17, 18, 19]);
  });

  test('history below the cap is left untouched', () => {
    const state = createStateStore();

    for (let i = 0; i < 3; i += 1) {
      const item = enqueue(state, i);
      resolveApproval(state, item.id, 'approved');
    }

    const queue = getApprovalQueue(state);
    expect(queue.history).toHaveLength(3);
    expect(queue.history.map(item => item.loopIteration)).toEqual([0, 1, 2]);
  });
});
