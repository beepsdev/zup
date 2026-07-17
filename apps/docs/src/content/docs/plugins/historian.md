---
title: Historian
description: File-based incident memory -- record successful resolutions as markdown playbooks and recall similar past incidents.
---

The `historian` plugin gives the agent file-based incident memory. When the agent successfully resolves an incident, the historian writes a markdown playbook describing what happened, what caused it, and what fixed it -- into a directory of plain `.md` files that humans can read, edit, delete, and commit to git.

Recorded incidents flow through the normal [playbook pipeline](/docs/playbooks/): on later loops, files whose trigger keywords or sources match the current observations are injected into LLM context (e.g., by the [investigation-orienter](/docs/plugins/investigation-orienter/)). The bundled `historicalContext` orienter also surfaces matching incidents as findings, so retrieval works even without any other plugin installed.

There is no database and no embedding setup -- matching relies on generous trigger keywords generated at record time, by the LLM when one is configured.

## Installation

```ts
import { createAgent } from 'zupdev';
import { historianPlugin } from 'zupdev/plugins/historian';

const agent = await createAgent({
  name: 'my-agent',
  plugins: [
    historianPlugin({
      minConfidence: 0.75,
      maxSimilarIncidents: 5,
    }),
  ],
});
```

## Requirements

None. The plugin creates its incident directory on init and works without SQLite or an LLM.

An LLM is optional but recommended: when the agent has one configured, the historian uses it to write the incident description, trigger keywords, and lesson. Without one (or if the LLM call fails), it falls back to deterministic keyword extraction from the loop's observations and decision.

## Plugin options

| Field | Type | Default | Description |
|---|---|---|---|
| `dir` | `string` | `'./playbooks/incidents'` | Directory where incident markdown files are written and loaded from. |
| `minConfidence` | `number` | `0.7` | Only record resolutions with decision confidence at or above this threshold. |
| `includeHighRisk` | `boolean` | `false` | Whether to record incidents resolved by `high` or `critical` risk actions. Disabled by default to avoid reinforcing risky patterns. |
| `useLLM` | `boolean` | `true` | Use the agent's LLM (when configured) to write the incident narrative. Set to `false` to always use the deterministic fallback. |
| `maxIncidents` | `number` | `200` | Maximum number of existing incident files loaded at startup, newest first (filenames embed the incident timestamp). |
| `maxSimilarIncidents` | `number` | `5` | Maximum number of similar past incidents surfaced as findings by the `historicalContext` orienter each loop. |

## How it works

### Recording incidents

At the end of each OODA loop iteration (via the `onLoopComplete` hook), the historian evaluates whether the loop result should be recorded. An incident is recorded only when all of these conditions are met:

1. A decision was made (not a no-op)
2. At least one action was executed successfully
3. The decision confidence meets the `minConfidence` threshold
4. The decision risk is not `high` or `critical` (unless `includeHighRisk` is enabled)

When a loop qualifies, the historian generates a narrative (description, trigger keywords, lesson), renders it as a playbook markdown file, and writes it to `dir`. The new incident is also pushed into the agent's in-memory playbook list, so it is matchable on the very next loop -- no restart needed.

### Narrative generation

The incident's description, trigger keywords, and lesson are LLM-generated when the agent has an LLM configured (and `useLLM` is not disabled). The LLM is prompted to produce generous keywords a similar future incident would contain, including synonyms (e.g., both "5xx" and "error rate").

Without an LLM -- or if the LLM call fails -- a deterministic fallback builds the narrative from the loop itself: the description combines the situation summary (or decision rationale) with the resolving action, and keywords are mined from orienter findings, contributing factors, and observation data values.

### Incident file format

Each incident is a standard [playbook](/docs/playbooks/) with extra provenance fields in the frontmatter. A recorded incident looks like this:

