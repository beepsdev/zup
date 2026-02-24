/**
 * Approval queue utilities
 */

import { randomUUID } from 'crypto';
import type {
  StateStore,
  Decision,
  Action,
  ActionResult,
  RiskLevel,
} from '../types/index';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export type ApprovalItem = {
  id: string;
  status: ApprovalStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  decision: Decision;
  actionId: string;
  actionName?: string;
  params: Record<string, unknown>;
  risk?: RiskLevel;
  confidence?: number;
  autonomy?: Action['autonomy'];
  loopIteration: number;
  situationSummary?: string;
  result?: ActionResult;
  note?: string;
  actedBy?: string;
};

export type ApprovalQueue = {
  pending: ApprovalItem[];
  history: ApprovalItem[];
};

export const DEFAULT_APPROVAL_TTL_MS = 60 * 60_000;

const APPROVAL_STATE_KEY = 'approvals';

function isApprovalQueue(value: unknown): value is ApprovalQueue {
  if (!value || typeof value !== 'object') return false;
  const queue = value as ApprovalQueue;
  return Array.isArray(queue.pending) && Array.isArray(queue.history);
}

export function getApprovalQueue(state: StateStore): ApprovalQueue {
  const existing = state.get(APPROVAL_STATE_KEY);
  if (isApprovalQueue(existing)) {
    return existing;
  }

  const queue: ApprovalQueue = { pending: [], history: [] };
  state.set(APPROVAL_STATE_KEY, queue);
  return queue;
}

export function enqueueApproval(
  state: StateStore,
  input: Omit<ApprovalItem, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'expiresAt'>,
  ttlMs?: number
): ApprovalItem {
  const queue = getApprovalQueue(state);
  const now = new Date().toISOString();
  const expiresAt =
    typeof ttlMs === 'number' && ttlMs > 0
      ? new Date(Date.now() + ttlMs).toISOString()
      : undefined;

  const item: ApprovalItem = {
    id: randomUUID(),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    expiresAt,
    ...input,
  };

  queue.pending.push(item);
  state.set(APPROVAL_STATE_KEY, queue);
  return item;
}

export function resolveApproval(
  state: StateStore,
  id: string,
  status: Exclude<ApprovalStatus, 'pending'>,
  updates: Partial<Pick<ApprovalItem, 'result' | 'note' | 'actedBy'>> = {}
): ApprovalItem | undefined {
  const queue = getApprovalQueue(state);
  const index = queue.pending.findIndex(item => item.id === id);
  if (index < 0) {
    return undefined;
  }

  const now = new Date().toISOString();
  const item = queue.pending[index]!;
  const resolved: ApprovalItem = {
    ...item,
    status,
    updatedAt: now,
    ...updates,
  };

  queue.pending.splice(index, 1);
  queue.history.push(resolved);
  state.set(APPROVAL_STATE_KEY, queue);
  return resolved;
}

export function purgeExpiredApprovals(
  state: StateStore,
  ttlMs?: number,
  nowMs: number = Date.now()
): ApprovalItem[] {
  if (!ttlMs || ttlMs <= 0) {
    return [];
  }

  const queue = getApprovalQueue(state);
  const expired: ApprovalItem[] = [];

  for (let i = queue.pending.length - 1; i >= 0; i -= 1) {
    const item = queue.pending[i]!;
    let expiresAtMs: number | undefined;
    if (item.expiresAt) {
      expiresAtMs = Date.parse(item.expiresAt);
    } else if (item.createdAt) {
      expiresAtMs = Date.parse(item.createdAt) + ttlMs;
    }

    if (expiresAtMs !== undefined && expiresAtMs <= nowMs) {
      const resolved: ApprovalItem = {
        ...item,
        status: 'expired',
        updatedAt: new Date(nowMs).toISOString(),
      };
      queue.pending.splice(i, 1);
      queue.history.push(resolved);
      expired.push(resolved);
    }
  }

  if (expired.length > 0) {
    state.set(APPROVAL_STATE_KEY, queue);
  }
  return expired;
}
