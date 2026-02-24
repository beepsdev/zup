# GitHub Activity Plugin

A Zup plugin that monitors GitHub repositories for recent commits and merged pull requests, providing context for incident correlation in the OODA loop.

## Features

- **Commit Monitoring**: Tracks recent commits with author, message, and file change information
- **PR Tracking**: Monitors merged pull requests with metadata (additions, deletions, labels)
- **File Change Correlation**: Identifies recently changed files for incident correlation
- **On-Demand Diffs**: Fetch full commit diffs when investigating specific changes
- **Rate Limit Aware**: Tracks GitHub API rate limits to avoid throttling

## Key Differences from Vercel/Fly.io Plugins

Unlike deployment-focused plugins, the GitHub Activity plugin provides **code change context**:

- Tracks individual commits and their file changes
- Monitors merged PRs as deployment indicators
- Enables correlation between errors and recent code changes
- Supports optional patch/diff content for deeper investigation

## Installation

The plugin is included in the Zup monorepo. Import it from the plugins directory:

```typescript
import { githubActivity } from '@beepsdev/zup/plugins/github-activity';
```

## Configuration

```typescript
import { createAgent } from '@beepsdev/zup';
import { githubActivity } from '@beepsdev/zup/plugins/github-activity';

const agent = await createAgent({
  plugins: [
    githubActivity({
      auth: {
        // GitHub Personal Access Token with 'repo' scope
        token: process.env.GITHUB_TOKEN!,
      },
      repos: [
        {
          owner: 'myorg',
          repo: 'api-service',
          serviceName: 'API Service',
          branch: 'main',           // Optional: specific branch to monitor
          includePRs: true,         // Optional: include merged PRs (default: true)
        },
        {
          owner: 'myorg',
          repo: 'web-app',
          serviceName: 'Web App',
        },
      ],
      // Optional settings
      pollIntervalMs: 60000,        // How often to poll (default: 60000)
      maxCommitsPerRepo: 20,        // Max commits to fetch (default: 20)
      maxPRsPerRepo: 10,            // Max PRs to fetch (default: 10)
      includePatches: 'none',       // 'none' | 'truncated' (default: 'none')
      maxFilesPerCommit: 10,        // When patches enabled (default: 10)
      maxPatchBytesPerFile: 4000,   // When patches enabled (default: 4000)
    }),
  ],
});
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `auth.token` | `string` | Required | GitHub Personal Access Token |
| `repos` | `GitHubRepoConfig[]` | Required | Repositories to monitor |
| `pollIntervalMs` | `number` | `60000` | Polling interval in milliseconds |
| `maxCommitsPerRepo` | `number` | `20` | Maximum commits to fetch per repo |
| `maxPRsPerRepo` | `number` | `10` | Maximum PRs to fetch per repo |
| `includePatches` | `'none' \| 'truncated'` | `'none'` | Whether to include patch content |
| `maxFilesPerCommit` | `number` | `10` | Max files when patches enabled |
| `maxPatchBytesPerFile` | `number` | `4000` | Max patch size per file |
| `apiBaseUrl` | `string` | `https://api.github.com` | GitHub API base URL |

### Repository Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `owner` | `string` | Required | Repository owner (user or org) |
| `repo` | `string` | Required | Repository name |
| `serviceName` | `string` | Required | Human-readable service name |
| `branch` | `string` | Default branch | Branch to monitor |
| `includePRs` | `boolean` | `true` | Include merged PRs |

## OODA Loop Integration

### Observer: `recentActivity`

Fetches recent commits and merged PRs from configured repositories.

**Commit Observations** (`github-activity/commit`):
```typescript
{
  source: 'github-activity/commit',
  timestamp: Date,
  type: 'event',
  severity: 'info',
  data: {
    sha: string,
    shortSha: string,
    message: string,
    fullMessage: string,
    author: string,
    authorEmail: string,
    owner: string,
    repo: string,
    serviceName: string,
    url: string,
    isMergeCommit: boolean,
    totalAdditions?: number,
    totalDeletions?: number,
    totalFilesChanged?: number,
    files?: Array<{
      filename: string,
      status: string,
      additions: number,
      deletions: number,
      patch?: string,  // Only if includePatches is 'truncated'
    }>,
  },
}
```