```markdown
---
name: API health checks failing after deploy, resolved by restarting the service
description: API health checks failing after deploy, resolved by restarting the service
trigger:
  keywords: [health check, connection refused, 5xx, error rate, api, deploy, restart, timeout]
  sources: [http-monitor/api]
priority: -10
recordedBy: historian
recordedAt: 2026-07-17T09:14:02.511Z
resolvedBy: restart-service
confidence: 0.85
risk: medium
---

# API health checks failing after deploy, resolved by restarting the service

## What happened

API health checks failing after deploy, resolved by restarting the service

- 3 consecutive health check failures for API Server
- Connection refused on https://api.example.com/health

## Contributing factor

- Service crashed after the most recent deployment

## Resolution

Action `restart-service` (confidence 0.85, risk medium).
Rationale: Endpoint is down with connection refused; a restart strategy is configured.

- `restart-service`: succeeded in 2143ms

## Lesson

The API service does not recover from failed deploys on its own; a restart
brings it back. Check for a recent deployment before assuming infrastructure
failure.
```

The frontmatter fields:

- `name` / `description` -- the one-line incident narrative.
- `trigger.keywords` / `trigger.sources` -- what future observations are matched against. Sources are the observation sources active during the incident.
- `priority: -10` -- auto-recorded incidents sit below curated playbooks (default priority `0`), so human-written runbooks always outrank them when both match.
- `recordedBy` / `recordedAt` / `resolvedBy` / `confidence` / `risk` -- provenance: which action resolved the incident, at what confidence, and when.

Filenames follow `incident-<timestamp>-<action-slug>.md` (e.g., `incident-20260717091402-restart-service.md`), so the directory sorts chronologically.

### Retrieving incidents

Retrieval happens through two paths, both driven by standard playbook matching (trigger keywords and sources against current observations):

1. **The playbook pipeline.** Recorded incidents are loaded as playbooks at startup and matched each loop like any other playbook. When the [investigation-orienter](/docs/plugins/investigation-orienter/) runs, matched incidents are injected into its investigation context alongside your curated playbooks.

2. **The `historicalContext` orienter.** Bundled with the plugin, it surfaces up to `maxSimilarIncidents` matched incidents as findings in a `SituationAssessment` -- each finding includes the incident description and its lesson. This makes retrieval work standalone, without the investigation-orienter or any LLM.

## Auditable memory

Because incidents are plain markdown, the agent's memory is fully auditable:

- **Commit the directory to git.** The incident history travels with your repo and is diffable over time.
- **Review it in PRs.** New incidents show up as ordinary file additions.
- **Edit or delete entries the agent got wrong.** If a recorded lesson is misleading, fix the file or remove it -- the historian loads whatever is in the directory at startup.

You can also hand-tune recorded incidents: broaden the trigger keywords, sharpen the lesson, or promote a recurring incident into a curated playbook with a higher priority.

## OODA phase contributions

### Orient: `historical-context`

Matches recorded incidents against the current observations and returns findings about similar past incidents.

- **Source:** `historian/similar-incidents`
- Returns `historian/no-history` (confidence 0) if no incidents have been recorded yet
- Returns `historian/no-matches` (confidence 0.3) if no recorded incident matches

### Hook: `onLoopComplete`

Evaluates each completed loop and writes qualifying resolutions to the incident directory, making them immediately available for matching.

## Full example

```ts
import { createAgent } from 'zupdev';
import { historianPlugin } from 'zupdev/plugins/historian';
import { httpMonitor } from 'zupdev/plugins/http-monitor';

const agent = await createAgent({
  name: 'infra-agent',
  mode: 'continuous',
  loopInterval: 30000,
  llm: {
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-6',
  },
  plugins: [
    httpMonitor({
      endpoints: [
        {
          id: 'api',
          name: 'API Server',
          url: 'https://api.example.com/health',
          restartStrategy: {
            type: 'command',
            command: 'systemctl restart api-server',
          },
        },
      ],
    }),
    historianPlugin({
      dir: './playbooks/incidents',
      minConfidence: 0.8,
      includeHighRisk: false,
      maxIncidents: 200,
      maxSimilarIncidents: 3,
    }),
  ],
});

await agent.start();
```

Here the historian records an incident file whenever the agent successfully restarts the API server with sufficient confidence. On future incidents whose observations hit the recorded trigger keywords, those files are injected into the investigation context and surfaced as findings -- so the agent can recognize patterns like "the last three times this happened, a restart fixed it."
