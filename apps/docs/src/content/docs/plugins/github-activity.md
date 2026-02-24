---
title: GitHub Activity
description: Monitor GitHub repositories for recent commits and merged PRs to correlate code changes with incidents.
---

The `github-activity` plugin monitors GitHub repositories for recent commits and merged pull requests. It provides change context for incident correlation -- when an incident occurs, knowing what code changed recently is critical for root cause analysis. The plugin captures commit messages, file changes, authors, and optionally patch diffs.

## Installation

```ts
import { createAgent } from '@beepsdev/zup';
import { githubActivity } from '@beepsdev/zup/plugins/github-activity';

const agent = await createAgent({
  name: 'github-agent',
  plugins: [
    githubActivity({
      auth: { token: process.env.GITHUB_TOKEN! },
      repos: [
        {
          owner: 'myorg',
          repo: 'api-server',
          serviceName: 'API Server',
        },
      ],
    }),
  ],
});
```

## Requirements

A GitHub Personal Access Token (PAT) with `repo` scope is required. For fine-grained tokens, the `contents:read` and `pull_requests:read` permissions are sufficient.

## Plugin options

| Field | Type | Default | Description |
|---|---|---|---|
| `auth` | `GitHubAuthConfig` | -- | **Required.** Authentication configuration. |
| `auth.token` | `string` | -- | **Required.** GitHub Personal Access Token. |
| `repos` | `GitHubRepoConfig[]` | -- | **Required.** Repositories to monitor. At least one repo must be configured. |
| `pollIntervalMs` | `number` | `60000` | Polling interval in milliseconds. |
| `includePatches` | `PatchInclusionMode` | `'none'` | Whether to include diff patches with commits. `'none'` fetches only commit metadata. `'truncated'` fetches file changes with truncated patches. |
| `maxCommitsPerRepo` | `number` | `20` | Maximum commits to fetch per repository per poll. |
| `maxPRsPerRepo` | `number` | `10` | Maximum merged PRs to fetch per repository per poll. |
| `maxFilesPerCommit` | `number` | `10` | Maximum files to include per commit when patches are enabled. |
| `maxPatchBytesPerFile` | `number` | `4000` | Maximum patch content bytes per file when using `'truncated'` mode. |
| `apiBaseUrl` | `string` | `'https://api.github.com'` | GitHub API base URL. Use this for GitHub Enterprise. |

## Repository configuration

Each repository describes a GitHub repo to monitor:

| Field | Type | Required | Description |
|---|---|---|---|
| `owner` | `string` | Yes | Repository owner (user or organization). |
| `repo` | `string` | Yes | Repository name. |
| `serviceName` | `string` | Yes | Human-readable service name for SRE context. Used in observations and findings for correlation. |
| `branch` | `string` | No | Branch to monitor. If not set, the repository's default branch is used. |
| `includePRs` | `boolean` | No | Whether to include merged PRs in activity monitoring. Defaults to `true`. |

## Patch inclusion modes

The `includePatches` option controls how much detail is fetched for each commit:

| Mode | Description | API Cost |
|---|---|---|
| `'none'` | Commit metadata only (SHA, message, author, timestamp). No file changes or diffs. | 1 API call per repo |
| `'truncated'` | Fetches file changes with patch content, truncated to `maxPatchBytesPerFile` per file. Requires an additional API call per commit. | 1 + N calls per repo (N = commits) |

Use `'none'` (the default) to minimize GitHub API usage. Use `'truncated'` when you need file-level change details for more precise incident correlation.

## OODA phase contributions

### Observe: `Recent GitHub Activity`

The observer polls the GitHub API for each configured repository and produces observations:

**Commit events** (`github-activity/commit`): One observation per new commit with:
- SHA, short SHA, and commit message
- Author name, email, and GitHub username
- Repository owner, name, and service name
- Whether it is a merge commit
- Total additions, deletions, and files changed (when patches are enabled)
- File changes with status and patch content (when patches are enabled)
- Severity: `info`

**Pull request events** (`github-activity/pr`): One observation per newly merged PR with:
- PR number, title, and author username
- Base and head branches
- Merge commit SHA
- Commit count, changed files, additions, and deletions
- Labels
- Severity: `info`

**API errors** (`github-activity/error`): Emitted when the GitHub API call fails for a repository, with `warning` severity.

The observer fetches incrementally -- after the first poll, it only fetches commits created after the last fetch time.

### Orient: `GitHub Activity Analyzer`

Analyzes GitHub activity observations grouped by service:

- Reports the most recent commit with author and time since commit (for commits within the last hour)
- Flags high commit activity (more than 3 commits in the last hour)
- Reports recently merged PRs with title, additions/deletions, and time since merge
- Lists recently changed files across the last 5 commits (up to 5 files shown)
- Counts new commits and merged PRs detected in the current loop
- Reports GitHub API errors if any repos failed to fetch
- Confidence: `0.8` when activity is found, `0.5` when no activity is observed

## REST API endpoints

All endpoints require authentication by default.

### GET /github/repos

Lists all configured repositories with recent activity summary.

**Response:**