**PR Observations** (`github-activity/pr`):
```typescript
{
  source: 'github-activity/pr',
  timestamp: Date,
  type: 'event',
  severity: 'info',
  data: {
    number: number,
    title: string,
    author: string,
    owner: string,
    repo: string,
    serviceName: string,
    url: string,
    baseBranch: string,
    headBranch: string,
    mergedAt: string,
    commits: number,
    changedFiles: number,
    additions: number,
    deletions: number,
    labels: string[],
    mergeCommitSha?: string,
  },
}
```

### Orienter: `analyzeActivity`

Analyzes recent GitHub activity and produces findings for incident correlation.

**Example Findings**:
- "API Service: latest commit 10m ago by developer - 'feat: add rate limiting'"
- "API Service: high commit activity (5 commits in last hour)"
- "API Service: PR #42 merged 5m ago - 'feat: Add rate limiting' (+150/-20)"
- "API Service: recently changed files: src/api/handler.ts, src/utils/auth.ts"
- "API Service: 3 new commit(s) detected this loop"

## API Endpoints

### GET /github/repos

List configured repositories with recent activity summary.

**Response**:
```json
{
  "repos": [
    {
      "owner": "myorg",
      "repo": "api-service",
      "serviceName": "API Service",
      "branch": "main",
      "includePRs": true,
      "recentCommitCount": 20,
      "recentPRCount": 5,
      "lastCommit": {
        "sha": "abc123d",
        "message": "feat: add new feature",
        "author": "developer",
        "date": "2024-01-15T10:30:00Z"
      },
      "lastMergedPR": {
        "number": 42,
        "title": "feat: Add rate limiting",
        "author": "developer",
        "mergedAt": "2024-01-15T10:25:00Z"
      },
      "lastFetchTime": "2024-01-15T10:35:00Z"
    }
  ]
}
```

### GET /github/repos/:owner/:repo/commits

Get recent commits for a repository.

**Response**:
```json
{
  "repo": {
    "owner": "myorg",
    "repo": "api-service",
    "serviceName": "API Service"
  },
  "commits": [
    {
      "sha": "abc123def456...",
      "shortSha": "abc123d",
      "message": "feat: add new feature",
      "fullMessage": "feat: add new feature\n\nDetailed description...",
      "author": {
        "name": "Developer",
        "email": "dev@example.com",
        "username": "developer",
        "date": "2024-01-15T10:30:00Z"
      },
      "url": "https://github.com/myorg/api-service/commit/abc123",
      "isMergeCommit": false,
      "totalAdditions": 50,
      "totalDeletions": 10,
      "totalFilesChanged": 3,
      "files": [
        {
          "filename": "src/api/handler.ts",
          "status": "modified",
          "additions": 30,
          "deletions": 5
        }
      ]
    }
  ],
  "lastFetchTime": "2024-01-15T10:35:00Z"
}
```

### GET /github/repos/:owner/:repo/pulls

Get recent merged PRs for a repository.

**Response**:
```json
{
  "repo": {
    "owner": "myorg",
    "repo": "api-service",
    "serviceName": "API Service"
  },
  "pullRequests": [
    {
      "number": 42,
      "title": "feat: Add rate limiting",
      "author": "developer",
      "baseBranch": "main",
      "headBranch": "feature-branch",
      "url": "https://github.com/myorg/api-service/pull/42",
      "mergedAt": "2024-01-15T10:25:00Z",
      "commits": 3,
      "changedFiles": 5,
      "additions": 150,
      "deletions": 20,
      "labels": ["enhancement"],
      "mergeCommitSha": "merge123abc"
    }
  ],
  "lastFetchTime": "2024-01-15T10:35:00Z"
}
```

### GET /github/repos/:owner/:repo/commits/:sha/diff

Fetch full diff for a specific commit (on-demand).

**Response**:
```json
{
  "sha": "abc123def456...",
  "message": "feat: add new feature\n\nDetailed description...",
  "author": {
    "name": "Developer",
    "email": "dev@example.com",
    "date": "2024-01-15T10:30:00Z",
    "username": "developer"
  },
  "stats": {
    "total": 50,
    "additions": 40,
    "deletions": 10
  },
  "files": [
    {
      "filename": "src/api/handler.ts",
      "status": "modified",
      "additions": 30,
      "deletions": 5,
      "changes": 35,
      "patch": "@@ -1,5 +1,10 @@\n+import { newFeature } from \"./feature\";\n..."
    }
  ]
}
```

