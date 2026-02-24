import type {
  AgentContext,
  LoopResult,
  Observation,
  Situation,
  Decision,
  ActionResult,
  ZupPlugin,
} from './types/index';
import { executePluginHooks } from './plugin';
import { enqueueApproval, purgeExpiredApprovals, DEFAULT_APPROVAL_TTL_MS } from './utils/approvals';
import { listRuns, updateRunStatus, runToObservation, buildRunResult, sendCallback } from './runs';

function isObserveHookResult(x: unknown): x is { observations?: Observation[] } {
  return !!x && typeof x === 'object' && 'observations' in x;
}

function isOrientHookResult(x: unknown): x is { situation?: Partial<Situation> } {
  return !!x && typeof x === 'object' && 'situation' in x;
}

function isDecideHookResult(x: unknown): x is { veto?: boolean; decision?: Partial<Decision> } {
  return !!x && typeof x === 'object' && ('veto' in x || 'decision' in x);
}

export async function runOODALoop(
  ctx: AgentContext,
  plugins: ZupPlugin[]
): Promise<LoopResult> {
  const startTime = Date.now();
  let success = true;
  let error: string | undefined;

  try {
    ctx.loop.iteration++;
    ctx.loop.startTime = new Date();

    const approvalConfig = ctx.options.approvals;
    const autoExpire = approvalConfig?.autoExpire ?? true;
    const ttlMs = approvalConfig?.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    if (autoExpire) {
      purgeExpiredApprovals(ctx.state, ttlMs);
    }

    await executePluginHooks(plugins, 'onLoopStart', ctx);

    ctx.loop.phase = 'observe';
    const observations = await runObservePhase(ctx, plugins);
    ctx.loop.observations = observations;

    ctx.loop.phase = 'orient';
    const situation = await runOrientPhase(observations, ctx, plugins);
    ctx.loop.situation = situation;

    ctx.loop.phase = 'decide';
    const decision = await runDecidePhase(situation, ctx, plugins);
    ctx.loop.decision = decision;

    ctx.loop.phase = 'act';
    const actionResults = await runActPhase(decision, ctx, plugins);
    ctx.loop.actionResults = actionResults;

    ctx.loop.phase = 'idle';

    const loopResult: LoopResult = {
      observations,
      situation,
      decision,
      actionResults,
      duration: Date.now() - startTime,
      success,
    };

    // Update investigating runs with results
    const investigatingRuns = listRuns(ctx, { status: 'investigating' });
    for (const run of investigatingRuns) {
      const result = buildRunResult(loopResult, run);
      const finalStatus = loopResult.success ? 'completed' : 'failed';
      const updatedRun = updateRunStatus(ctx, run.id, finalStatus, result);
      if (updatedRun) {
        sendCallback(updatedRun).catch(() => {});
      }
    }

    await executePluginHooks(plugins, 'onLoopComplete', loopResult, ctx);
    ctx.history.push(loopResult);

    return loopResult;
  } catch (err) {
    success = false;
    error = err instanceof Error ? err.message : String(err);

    ctx.loop.phase = 'idle';

    return {
      observations: ctx.loop.observations || [],
      situation: ctx.loop.situation,
      decision: ctx.loop.decision,
      actionResults: ctx.loop.actionResults || [],
      duration: Date.now() - startTime,
      success,
      error,
    };
  }
}

export async function executeActionById(
  actionId: string,
  params: Record<string, unknown>,
  ctx: AgentContext,
  plugins: ZupPlugin[]
): Promise<ActionResult> {
  const action = ctx.capabilities.actions.get(actionId);

  if (!action) {
    ctx.logger.error(`Action not found: ${actionId}`);
    return {
      action: actionId,
      success: false,
      error: 'Action not found',
      duration: 0,
    };
  }

  await executePluginHooks(plugins, 'onBeforeAct', action, params, ctx);

  const startTime = Date.now();

  try {
    if (action.schema) {
      params = action.schema.parse(params);
    }

    const result = await action.execute(params, ctx);
    await executePluginHooks(plugins, 'onAfterAct', result, ctx);
    return result;
  } catch (error) {
    const result: ActionResult = {
      action: actionId,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - startTime,
    };
    await executePluginHooks(plugins, 'onAfterAct', result, ctx);
    return result;
  }
}

async function runObservePhase(
  ctx: AgentContext,
  plugins: ZupPlugin[]
): Promise<Observation[]> {
  const observations: Observation[] = [];
  const now = Date.now();
  const enforceIntervals = ctx.options.mode === 'continuous';
  const lastRunKey = 'observer:lastRun';
  const stored = ctx.state.get(lastRunKey);
  const lastRun =
    stored && typeof stored === 'object'
      ? (stored as Record<string, number>)
      : {};

  for (const [observerId, observer] of ctx.capabilities.observers.entries()) {
    if (enforceIntervals && observer.interval && observer.interval > 0) {
      const last = lastRun[observerId];
      if (typeof last === 'number' && now - last < observer.interval) {
        continue;
      }
    }

    try {
      const obs = await observer.observe(ctx);
      observations.push(...obs);
    } catch (error) {
      ctx.logger.error(`Error in observer ${observerId}:`, error);
    } finally {
      lastRun[observerId] = now;
    }
  }

  ctx.state.set(lastRunKey, lastRun);

  // Inject pending runs as observations
  const pendingRuns = listRuns(ctx, { status: 'pending' });
  for (const run of pendingRuns) {
    observations.push(runToObservation(run));
    updateRunStatus(ctx, run.id, 'investigating');
  }

  const hookResults = await executePluginHooks(plugins, 'onObserve', observations, ctx);

  for (const result of hookResults) {
    if (isObserveHookResult(result) && result.observations) {
      observations.push(...result.observations);
    }
  }

  return observations;
}

