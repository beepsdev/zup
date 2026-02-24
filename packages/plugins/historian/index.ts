/**
 * Historian Plugin
 *
 * Stores incident resolutions when Zup confidently decides what to do,
 * and uses sqlite-vec for RAG during the orient/decide phases to help
 * detect patterns and recall how similar incidents were solved.
 */

import {
  definePlugin,
  createOrienter,
  type AgentContext,
  type Observation,
  type SituationAssessment,
  type LoopResult,
  type SQLiteCapability,
} from '../../core/src/index';
import { createEmbeddingCapability, type EmbeddingCapability, type EmbeddingConfig } from '../../core/src/embedding';

export type HistorianPluginOptions = {
  minConfidence?: number;
  includeHighRisk?: boolean;
  maxSimilarIncidents?: number;
  embedding?: EmbeddingConfig;
};

export type StoredIncident = {
  id: number;
  created_at: string;
  agent_id: string;
  loop_iteration: number;
  incident_summary: string;
  contributing_factor: string | null;
  resolution_summary: string;
  decision_confidence: number;
  decision_risk: string;
  action_success: boolean;
  observations_json: string;
  situation_json: string;
  decision_json: string;
  action_results_json: string;
};

export type RetrievedIncident = StoredIncident & {
  similarity: number;
};

const INCIDENTS_TABLE = 'incidents';
const EMBEDDINGS_TABLE = 'incident_embeddings';

function generateIncidentSummary(loopResult: LoopResult): string {
  const parts: string[] = [];

  if (loopResult.situation?.summary) {
    parts.push(`Situation: ${loopResult.situation.summary}`);
  }

  if (loopResult.decision?.rationale) {
    parts.push(`Decision: ${loopResult.decision.rationale}`);
  }

  const successfulActions = loopResult.actionResults.filter(r => r.success);
  if (successfulActions.length > 0) {
    const actionSummary = successfulActions
      .map(r => r.output || r.action)
      .join('; ');
    parts.push(`Resolution: ${actionSummary}`);
  }

  return parts.join(' | ');
}

function extractContributingFactor(loopResult: LoopResult): string | null {
  if (!loopResult.situation?.assessments) {
    return null;
  }

  // Extract contributing factor from assessments
  for (const assessment of loopResult.situation.assessments) {
    if (assessment.contributingFactor) {
      return assessment.contributingFactor;
    }
  }

  return null;
}

function generateResolutionSummary(loopResult: LoopResult): string {
  const parts: string[] = [];

  if (loopResult.decision) {
    parts.push(`Action: ${loopResult.decision.action}`);
    if (loopResult.decision.rationale) {
      parts.push(`Rationale: ${loopResult.decision.rationale}`);
    }
  }

  const successfulActions = loopResult.actionResults.filter(r => r.success);
  if (successfulActions.length > 0) {
    for (const result of successfulActions) {
      if (result.output) {
        parts.push(`Output: ${result.output}`);
      }
    }
  }

  return parts.join(' | ');
}

