/**
 * Investigation Orienter Plugin
 *
 * A plugin that uses a Konchu-style tool-calling loop within Zup's Orient phase
 * for deep incident investigation. When observations indicate something complex,
 * instead of a single-pass analysis, this orienter spawns a sub-loop that can
 * query logs, check metrics, correlate events, etc.
 */

import {
  definePlugin,
  createOrienter,
  type AgentContext,
  type Observation,
  type SituationAssessment,
} from '../../index';
import {
  runInvestigation,
  type InvestigationTool,
  type InvestigationResult,
} from '../../investigation';

export type InvestigationOrienterConfig = {
  tools: InvestigationTool[];
  maxTurns?: number;
  systemPrompt?: string;
  triggerSeverity?: 'info' | 'warning' | 'error' | 'critical';
};

const SEVERITY_ORDER = ['info', 'warning', 'error', 'critical'] as const;

function meetsThreshold(
  severity: string | undefined,
  threshold: 'info' | 'warning' | 'error' | 'critical'
): boolean {
  if (!severity) return false;
  const severityIndex = SEVERITY_ORDER.indexOf(severity as typeof SEVERITY_ORDER[number]);
  const thresholdIndex = SEVERITY_ORDER.indexOf(threshold);
  return severityIndex >= thresholdIndex;
}

function buildInvestigationPrompt(observations: Observation[]): string {
  const obsText = observations
    .map(obs => `- [${obs.severity || 'info'}] ${obs.source}: ${JSON.stringify(obs.data)}`)
    .join('\n');

  return `The following observations have been collected from the system:

${obsText}

Please investigate these observations to determine:
1. What is the root cause?
2. What is the impact?
3. What services/components are affected?
4. What is the recommended action?

Use the available tools to gather more information as needed. When you have enough information to provide a comprehensive analysis, summarize your findings.`;
}

function parseToAssessment(
  result: InvestigationResult,
  incomplete: boolean
): SituationAssessment {
  return {
    source: 'investigation-orienter',
    findings: [result.findings],
    contributingFactor: extractContributingFactor(result.findings),
    impactAssessment: extractImpact(result.findings),
    confidence: incomplete ? 0.6 : 0.85,
  };
}

function extractContributingFactor(findings: string): string | undefined {
  const rootCauseMatch = findings.match(/root cause[:\s]+([^.]+)/i);
  if (rootCauseMatch) {
    return rootCauseMatch[1]?.trim();
  }

  const causeMatch = findings.match(/caused by[:\s]+([^.]+)/i);
  if (causeMatch) {
    return causeMatch[1]?.trim();
  }

  return undefined;
}

function extractImpact(findings: string): string | undefined {
  const impactMatch = findings.match(/impact[:\s]+([^.]+)/i);
  if (impactMatch) {
    return impactMatch[1]?.trim();
  }

  const affectedMatch = findings.match(/affected[:\s]+([^.]+)/i);
  if (affectedMatch) {
    return affectedMatch[1]?.trim();
  }

  return undefined;
}

export const investigationOrienter = (config: InvestigationOrienterConfig) => {
  const { tools, maxTurns = 15, systemPrompt, triggerSeverity = 'warning' } = config;

  if (tools.length === 0) {
    throw new Error('investigationOrienter: At least one tool must be configured');
  }

  return definePlugin({
    id: 'investigation-orienter',

    orienters: {
      investigate: createOrienter({
        name: 'Deep Investigation',
        description: 'Uses tool-calling loop to deeply investigate observations',

        orient: async (
          observations: Observation[],
          ctx: AgentContext
        ): Promise<SituationAssessment> => {
          // Check if investigation is warranted
          const shouldInvestigate = observations.some(obs =>
            meetsThreshold(obs.severity, triggerSeverity)
          );

          if (!shouldInvestigate) {
            return {
              source: 'investigation-orienter',
              findings: ['No significant observations requiring deep investigation'],
              confidence: 0.9,
            };
          }

          // Build investigation prompt from observations
          const prompt = buildInvestigationPrompt(observations);

          ctx.logger.info('[investigation-orienter] Starting deep investigation', {
            observationCount: observations.length,
          });

          // Run the Konchu-style investigation loop
          const result = await runInvestigation(ctx, prompt, {
            tools,
            maxTurns,
            systemPrompt,
          });

          ctx.logger.info('[investigation-orienter] Investigation complete', {
            turnsUsed: result.turnsUsed,
            toolsUsed: result.toolsUsed,
            incomplete: result.incomplete,
          });

          // Parse LLM findings into structured assessment
          return parseToAssessment(result, result.incomplete || false);
        },
      }),
    },
  });
};

export type { InvestigationTool, InvestigationResult };
