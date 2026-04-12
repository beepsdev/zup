---
title: Playbooks
description: Markdown files that feed operational knowledge into the LLM during the OODA loop.
---

Playbooks are markdown files that get injected into the LLM's context during the Orient and Decide phases. They carry the stuff your team knows but the LLM doesn't -- runbooks, incident retro learnings, system quirks.

Plugins handle how to observe and act. Playbooks tell the LLM when and why.

## Why playbooks?

Zup's plugins are deterministic TypeScript -- great for reliable execution. But the LLM driving investigation and decisions doesn't know that your `/health` endpoint returns 200 even when degraded, or that rollbacks should be avoided for deployments older than 2 hours.

Playbooks let anyone on the team write that knowledge down in plain markdown, no TypeScript required.

## Playbook format

A playbook is a `.md` file with YAML frontmatter:

```markdown
---
name: High Error Rate
description: Handling sustained high error rates across services
trigger:
  severity: warning
  keywords: [error rate, 5xx, status 500]
  sources: [http-monitor]
phases: [orient, decide]
priority: 10
---

## Investigation Guidance

When error rates spike, follow this sequence:

1. Query error logs for the affected service -- focus on the last 15 minutes
2. Check for recent deployments (< 30 min window)
3. Compare error rates before and after any deployment
4. If a deploy caused it, check the diff for bad config or missing env vars

## Decision Rules

- Error rate > 10% AND recent deploy: recommend rollback (high confidence)
- Error rate > 10% AND no recent deploy: escalate to human
- Error rate 5-10% AND recent deploy: canary analysis before rollback
- NEVER auto-rollback if the deployment is > 2 hours old

## System-Specific Context

- API gateway logs are in CloudWatch under `/prod/api-gateway`
- Deployments happen via ArgoCD -- check argo for recent syncs
- The /health endpoint returns 200 even when degraded -- check the `status` field
- Database connection pool exhaustion looks like 5xx but isn't -- check `pg_stat_activity`
```

## Frontmatter reference

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | -- | **Required.** Human-readable playbook name. |
| `description` | `string` | -- | **Required.** Short description used for logging. |
| `id` | `string` | Derived from filename | Unique identifier. Auto-generated from the filename if not set. |
| `trigger` | `object` | -- | Conditions that activate this playbook. No trigger = always active. |
| `trigger.severity` | `ObservationSeverity` | -- | Minimum observation severity to activate. |
| `trigger.keywords` | `string[]` | -- | Keywords matched against observation data (case-insensitive, any match). |
| `trigger.sources` | `string[]` | -- | Observation source prefixes to match (e.g., `http-monitor`). |
| `phases` | `('orient' \| 'decide')[]` | `['orient', 'decide']` | Which OODA phases this playbook applies to. |
| `priority` | `number` | `0` | Ordering when multiple playbooks match. Higher = injected first. |

When a trigger has multiple conditions (e.g., both `severity` and `keywords`), **all** must match (AND logic). To express OR logic, create separate playbooks.

## Loading playbooks

Playbooks come from three sources:

### 1. Filesystem directory

Drop `.md` files in a directory and point the agent at it:

```ts
const agent = await createAgent({
  playbooksDir: './playbooks',
  plugins: [
    investigationOrienter({ tools: [...] }),
  ],
});
```

```
playbooks/
  high-error-rate.md
  deployment-rollback.md
  database-saturation.md
  our-weird-legacy-api.md
```

### 2. Inline in agent options

Pass playbooks directly for programmatic use:

```ts
import { parsePlaybook } from 'zupdev';

const agent = await createAgent({
  playbooks: [
    parsePlaybook(`---
name: Always Active
description: General operational context
---
Our API rate-limits at 1000 req/s. Anything above 800 is a warning sign.`),
  ],
});
```

### 3. Plugin-bundled

Plugins can ship playbooks alongside their code:

```ts
import { definePlugin } from 'zupdev';

export const myPlugin = () => definePlugin({
  id: 'my-plugin',
  playbooks: [{
    id: 'my-plugin/cascading-failures',
    name: 'Cascading Failure Detection',
    description: 'Identifies shared dependency failures',
    phases: ['orient'],
    priority: 0,
    content: `When multiple endpoints fail simultaneously, check shared dependencies first.
A single failure is isolated -- multiple failures suggest infrastructure.`,
    source: 'plugin',
  }],
  // ... observers, actions, etc.
});
```

## How matching works

Each loop iteration, the system checks which playbooks match the current observations:

1. Phase filter -- only playbooks for the current phase are considered
2. Severity -- if set, at least one observation must meet or exceed the threshold
3. Keywords -- if set, at least one keyword must appear in any observation's data or source
4. Sources -- if set, at least one observation must come from a matching source prefix
5. No trigger at all -- the playbook always matches (catch-all)

Matched playbooks are sorted by `priority` (highest first) and appended to the LLM's system prompt.

## Integration with investigation-orienter

The main integration point is the [investigation-orienter](/docs/plugins/investigation-orienter/) plugin. When it runs a multi-turn investigation, matched playbooks are appended to the system prompt:

```
[Default investigation prompt]

---

## Operational Playbooks

The following playbooks are relevant to the current observations...

### Playbook: High Error Rate
[playbook content injected here]
```

The LLM sees your team's operational knowledge right alongside its instructions to query logs and check metrics.

Playbook injection is on by default. To disable it:

```ts
investigationOrienter({
  tools: [...],
  enablePlaybooks: false,
})
```

## Programmatic API

```ts
import {
  parsePlaybook,
  loadPlaybooksFromDir,
  matchPlaybooks,
  buildAugmentedSystemPrompt,
} from 'zupdev';
```

| Function | Description |
|---|---|
| `parsePlaybook(raw, options?)` | Parse a markdown string into a `Playbook` object. |
| `loadPlaybooksFromDir(dir, logger?)` | Load all `.md` files from a directory. Skips invalid files. |
| `matchPlaybooks(playbooks, observations, phase)` | Return playbooks that match the current observations for a phase. |
| `buildAugmentedSystemPrompt(base, playbooks)` | Append matched playbooks to a system prompt string. |

## Tips

One playbook per failure mode or system quirk. Smaller playbooks match more precisely and don't waste LLM context on irrelevant stuff.

Use triggers. A playbook about database saturation shouldn't activate for CSS deployment failures. Keywords and source filters keep the noise down.

After resolving an incident, write a playbook with what you learned. Your DBA can write one about connection pool patterns, your SRE can document deployment quirks -- it's just markdown.
