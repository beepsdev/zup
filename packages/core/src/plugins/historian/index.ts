/**
 * Historian Plugin
 *
 * File-based incident memory. When the agent successfully resolves an
 * incident, the historian writes a markdown playbook describing what
 * happened, what caused it, and what fixed it — into a directory of plain
 * .md files that humans can read, edit, delete, and commit to git.
 *
 * Recorded incidents flow through the existing playbook pipeline: on later
 * loops, files whose trigger keywords/sources match the current observations
 * are injected into LLM context (e.g. by the investigation-orienter). The
 * bundled historicalContext orienter also surfaces matching incidents as
 * findings, so retrieval works without any other plugin installed.
 *
 * No SQLite, no embeddings — matching relies on generous trigger keywords
 * generated at write time (by the LLM when available).
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { definePlugin, createOrienter } from '../../plugin';
import { parsePlaybook, loadPlaybooksFromDir, matchPlaybooks } from '../../playbook';
import type { Playbook } from '../../playbook';
import type {
  AgentContext,
  LoopResult,
  Observation,
  SituationAssessment,
} from '../../types/index';
import type { HistorianOptions, IncidentNarrative, IncidentRecord } from './types';

const DEFAULT_DIR = './playbooks/incidents';
const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_MAX_INCIDENTS = 200;
const DEFAULT_MAX_SIMILAR = 5;
const MAX_KEYWORDS = 15;
/** Curated runbooks (default priority 0) outrank auto-recorded incidents. */
const INCIDENT_PRIORITY = -10;

const NarrativeSchema = z.object({
  description: z.string(),
  keywords: z.array(z.string()).min(3).max(MAX_KEYWORDS),
  lesson: z.string(),
});

export const historianPlugin = (options: HistorianOptions = {}) => {
  const dir = options.dir ?? DEFAULT_DIR;
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const includeHighRisk = options.includeHighRisk ?? false;
  const useLLM = options.useLLM ?? true;
  const maxIncidents = options.maxIncidents ?? DEFAULT_MAX_INCIDENTS;
  const maxSimilarIncidents = options.maxSimilarIncidents ?? DEFAULT_MAX_SIMILAR;

  const plugin = definePlugin({
    id: 'historian',

    init: async (ctx: AgentContext) => {
      await mkdir(dir, { recursive: true });

      const loaded = await loadPlaybooksFromDir(dir, ctx.logger);
      // Filenames embed the incident timestamp, so sorting by sourcePath
      // descending keeps the newest incidents when over the cap.
      loaded.sort((a, b) => (b.sourcePath ?? '').localeCompare(a.sourcePath ?? ''));
      const kept = loaded.slice(0, maxIncidents);
      if (loaded.length > kept.length) {
        ctx.logger.warn(
          `[historian] ${loaded.length} incident files in ${dir}, loading newest ${kept.length} (maxIncidents)`
        );
      }

      // Collected by the plugin-playbook mechanism after all inits run.
      plugin.playbooks = kept;

      ctx.logger.info(`[historian] Loaded ${kept.length} recorded incident(s) from ${dir}`);
    },

    orienters: {
      historicalContext: createOrienter({
        name: 'historical-context',
        description: 'Surface similar past incidents as findings',
        orient: async (observations: Observation[], ctx: AgentContext): Promise<SituationAssessment> => {
          const incidents = ctx.playbooks.filter(isIncident);

          if (incidents.length === 0) {
            return {
              source: 'historian/no-history',
              findings: ['No past incidents on record'],
              confidence: 0,
            };
          }

          const matched = matchPlaybooks(incidents, observations, 'orient')
            .slice(0, maxSimilarIncidents);

          if (matched.length === 0) {
            return {
              source: 'historian/no-matches',
              findings: ['No similar past incidents found'],
              confidence: 0.3,
            };
          }

          return {
            source: 'historian/similar-incidents',
            findings: matched.map(pb => {
              const lesson = extractLesson(pb.content);
              return `Similar past incident: ${pb.description}${lesson ? ` Lesson: ${lesson}` : ''}`;
            }),
            confidence: 0.7,
          };
        },
      }),
    },

    onLoopComplete: async (loopResult: LoopResult, ctx: AgentContext) => {
      if (!loopResult.decision || loopResult.decision.action === 'no-op') {
        return;
      }

      if (!loopResult.actionResults.some(r => r.success)) {
        ctx.logger.debug('[historian] Skipping record: no successful actions');
        return;
      }

      if (loopResult.decision.confidence < minConfidence) {
        ctx.logger.debug(
          `[historian] Skipping record: confidence ${loopResult.decision.confidence} < ${minConfidence}`
        );
        return;
      }

      const risk = loopResult.decision.risk;
      if (!includeHighRisk && (risk === 'high' || risk === 'critical')) {
        ctx.logger.debug(`[historian] Skipping record: ${risk}-risk action`);
        return;
      }

      const date = new Date();
      const record: IncidentRecord = {
        id: incidentId(loopResult.decision.action, date),
        narrative: await buildNarrative(loopResult, ctx, useLLM),
        sources: uniqueSources(loopResult),
        loopResult,
        date,
      };

      const markdown = renderIncidentMarkdown(record);
      const filePath = join(dir, `${record.id}.md`);

      // Round-trip through the real parser before writing, so a serialization
      // bug fails loudly here instead of producing files the loader skips.
      const playbook = parsePlaybook(markdown, {
        source: 'filesystem',
        sourcePath: filePath,
        pluginId: 'historian',
      });

      await Bun.write(filePath, markdown);

      // Make the incident matchable immediately, without an agent restart.
      ctx.playbooks.push(playbook);

      ctx.logger.info(`[historian] Recorded incident: ${record.narrative.description} -> ${filePath}`);
    },
  });

  return plugin;
};

