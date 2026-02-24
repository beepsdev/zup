import { createAgent, definePlugin, createObserver, createOrienter } from '../packages/core/src/index';
import { z } from 'zod';
import type { Observation, SituationAssessment, AgentContext, LLMConfig } from '../packages/core/src/index';

const llmOrientedPlugin = () =>
  definePlugin({
    id: 'llm-analysis',

    observers: {
      systemMetrics: createObserver({
        name: 'system-metrics',
        description: 'Collect system metrics',
        observe: async () => {
          const observations: Observation[] = [
            {
              source: 'system/cpu',
              timestamp: new Date(),
              type: 'metric',
              severity: 'warning',
              data: {
                usage: 85,
                threshold: 80,
              },
            },
            {
              source: 'system/memory',
              timestamp: new Date(),
              type: 'metric',
              severity: 'info',
              data: {
                usage: 60,
                total: 16384,
              },
            },
            {
              source: 'application/errors',
              timestamp: new Date(),
              type: 'log',
              severity: 'error',
              data: {
                count: 15,
                message: 'Database connection timeout',
              },
            },
          ];

          return observations;
        },
      }),
    },

    orienters: {
      llmAnalysis: createOrienter({
        name: 'llm-situation-analysis',
        description: 'Use LLM to analyze observations and identify root causes',
        orient: async (observations: Observation[], ctx: AgentContext) => {
          if (!ctx.llm) {
            ctx.logger.warn('[llm-analysis] LLM not configured, falling back to basic analysis');
            return {
              source: 'llm-analysis/fallback',
              findings: ['LLM not configured'],
              confidence: 0.5,
            };
          }

          const observationsSummary = observations
            .map(
              obs =>
                `- [${obs.severity}] ${obs.source}: ${JSON.stringify(obs.data)}`
            )
            .join('\n');

          const prompt = `You are an SRE analyzing system observations. Based on these observations, identify:
1. What is happening in the system
2. What is the likely root cause
3. How critical is the situation

Observations:
${observationsSummary}

Analyze the situation and respond with your assessment.`;

          try {
            const result = await ctx.llm.generateText(prompt, {
              system: 'You are an expert SRE with deep knowledge of distributed systems, databases, and performance optimization.',
              temperature: 0.3, // Low temperature for consistent analysis
              maxTokens: 500,
            });

            ctx.logger.info(`[llm-analysis] Token usage: ${result.usage?.totalTokens || 'unknown'}`);

            const assessment: SituationAssessment = {
              source: 'llm-analysis/claude',
              findings: [result.text],
              confidence: 0.9,
            };

            return assessment;
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            ctx.logger.error(`[llm-analysis] LLM error: ${errorMessage}`);

            return {
              source: 'llm-analysis/error',
              findings: [`LLM analysis failed: ${errorMessage}`],
              confidence: 0.1,
            };
          }
        },
      }),

      structuredAnalysis: createOrienter({
        name: 'llm-structured-analysis',
        description: 'Use LLM to produce structured analysis with Zod validation',
        orient: async (observations: Observation[], ctx: AgentContext) => {
          if (!ctx.llm) {
            return {
              source: 'structured-analysis/no-llm',
              findings: ['LLM not configured'],
              confidence: 0.5,
            };
          }

          const AnalysisSchema = z.object({
            severity: z.enum(['low', 'medium', 'high', 'critical']),
            contributingFactor: z.string(),
            symptoms: z.array(z.string()),
            recommendedActions: z.array(z.string()),
          });

          const observationsSummary = observations
            .map(obs => ({
              source: obs.source,
              severity: obs.severity,
              data: obs.data,
            }))
            .map(o => JSON.stringify(o))
            .join('\n');

          const prompt = `Analyze these system observations and provide:
- severity: overall situation severity (low/medium/high/critical)
- contributingFactor: the underlying factor contributing to the issues
- symptoms: list of observed symptoms
- recommendedActions: list of actions to take

Observations:
${observationsSummary}`;

          try {
            const analysis = await ctx.llm.generateStructured(prompt, AnalysisSchema, {
              system: 'You are an expert SRE. Always respond with valid JSON.',
              temperature: 0.2,
            });

            ctx.logger.info(`[structured-analysis] Severity: ${analysis.severity}`);

            const assessment: SituationAssessment = {
              source: 'structured-analysis/claude',
              findings: [
                `Contributing factor: ${analysis.contributingFactor}`,
                `Symptoms: ${analysis.symptoms.join(', ')}`,
                `Recommended actions: ${analysis.recommendedActions.join(', ')}`,
              ],
              contributingFactor: analysis.contributingFactor,
              confidence: analysis.severity === 'critical' ? 0.95 : 0.85,
            };

            return assessment;
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            ctx.logger.error(`[structured-analysis] Error: ${errorMessage}`);

            return {
              source: 'structured-analysis/error',
              findings: [`Analysis failed: ${errorMessage}`],
              confidence: 0.1,
            };
          }
        },
      }),
    },
  });

async function main() {
  console.log('=== Zup LLM Integration Demo ===\n');

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!anthropicKey && !openaiKey) {
    console.log('No LLM API key found.');
    console.log('\nTo run this demo, set one of:');
    console.log('  export ANTHROPIC_API_KEY=your-key');
    console.log('  export OPENAI_API_KEY=your-key\n');
    process.exit(1);
  }

  const llmConfig: LLMConfig = anthropicKey
    ? { provider: 'anthropic', apiKey: anthropicKey, model: 'claude-3-5-sonnet-20241022' }
    : { provider: 'openai', apiKey: openaiKey!, model: 'gpt-4' };

  console.log(`Using ${llmConfig.provider} (${llmConfig.model})\n`);

  const agent = await createAgent({
    name: 'LLM Demo Agent',
    llm: llmConfig,
    plugins: [llmOrientedPlugin()],
  });

  console.log('Running OODA loop with LLM-powered analysis...\n');

  const result = await agent.runLoop();

  console.log('\n--- Results ---\n');

  if (result.situation) {
    console.log('Situation Assessment:\n');
    for (const assessment of result.situation.assessments) {
      console.log(`Source: ${assessment.source}`);
      console.log(`Confidence: ${assessment.confidence}\n`);

      for (const finding of assessment.findings) {
        console.log(`  ${finding}\n`);
      }

      if (assessment.contributingFactor) {
        console.log(`  Contributing Factor: ${assessment.contributingFactor}\n`);
      }
    }
  }

  console.log('\nDemo complete!');
}

main().catch(console.error);