```json
{
  "repos": [
    {
      "owner": "myorg",
      "repo": "api-server",
      "serviceName": "API Server",
      "branch": "main",
      "includePRs": true,
      "recentCommitCount": 12,
      "recentPRCount": 3,
      "lastCommit": {
        "sha": "a1b2c3d",
        "message": "Fix rate limiter race condition",
        "author": "alice",
        "date": "2025-06-15T10:25:00.000Z"
      },
      "lastMergedPR": {
        "number": 247,
        "title": "Add request caching layer",
        "author": "bob",
        "mergedAt": "2025-06-15T09:30:00.000Z"
      },
      "lastFetchTime": "2025-06-15T10:30:00.000Z"
    }
  ]
}
```

### GET /github/repos/:owner/:repo/commits

Returns recent commits for a specific repository.

**Response:**

```json
{
  "repo": {
    "owner": "myorg",
    "repo": "api-server",
    "serviceName": "API Server"
  },
  "commits": [
    {
      "sha": "a1b2c3d4e5f6",
      "shortSha": "a1b2c3d",
      "message": "Fix rate limiter race condition",
      "fullMessage": "Fix rate limiter race condition\n\nThe mutex was not held during the window reset,\ncausing sporadic 429 responses.",
      "author": {
        "name": "Alice Smith",
        "email": "alice@example.com",
        "username": "alice",
        "date": "2025-06-15T10:25:00.000Z"
      },
      "url": "https://github.com/myorg/api-server/commit/a1b2c3d4e5f6",
      "isMergeCommit": false,
      "totalAdditions": 12,
      "totalDeletions": 3,
      "totalFilesChanged": 2,
      "files": [
        {
          "filename": "src/rate-limiter.ts",
          "status": "modified",
          "additions": 8,
          "deletions": 2
        }
      ]
    }
  ],
  "lastFetchTime": "2025-06-15T10:30:00.000Z"
}
```

### GET /github/repos/:owner/:repo/pulls

Returns recent merged PRs for a specific repository.

**Response:**

```json
{
  "repo": {
    "owner": "myorg",
    "repo": "api-server",
    "serviceName": "API Server"
  },
  "pullRequests": [
    {
      "number": 247,
      "title": "Add request caching layer",
      "author": "bob",
      "baseBranch": "main",
      "headBranch": "feature/caching",
      "url": "https://github.com/myorg/api-server/pull/247",
      "mergedAt": "2025-06-15T09:30:00.000Z",
      "commits": 5,
      "changedFiles": 8,
      "additions": 234,
      "deletions": 12,
      "labels": ["enhancement"],
      "mergeCommitSha": "f6e5d4c3b2a1"
    }
  ],
  "lastFetchTime": "2025-06-15T10:30:00.000Z"
}
```

### GET /github/repos/:owner/:repo/commits/:sha/diff

Fetches the full diff for a specific commit on-demand. This endpoint makes a live API call to GitHub rather than returning cached data.

**Response:**

```json
{
  "sha": "a1b2c3d4e5f6",
  "message": "Fix rate limiter race condition",
  "author": {
    "name": "Alice Smith",
    "email": "alice@example.com",
    "date": "2025-06-15T10:25:00.000Z",
    "username": "alice"
  },
  "stats": {
    "total": 15,
    "additions": 12,
    "deletions": 3
  },
  "files": [
    {
      "filename": "src/rate-limiter.ts",
      "status": "modified",
      "additions": 8,
      "deletions": 2,
      "changes": 10,
      "patch": "@@ -42,7 +42,13 @@ export class RateLimiter {\n..."
    }
  ]
}
```

## Full example

```ts
import { createAgent } from '@beepsdev/zup';
import { githubActivity } from '@beepsdev/zup/plugins/github-activity';
import { httpMonitor } from '@beepsdev/zup/plugins/http-monitor';

const agent = await createAgent({
  name: 'change-tracker',
  mode: 'continuous',
  loopInterval: 30000,
  api: {
    port: 3000,
    auth: {
      apiKeys: [{ key: process.env.API_KEY!, name: 'admin' }],
    },
  },
  plugins: [
    httpMonitor({
      endpoints: [
        { id: 'api', name: 'API', url: 'https://api.example.com/health' },
        { id: 'web', name: 'Web', url: 'https://www.example.com/health' },
      ],
    }),
    githubActivity({
      auth: { token: process.env.GITHUB_TOKEN! },
      pollIntervalMs: 60000,
      includePatches: 'truncated',
      maxCommitsPerRepo: 20,
      maxPRsPerRepo: 10,
      maxFilesPerCommit: 10,
      maxPatchBytesPerFile: 4000,
      repos: [
        {
          owner: 'myorg',
          repo: 'api-server',
          serviceName: 'API Server',
          branch: 'main',
        },
        {
          owner: 'myorg',
          repo: 'web-frontend',
          serviceName: 'Web Frontend',
          branch: 'main',
        },
        {
          owner: 'myorg',
          repo: 'shared-libs',
          serviceName: 'Shared Libraries',
          branch: 'main',
          includePRs: false,
        },
      ],
    }),
  ],
});

const server = agent.startApi({ port: 3000 });
await agent.start();
```

Three GitHub repos are monitored with truncated patch content for file-level change tracking. The `serviceName` on each repo matches the service names used by the http-monitor, so the orienter can correlate "API Server had 3 commits in the last hour" with "API Server health check is failing." The shared-libs repo skips PR monitoring since it is a dependency, not a deployed service. The on-demand diff endpoint fetches full commit patches when investigating a specific change.