function isIncident(playbook: Playbook): boolean {
  return playbook.pluginId === 'historian' || playbook.id.startsWith('incident-');
}

/** Pull the text of the "## Lesson" section out of an incident body. */
function extractLesson(content: string): string | undefined {
  const match = content.match(/## Lesson\s*\n+([^#]*)/);
  return match ? singleLine(match[1]!) || undefined : undefined;
}

/** Assessments produced by the historian itself — excluded from recorded narratives. */
function externalAssessments(loopResult: LoopResult): SituationAssessment[] {
  return loopResult.situation?.assessments?.filter(a => !a.source.startsWith('historian/')) ?? [];
}

async function buildNarrative(
  loopResult: LoopResult,
  ctx: AgentContext,
  useLLM: boolean
): Promise<IncidentNarrative> {
  if (useLLM && ctx.llm) {
    try {
      const narrative = await ctx.llm.generateStructured(llmPrompt(loopResult), NarrativeSchema);
      return {
        description: singleLine(narrative.description),
        keywords: sanitizeKeywords(narrative.keywords),
        lesson: narrative.lesson.trim(),
      };
    } catch (error) {
      ctx.logger.warn('[historian] LLM narrative generation failed, using fallback:', error);
    }
  }

  return fallbackNarrative(loopResult);
}

function llmPrompt(loopResult: LoopResult): string {
  const { situation, decision, actionResults } = loopResult;
  const assessments = externalAssessments(loopResult);
  return [
    'An automated reliability agent just resolved a production incident. Write a record of it for future incident response.',
    '',
    `Situation: ${situation?.summary ?? 'unknown'}`,
    `Findings: ${assessments.flatMap(a => a.findings).join('; ') || 'none'}`,
    `Contributing factor: ${assessments.map(a => a.contributingFactor).filter(Boolean).join('; ') || 'unknown'}`,
    `Resolution action: ${decision?.action} (rationale: ${decision?.rationale})`,
    `Outcome: ${actionResults.map(r => `${r.action}: ${r.success ? 'succeeded' : `failed (${r.error})`}`).join('; ')}`,
    '',
    'Return:',
    '- description: one line, what broke and what fixed it',
    `- keywords: 5-${MAX_KEYWORDS} generous lowercase trigger terms a similar future incident would contain (include synonyms, e.g. both "5xx" and "error rate"; single words or short phrases; no commas inside a keyword)`,
    '- lesson: 1-3 sentences a future investigation should know before acting',
  ].join('\n');
}

function fallbackNarrative(loopResult: LoopResult): IncidentNarrative {
  const { situation, decision, observations } = loopResult;
  const assessments = externalAssessments(loopResult);
  // Without external orienters the situation summary is placeholder text
  // (or the historian's own findings) — the decision rationale describes
  // the incident better in that case.
  const summary = assessments.length > 0 && situation?.summary
    ? situation.summary
    : decision?.rationale ?? situation?.summary ?? 'Incident';
  const description = singleLine(`${summary} — resolved by ${decision?.action}`);

  // Mine observation data values (not keys — keys like "status" appear in
  // every observation and would make the incident match everything), since
  // observation text is what the matcher checks future keywords against.
  const text = [
    summary,
    ...assessments.flatMap(a => a.findings),
    ...assessments.map(a => a.contributingFactor).filter((f): f is string => !!f),
    ...observations.flatMap(o => [...o.source.split(/[/:]/), ...stringValues(o.data)]),
  ].join(' ');

  const keywords = sanitizeKeywords([
    ...decision!.action.split(/[:\-_]/),
    ...extractKeywords(text),
  ]);

  const lesson = singleLine(
    `Resolved by ${decision?.action}: ${decision?.rationale ?? 'no rationale recorded'}`
  );

  return { description, keywords, lesson };
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'was', 'are', 'not', 'has', 'had', 'its',
  'this', 'that', 'with', 'from', 'have', 'been', 'were', 'when', 'then',
  'than', 'them', 'they', 'their', 'there', 'would', 'could', 'should',
  'after', 'before', 'because', 'found', 'into', 'over', 'under', 'while',
]);