export const historianPlugin = (options: HistorianPluginOptions = {}) => {
  const minConfidence = options.minConfidence ?? 0.75;
  const includeHighRisk = options.includeHighRisk ?? false;
  const maxSimilarIncidents = options.maxSimilarIncidents ?? 5;

  let embedding: EmbeddingCapability | undefined;
  let sqlite: SQLiteCapability | undefined;

  return definePlugin({
    id: 'historian',

    init: async (ctx: AgentContext) => {
      ctx.logger.info('[historian] Initializing historian plugin');

      if (!ctx.sqlite) {
        ctx.logger.warn('[historian] SQLite not configured, historian will be disabled');
        return;
      }

      sqlite = ctx.sqlite;

      ctx.sqlite.createTable('historian', INCIDENTS_TABLE, `
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        agent_id TEXT NOT NULL,
        loop_iteration INTEGER NOT NULL,
        incident_summary TEXT NOT NULL,
        contributing_factor TEXT,
        resolution_summary TEXT NOT NULL,
        decision_confidence REAL NOT NULL,
        decision_risk TEXT NOT NULL,
        action_success INTEGER NOT NULL,
        observations_json TEXT NOT NULL,
        situation_json TEXT,
        decision_json TEXT,
        action_results_json TEXT NOT NULL
      `);

      if (ctx.sqlite.vecEnabled) {
        const tableName = ctx.sqlite.getNamespacedTable('historian', EMBEDDINGS_TABLE);
        try {
          ctx.sqlite.db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(
              incident_id INTEGER PRIMARY KEY,
              embedding float[1536]
            )
          `);
          ctx.logger.info('[historian] Vector embeddings table created');
        } catch (err) {
          ctx.logger.warn('[historian] Failed to create vector table, RAG will use text search:', err);
        }
      }

      if (options.embedding) {
        try {
          embedding = createEmbeddingCapability(options.embedding, ctx.logger);
          ctx.logger.info('[historian] Embedding capability initialized');
        } catch (err) {
          ctx.logger.warn('[historian] Failed to initialize embedding capability:', err);
        }
      }

      return {
        context: {
          historian: {
            querySimilar: async (text: string, k: number = maxSimilarIncidents): Promise<RetrievedIncident[]> => {
              return querySimilarIncidents(ctx, text, k);
            },
            getIncidentCount: (): number => {
              return getIncidentCount(ctx);
            },
          },
        },
      };
    },

    orienters: {
      historicalContext: createOrienter({
        name: 'historical-context',
        description: 'Enrich situation analysis with similar past incidents',
        orient: async (observations: Observation[], ctx: AgentContext): Promise<SituationAssessment> => {
          if (!sqlite) {
            return {
              source: 'historian/no-db',
              findings: ['Historian database not available'],
              confidence: 0,
            };
          }

          const incidentCount = getIncidentCount(ctx);
          if (incidentCount === 0) {
            return {
              source: 'historian/no-history',
              findings: ['No historical incidents recorded yet'],
              confidence: 0,
            };
          }

          const observationsSummary = observations
            .map(obs => `[${obs.severity}] ${obs.source}: ${JSON.stringify(obs.data)}`)
            .join('\n');

          const similarIncidents = await querySimilarIncidents(ctx, observationsSummary, maxSimilarIncidents);

          if (similarIncidents.length === 0) {
            return {
              source: 'historian/no-matches',
              findings: ['No similar historical incidents found'],
              confidence: 0.3,
            };
          }

          const findings: string[] = [];
          let contributingFactorGuess: string | undefined;

          for (const incident of similarIncidents) {
            const similarity = Math.round(incident.similarity * 100);
            findings.push(
              `Similar incident (${similarity}% match): ${incident.incident_summary.substring(0, 200)}...`
            );

            if (incident.contributing_factor && !contributingFactorGuess) {
              contributingFactorGuess = incident.contributing_factor;
            }
          }

          const avgSimilarity = similarIncidents.reduce((sum, i) => sum + i.similarity, 0) / similarIncidents.length;

          return {
            source: 'historian/similar-incidents',
            findings,
            contributingFactor: contributingFactorGuess,
            confidence: Math.min(0.9, avgSimilarity),
          };
        },
      }),
    },

    onLoopComplete: async (loopResult: LoopResult, ctx: AgentContext) => {
      if (!sqlite) {
        return;
      }

      if (!loopResult.decision || loopResult.decision.action === 'no-op') {
        ctx.logger.debug('[historian] Skipping storage: no action taken');
        return;
      }

      if (loopResult.actionResults.length === 0) {
        ctx.logger.debug('[historian] Skipping storage: no action results');
        return;
      }

      const hasSuccessfulAction = loopResult.actionResults.some(r => r.success);
      if (!hasSuccessfulAction) {
        ctx.logger.debug('[historian] Skipping storage: no successful actions');
        return;
      }

      if (loopResult.decision.confidence < minConfidence) {
        ctx.logger.debug(`[historian] Skipping storage: confidence ${loopResult.decision.confidence} < ${minConfidence}`);
        return;
      }

      if (!includeHighRisk && (loopResult.decision.risk === 'high' || loopResult.decision.risk === 'critical')) {
        ctx.logger.debug(`[historian] Skipping storage: high-risk action (${loopResult.decision.risk})`);
        return;
      }

      const incidentSummary = generateIncidentSummary(loopResult);
      const contributingFactorSummary = extractContributingFactor(loopResult);
      const resolutionSummary = generateResolutionSummary(loopResult);

      const tableName = sqlite.getNamespacedTable('historian', INCIDENTS_TABLE);

      const result = sqlite.run(
        `INSERT INTO ${tableName} (
          agent_id, loop_iteration, incident_summary, contributing_factor, resolution_summary,
          decision_confidence, decision_risk, action_success,
          observations_json, situation_json, decision_json, action_results_json
        ) VALUES (
          $agent_id, $loop_iteration, $incident_summary, $contributing_factor, $resolution_summary,
          $decision_confidence, $decision_risk, $action_success,
          $observations_json, $situation_json, $decision_json, $action_results_json
        )`,
        {
          agent_id: ctx.agent.id,
          loop_iteration: ctx.loop.iteration,
          incident_summary: incidentSummary,
          contributing_factor: contributingFactorSummary,
          resolution_summary: resolutionSummary,
          decision_confidence: loopResult.decision.confidence,
          decision_risk: loopResult.decision.risk,
          action_success: hasSuccessfulAction ? 1 : 0,
          observations_json: JSON.stringify(loopResult.observations),
          situation_json: loopResult.situation ? JSON.stringify(loopResult.situation) : null,
          decision_json: JSON.stringify(loopResult.decision),
          action_results_json: JSON.stringify(loopResult.actionResults),
        }
      );

      const incidentId = result.lastInsertRowid;

      if (embedding && sqlite.vecEnabled) {
        try {
          const vector = await embedding.embed(incidentSummary);
          const embeddingsTable = sqlite.getNamespacedTable('historian', EMBEDDINGS_TABLE);

          sqlite.run(
            `INSERT INTO ${embeddingsTable} (incident_id, embedding) VALUES ($incident_id, $embedding)`,
            {
              incident_id: incidentId,
              embedding: JSON.stringify(vector),
            }
          );

          ctx.logger.info(`[historian] Stored incident #${incidentId} with embedding`);
        } catch (err) {
          ctx.logger.warn(`[historian] Failed to store embedding for incident #${incidentId}:`, err);
        }
      } else {
        ctx.logger.info(`[historian] Stored incident #${incidentId} (no embedding)`);
      }
    },
  });

  function getIncidentCount(ctx: AgentContext): number {
    if (!sqlite) {
      return 0;
    }

    const tableName = sqlite.getNamespacedTable('historian', INCIDENTS_TABLE);
    const result = sqlite.get<{ count: number }>(`SELECT COUNT(*) as count FROM ${tableName}`);
    return result?.count ?? 0;
  }

  async function querySimilarIncidents(
    ctx: AgentContext,
    queryText: string,
    k: number
  ): Promise<RetrievedIncident[]> {
    if (!sqlite) {
      return [];
    }

    const incidentsTable = sqlite.getNamespacedTable('historian', INCIDENTS_TABLE);

    if (embedding && sqlite.vecEnabled) {
      try {
        const queryVector = await embedding.embed(queryText);
        const embeddingsTable = sqlite.getNamespacedTable('historian', EMBEDDINGS_TABLE);

        const results = sqlite.query<{
          incident_id: number;
          distance: number;
        }>(
          `SELECT incident_id, distance
           FROM ${embeddingsTable}
           WHERE embedding MATCH $query
           ORDER BY distance
           LIMIT $k`,
          {
            query: JSON.stringify(queryVector),
            k,
          }
        );

        if (results.length === 0) {
          return [];
        }

        const incidentIds = results.map(r => r.incident_id);
        const distanceMap = new Map(results.map(r => [r.incident_id, r.distance]));

        const incidents = sqlite.query<StoredIncident>(
          `SELECT * FROM ${incidentsTable} WHERE id IN (${incidentIds.join(',')})`
        );

        return incidents.map(incident => ({
          ...incident,
          similarity: 1 - (distanceMap.get(incident.id) ?? 1),
        }));
      } catch (err) {
        ctx.logger.warn('[historian] Vector search failed, falling back to text search:', err);
      }
    }

    const keywords = queryText
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3)
      .slice(0, 10);

    if (keywords.length === 0) {
      return sqlite.query<StoredIncident>(
        `SELECT * FROM ${incidentsTable} ORDER BY created_at DESC LIMIT $k`,
        { k }
      ).map(incident => ({ ...incident, similarity: 0.5 }));
    }

    const likeConditions = keywords.map((_, i) => `incident_summary LIKE $kw${i}`).join(' OR ');
    const params: Record<string, string | number> = { k };
    keywords.forEach((kw, i) => {
      params[`kw${i}`] = `%${kw}%`;
    });

    const incidents = sqlite.query<StoredIncident>(
      `SELECT * FROM ${incidentsTable}
       WHERE ${likeConditions}
       ORDER BY created_at DESC
       LIMIT $k`,
      params
    );

    return incidents.map(incident => {
      const summaryLower = incident.incident_summary.toLowerCase();
      const matchCount = keywords.filter(kw => summaryLower.includes(kw)).length;
      const similarity = matchCount / keywords.length;
      return { ...incident, similarity };
    });
  }
};