async function runOrientPhase(
  observations: Observation[],
  ctx: AgentContext,
  plugins: ZupPlugin[]
): Promise<Situation> {
  const assessments = [];

  for (const [orienterId, orienter] of ctx.capabilities.orienters.entries()) {
    try {
      const assessment = await orienter.orient(observations, ctx);
      assessments.push(assessment);
    } catch (error) {
      ctx.logger.error(`Error in orienter ${orienterId}:`, error);
    }
  }

  let situation: Situation = {
    summary: assessments.length > 0
      ? assessments.map(a => a.findings.join('; ')).join(' | ')
      : 'No significant observations',
    assessments,
    anomalies: [],
    correlations: [],
    priority: 'low',
    confidence: assessments.length > 0
      ? assessments.reduce((sum, a) => sum + a.confidence, 0) / assessments.length
      : 0,
  };

  const hookResults = await executePluginHooks(plugins, 'onOrient', situation, ctx);

  for (const result of hookResults) {
    if (isOrientHookResult(result) && result.situation) {
      situation = { ...situation, ...result.situation };
    }
  }

  return situation;
}

async function runDecidePhase(
  situation: Situation,
  ctx: AgentContext,
  plugins: ZupPlugin[]
): Promise<Decision> {
  const applicableStrategies = Array.from(ctx.capabilities.decisionStrategies.entries())
    .filter(([_, strategy]) => {
      if (strategy.applicableWhen) {
        return strategy.applicableWhen(situation);
      }
      return true;
    });

  if (applicableStrategies.length === 0) {
    return {
      action: 'no-op',
      params: {},
      rationale: 'No applicable decision strategies found',
      confidence: 0,
      risk: 'low',
      requiresApproval: false,
    };
  }

  const [strategyId, strategy] = applicableStrategies[0]!;
  let decision: Decision;

  try {
    decision = await strategy.decide(situation, ctx);
  } catch (error) {
    ctx.logger.error(`Error in decision strategy ${strategyId}:`, error);
    return {
      action: 'no-op',
      params: {},
      rationale: `Error in decision making: ${error}`,
      confidence: 0,
      risk: 'low',
      requiresApproval: false,
    };
  }

  const hookResults = await executePluginHooks(plugins, 'onDecide', decision, ctx);

  for (const result of hookResults) {
    if (isDecideHookResult(result)) {
      if (result.veto) {
        return {
          action: 'no-op',
          params: {},
          rationale: 'Decision vetoed by plugin',
          confidence: 0,
          risk: 'low',
          requiresApproval: false,
        };
      }

      if (result.decision) {
        decision = { ...decision, ...result.decision };
      }
    }
  }

  return decision;
}

async function runActPhase(
  decision: Decision,
  ctx: AgentContext,
  plugins: ZupPlugin[]
): Promise<ActionResult[]> {
  const actionResults: ActionResult[] = [];

  if (decision.action === 'no-op') {
    return actionResults;
  }

  const action = ctx.capabilities.actions.get(decision.action);

  if (!action) {
    ctx.logger.error(`Action not found: ${decision.action}`);
    return [
      {
        action: decision.action,
        success: false,
        error: 'Action not found',
        duration: 0,
      },
    ];
  }

  const autonomy = action.autonomy;
  const minConfidence =
    autonomy && typeof autonomy.minConfidence === 'number'
      ? autonomy.minConfidence
      : undefined;
  const approvalConfig = ctx.options.approvals;
  const autoExpire = approvalConfig?.autoExpire ?? true;
  const ttlMs = approvalConfig?.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;

  const requiresApproval =
    decision.requiresApproval ||
    autonomy?.mode === 'approval-required' ||
    autonomy?.mode === 'human-only' ||
    (minConfidence !== undefined && decision.confidence < minConfidence);

  if (requiresApproval) {
    const approval = enqueueApproval(
      ctx.state,
      {
        decision,
        actionId: decision.action,
        actionName: action.name,
        params: decision.params,
        risk: action.risk,
        confidence: decision.confidence,
        autonomy: action.autonomy,
        loopIteration: ctx.loop.iteration,
        situationSummary: ctx.loop.situation?.summary,
      },
      autoExpire ? ttlMs : undefined
    );

    actionResults.push({
      action: decision.action,
      success: false,
      error: 'Approval required',
      duration: 0,
      output: { approvalId: approval.id },
    });

    return actionResults;
  }

  const result = await executeActionById(decision.action, decision.params, ctx, plugins);
  actionResults.push(result);
  return actionResults;
}
