/**
 * Tests for Run Manager pruning
 */

import { describe, test, expect } from 'bun:test';
import { createAgent } from './agent';
import { createRun, listRuns, updateRunStatus, pruneRuns } from './runs';
import type { AgentContext } from './types/index';
import type { Run, RunStatus } from './types/run';

const HOUR_MS = 60 * 60 * 1000;

async function createCtx(): Promise<AgentContext> {
  const agent = await createAgent({ name: 'runs-test' });
  return agent.getContext();
}

/** Create a run in the given status, finished/updated `ageMs` ago. */
function seedRun(ctx: AgentContext, status: RunStatus, ageMs: number): Run {
  const run = createRun(ctx, {
    title: `run-${status}-${ageMs}`,
    description: 'test run',
  });

  if (status !== 'pending') {
    updateRunStatus(ctx, run.id, status);
  }

  // Backdate timestamps directly in the state store.
  const stored = ctx.state.get(`run:${run.id}`) as Run;
  const past = new Date(Date.now() - ageMs).toISOString();
  stored.updatedAt = past;
  if (stored.completedAt) {
    stored.completedAt = past;
  }
  ctx.state.set(`run:${run.id}`, stored);
  return stored;
}

describe('pruneRuns', () => {
  test('prunes finished runs older than the retention window', async () => {
    const ctx = await createCtx();

    const oldCompleted = seedRun(ctx, 'completed', 25 * HOUR_MS);
    const oldFailed = seedRun(ctx, 'failed', 48 * HOUR_MS);
    const oldCancelled = seedRun(ctx, 'cancelled', 30 * HOUR_MS);
    const freshCompleted = seedRun(ctx, 'completed', 1 * HOUR_MS);

    const pruned = pruneRuns(ctx);
    expect(pruned).toBe(3);

    const remaining = listRuns(ctx).map(r => r.id);
    expect(remaining).toEqual([freshCompleted.id]);
    expect(ctx.state.has(`run:${oldCompleted.id}`)).toBe(false);
    expect(ctx.state.has(`run:${oldFailed.id}`)).toBe(false);
    expect(ctx.state.has(`run:${oldCancelled.id}`)).toBe(false);
    expect(ctx.state.has(`run:${freshCompleted.id}`)).toBe(true);
  });

  test('falls back to updatedAt when completedAt is missing', async () => {
    const ctx = await createCtx();

    // 'cancelled' does not set completedAt in updateRunStatus.
    const run = seedRun(ctx, 'cancelled', 25 * HOUR_MS);
    expect((ctx.state.get(`run:${run.id}`) as Run).completedAt).toBeUndefined();

    expect(pruneRuns(ctx)).toBe(1);
    expect(listRuns(ctx)).toHaveLength(0);
  });

  test('never prunes pending or investigating runs, regardless of age', async () => {
    const ctx = await createCtx();

    const pending = seedRun(ctx, 'pending', 1000 * HOUR_MS);
    const investigating = seedRun(ctx, 'investigating', 1000 * HOUR_MS);

    const pruned = pruneRuns(ctx, { retentionMs: 0, maxFinished: 0 });
    expect(pruned).toBe(0);

    const remaining = listRuns(ctx).map(r => r.id).sort();
    expect(remaining).toEqual([pending.id, investigating.id].sort());
  });

  test('enforces maxFinished, keeping only the newest finished runs', async () => {
    const ctx = await createCtx();

    // All within retention; ages 1h..5h (oldest last created here).
    const runs = [1, 2, 3, 4, 5].map(h => seedRun(ctx, 'completed', h * HOUR_MS));
    const activeRun = seedRun(ctx, 'pending', 10 * HOUR_MS);

    const pruned = pruneRuns(ctx, { maxFinished: 2 });
    expect(pruned).toBe(3);

    const remaining = listRuns(ctx).map(r => r.id).sort();
    // Newest two finished (1h and 2h old) plus the pending run survive.
    expect(remaining).toEqual([runs[0]!.id, runs[1]!.id, activeRun.id].sort());
  });

  test('respects a custom retentionMs', async () => {
    const ctx = await createCtx();

    const older = seedRun(ctx, 'completed', 2 * HOUR_MS);
    const newer = seedRun(ctx, 'completed', 0.5 * HOUR_MS);

    expect(pruneRuns(ctx, { retentionMs: HOUR_MS })).toBe(1);
    expect(ctx.state.has(`run:${older.id}`)).toBe(false);
    expect(listRuns(ctx).map(r => r.id)).toEqual([newer.id]);
  });

  test('keeps the index consistent — listRuns returns no ghosts', async () => {
    const ctx = await createCtx();

    seedRun(ctx, 'completed', 25 * HOUR_MS);
    seedRun(ctx, 'failed', 25 * HOUR_MS);
    const kept = seedRun(ctx, 'completed', 1 * HOUR_MS);

    pruneRuns(ctx);

    const index = ctx.state.get('run:index');
    expect(Array.isArray(index)).toBe(true);
    expect(index as string[]).toEqual([kept.id]);

    // Every index entry resolves to a stored run.
    for (const id of index as string[]) {
      expect(ctx.state.has(`run:${id}`)).toBe(true);
    }
    expect(listRuns(ctx).map(r => r.id)).toEqual([kept.id]);
  });

  test('is a no-op when nothing qualifies for pruning', async () => {
    const ctx = await createCtx();

    const run = seedRun(ctx, 'completed', 1 * HOUR_MS);
    expect(pruneRuns(ctx)).toBe(0);
    expect(listRuns(ctx).map(r => r.id)).toEqual([run.id]);
  });
});
