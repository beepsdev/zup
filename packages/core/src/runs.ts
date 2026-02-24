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
