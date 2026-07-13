/**
 * Run Manager
 *
 * Manages externally-submitted runs that flow through the OODA loop.
 * Runs are stored in the state store and converted to observations for processing.
 */

import { randomUUID } from 'crypto';
import type { AgentContext, Observation, LoopResult } from './types/index';
import type { Run, RunStatus, CreateRunInput, RunResult } from './types/run';

const RUN_PREFIX = 'run:';
const RUN_INDEX_KEY = 'run:index';

/** How long finished runs are retained before pruning (default: 24 hours). */
export const DEFAULT_RUN_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Maximum number of finished runs retained regardless of age (default: 500). */
export const DEFAULT_MAX_FINISHED_RUNS = 500;

/** Statuses that mark a run as finished (eligible for pruning). */
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

function getRunIndex(ctx: AgentContext): string[] {
  const stored = ctx.state.get(RUN_INDEX_KEY);
  if (Array.isArray(stored)) {
    return stored as string[];
  }
  return [];
}

function setRunIndex(ctx: AgentContext, index: string[]) {
  ctx.state.set(RUN_INDEX_KEY, index);
}

export function createRun(ctx: AgentContext, input: CreateRunInput): Run {
  const id = randomUUID();
  const now = new Date().toISOString();

  const run: Run = {
    id,
    title: input.title,
    description: input.description,
    priority: input.priority || 'medium',
    status: 'pending',
    context: input.context || {},
    source: input.source || 'api',
    callbackUrl: input.callbackUrl,
    createdAt: now,
    updatedAt: now,
  };

  ctx.state.set(`${RUN_PREFIX}${id}`, run);

  const index = getRunIndex(ctx);
  index.push(id);
  setRunIndex(ctx, index);

  ctx.logger.info(`Run created: ${id} - ${input.title}`);
  return run;
}

export function getRun(ctx: AgentContext, runId: string): Run | undefined {
  const stored = ctx.state.get(`${RUN_PREFIX}${runId}`);
  if (stored && typeof stored === 'object' && 'id' in stored) {
    return stored as Run;
  }
  return undefined;
}

export function listRuns(
  ctx: AgentContext,
  opts?: { status?: RunStatus; limit?: number }
): Run[] {
  const index = getRunIndex(ctx);
  let runs: Run[] = [];

  for (const id of index) {
    const run = getRun(ctx, id);
    if (run) {
      runs.push(run);
    }
  }

  if (opts?.status) {
    runs = runs.filter(r => r.status === opts.status);
  }

  // Sort by creation time descending (newest first)
  runs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (opts?.limit && opts.limit > 0) {
    runs = runs.slice(0, opts.limit);
  }

  return runs;
}

export function updateRunStatus(
  ctx: AgentContext,
  runId: string,
  status: RunStatus,
  result?: RunResult
): Run | undefined {
  const run = getRun(ctx, runId);
  if (!run) return undefined;

  run.status = status;
  run.updatedAt = new Date().toISOString();

  if (status === 'completed' || status === 'failed') {
    run.completedAt = new Date().toISOString();
  }

  if (result) {
    run.result = result;
  }

  ctx.state.set(`${RUN_PREFIX}${runId}`, run);
  ctx.logger.info(`Run ${runId} updated to ${status}`);
  return run;
}

/**
 * Prune finished runs from the state store.
 *
 * Removes runs in a terminal status (completed/failed/cancelled) that finished
 * longer than `retentionMs` ago, judged by `completedAt` (falling back to
 * `updatedAt`). Also enforces `maxFinished`: if more finished runs remain,
 * only the newest are kept. Pending/investigating runs are never pruned.
 *
 * Returns the number of index entries removed.
 */
export function pruneRuns(
  ctx: AgentContext,
  opts?: { retentionMs?: number; maxFinished?: number }
): number {
  const retentionMs = opts?.retentionMs ?? DEFAULT_RUN_RETENTION_MS;
  const maxFinished = opts?.maxFinished ?? DEFAULT_MAX_FINISHED_RUNS;
  const now = Date.now();

  const index = getRunIndex(ctx);
  const toDelete = new Set<string>();
  const retainedFinished: Array<{ id: string; finishedAt: number }> = [];

  for (const id of index) {
    const run = getRun(ctx, id);
    if (!run) {
      // Ghost index entry with no backing state — clean it up.
      toDelete.add(id);
      continue;
    }
    if (!TERMINAL_STATUSES.has(run.status)) continue;

    const finishedAt = new Date(run.completedAt ?? run.updatedAt).getTime();
    if (now - finishedAt > retentionMs) {
      toDelete.add(id);
    } else {
      retainedFinished.push({ id, finishedAt });
    }
  }

  // Enforce the max-finished cap, keeping the newest finished runs.
  if (retainedFinished.length > maxFinished) {
    retainedFinished.sort((a, b) => b.finishedAt - a.finishedAt);
    for (const { id } of retainedFinished.slice(maxFinished)) {
      toDelete.add(id);
    }
  }

  if (toDelete.size === 0) return 0;

  for (const id of toDelete) {
    ctx.state.delete(`${RUN_PREFIX}${id}`);
  }
  setRunIndex(ctx, index.filter(id => !toDelete.has(id)));

  ctx.logger.info(`Pruned ${toDelete.size} finished run(s)`);
  return toDelete.size;
}

export function runToObservation(run: Run): Observation {
  return {
    source: `run:${run.source}`,
    timestamp: new Date(run.createdAt),
    type: 'alert',
    severity: run.priority === 'critical' ? 'critical'
      : run.priority === 'high' ? 'error'
      : run.priority === 'medium' ? 'warning'
      : 'info',
    data: {
      runId: run.id,
      title: run.title,
      description: run.description,
      priority: run.priority,
      source: run.source,
      ...run.context,
    },
    metadata: {
      isRun: true,
      runId: run.id,
      callbackUrl: run.callbackUrl,
    },
  };
}

export function buildRunResult(loopResult: LoopResult, run: Run): RunResult {
  return {
    summary: loopResult.situation?.summary || 'Loop completed',
    findings: loopResult.situation?.assessments?.flatMap(a => a.findings) || [],
    actionsPerformed: loopResult.actionResults.map(r => ({
      action: r.action,
      success: r.success,
      description: r.error || 'Action completed',
    })),
    loopIterations: 1,
    duration: loopResult.duration,
    situationAssessment: loopResult.situation?.summary,
    recommendations: loopResult.situation?.assessments
      ?.filter(a => a.contributingFactor)
      .map(a => a.contributingFactor!) || [],
  };
}

export async function sendCallback(run: Run): Promise<void> {
  if (!run.callbackUrl) return;

  try {
    await fetch(run.callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: run.id,
        status: run.status,
        result: run.result,
        completedAt: run.completedAt,
      }),
    });
  } catch (error) {
    // Callback failures are non-fatal
    console.warn(`Failed to send callback for run ${run.id}:`, error);
  }
}