## Incident Correlation

The plugin is designed to help correlate incidents with recent code changes:

1. **File Path Matching**: When an error occurs with a stack trace, match file paths against recently changed files
2. **Timing Correlation**: Recent commits/PRs are more likely to be related to new issues
3. **Change Size**: Large changes (+100 lines) are more likely to introduce bugs

### Example Correlation Flow

```typescript
// Error observation from another source
const errorObs = {
  source: 'error-tracker',
  data: {
    message: 'TypeError in src/api/handler.ts:42',
    stackTrace: '...',
  },
};

// GitHub activity observation
const commitObs = {
  source: 'github-activity/commit',
  data: {
    shortSha: 'abc123d',
    message: 'feat: add rate limiting',
    files: [
      { filename: 'src/api/handler.ts', additions: 50, deletions: 10 },
    ],
  },
};

// Orienter can correlate: "Error in src/api/handler.ts may be related to
// commit abc123d 'feat: add rate limiting' which modified that file 10m ago"
```

## State Management

The plugin tracks state per repository:

- `lastSeenCommitSha`: For incremental commit fetching
- `lastSeenPRNumber`: For incremental PR fetching
- `recentCommits`: Cached recent commits
- `recentPRs`: Cached recent PRs
- `lastFetchTime`: When data was last fetched

**Note**: State is currently in-memory only and won't persist across agent restarts. A future SQLite-backed StateStore will enable persistence.

## Rate Limits

GitHub's REST API has rate limits:

- **Authenticated requests**: 5,000 requests per hour
- **Unauthenticated**: 60 requests per hour (not supported by this plugin)

The plugin tracks rate limit headers and logs warnings when limits are low. To stay within limits:

- Use reasonable `pollIntervalMs` (60000ms or higher)
- Limit `maxCommitsPerRepo` and `maxPRsPerRepo`
- Set `includePatches: 'none'` unless you need diff content
- Monitor fewer repositories if hitting limits

## GitHub Token Setup

1. Go to GitHub Settings > Developer settings > Personal access tokens
2. Generate a new token (classic) with `repo` scope
3. Set the token as an environment variable:
   ```bash
   export GITHUB_TOKEN=ghp_xxxxxxxxxxxx
   ```

For GitHub Enterprise, also set `apiBaseUrl`:
```typescript
githubActivity({
  auth: { token: process.env.GITHUB_TOKEN! },
  repos: [...],
  apiBaseUrl: 'https://github.mycompany.com/api/v3',
})
```

## Example Usage

```typescript
import { createAgent } from '@beepsdev/zup';
import { githubActivity } from '@beepsdev/zup/plugins/github-activity';

const agent = await createAgent({
  name: 'SRE Agent',
  plugins: [
    githubActivity({
      auth: { token: process.env.GITHUB_TOKEN! },
      repos: [
        { owner: 'myorg', repo: 'api', serviceName: 'API' },
        { owner: 'myorg', repo: 'web', serviceName: 'Web App' },
      ],
      includePatches: 'truncated',  // Include truncated diffs
    }),
  ],
});

// Run the OODA loop
const result = await agent.runLoop();

// Check for recent activity
const commits = result.observations.filter(
  (o) => o.source === 'github-activity/commit'
);
console.log(`Found ${commits.length} recent commits`);

// Check orienter findings
const findings = result.situation?.assessments
  .find((a) => a.source === 'github-activity/analyze-activity')
  ?.findings;
console.log('Activity findings:', findings);

// Start API server for on-demand queries
const api = agent.startApi({
  port: 3000,
  apiKeys: ['your-api-key'],
});

// Fetch full diff for a specific commit
const diffResponse = await fetch(
  'http://localhost:3000/api/v0/github/repos/myorg/api/commits/abc123/diff',
  { headers: { Authorization: 'Bearer your-api-key' } }
);
const diff = await diffResponse.json();
```