function extractKeywords(text: string): string[] {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word);
}

/** Recursively collect string values from observation data. */
function stringValues(data: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(data);
  return out;
}

/** Lowercase, strip characters that would break the inline-array frontmatter, dedupe, cap. */
function sanitizeKeywords(keywords: string[]): string[] {
  const cleaned = keywords
    .map(kw => kw.toLowerCase().replace(/[,[\]"'\n]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(kw => kw.length >= 2);
  return Array.from(new Set(cleaned)).slice(0, MAX_KEYWORDS);
}

function uniqueSources(loopResult: LoopResult): string[] {
  return Array.from(new Set(loopResult.observations.map(o => o.source))).slice(0, 8);
}

function incidentId(action: string, date: Date): string {
  const stamp = date.toISOString().replace(/[-:T]/g, '').slice(0, 14); // yyyymmddhhmmss
  const slug = action.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `incident-${stamp}-${slug}`;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function renderIncidentMarkdown(record: IncidentRecord): string {
  const { narrative, sources, loopResult, date } = record;
  const { decision, actionResults } = loopResult;

  const assessments = externalAssessments(loopResult);
  const findings = assessments.flatMap(a => a.findings);
  const factors = assessments
    .map(a => a.contributingFactor)
    .filter((f): f is string => !!f);

  const lines = [
    '---',
    `name: ${singleLine(narrative.description).slice(0, 80)}`,
    `description: ${singleLine(narrative.description)}`,
    'trigger:',
    `  keywords: [${narrative.keywords.join(', ')}]`,
    ...(sources.length > 0 ? [`  sources: [${sources.join(', ')}]`] : []),
    `priority: ${INCIDENT_PRIORITY}`,
    `recordedBy: historian`,
    `recordedAt: ${date.toISOString()}`,
    `resolvedBy: ${decision?.action}`,
    `confidence: ${decision?.confidence}`,
    ...(decision?.risk ? [`risk: ${decision.risk}`] : []),
    '---',
    '',
    `# ${singleLine(narrative.description)}`,
    '',
    '## What happened',
    '',
    // situation.summary includes the historian's own orienter findings, so
    // use the narrative description as the incident statement instead.
    singleLine(narrative.description),
    ...(findings.length > 0 ? ['', ...findings.map(f => `- ${singleLine(f)}`)] : []),
    ...(factors.length > 0
      ? ['', '## Contributing factor', '', ...factors.map(f => `- ${singleLine(f)}`)]
      : []),
    '',
    '## Resolution',
    '',
    `Action \`${decision?.action}\` (confidence ${decision?.confidence}, risk ${decision?.risk ?? 'unknown'}).`,
    `Rationale: ${singleLine(decision?.rationale ?? 'not recorded')}`,
    '',
    ...actionResults.map(r =>
      `- \`${r.action}\`: ${r.success ? `succeeded in ${r.duration}ms` : `failed (${singleLine(r.error ?? 'unknown error')})`}`
    ),
    '',
    '## Lesson',
    '',
    narrative.lesson,
    '',
  ];

  return lines.join('\n');
}
