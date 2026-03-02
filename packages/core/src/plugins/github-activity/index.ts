/**
 * GitHub Activity Plugin
 *
 * Monitors GitHub repositories for recent commits and PRs to provide
 * context for incident correlation in the OODA loop.
 *
 * Features:
 * - Observer: Fetches recent commits and merged PRs
 * - Orienter: Analyzes activity and correlates with potential incidents
 * - API endpoints: List repos, get commits, get PRs, fetch diffs on-demand
 */

import {
  createObserver,
  createOrienter,
  createEndpoint,
  definePlugin,
  type AgentContext,
  type Observation,
  type SituationAssessment,
} from '../../index';
import type {
  GitHubActivityPluginOptions,
  GitHubRepoConfig,
  GitHubCommit,
  GitHubPullRequest,
  GitHubFileChange,
  GitHubApiCommit,
  GitHubApiPullRequest,
  RepoActivityState,
  GitHubRateLimit,
} from './types';

const PLUGIN_ID = 'github-activity';
const DEFAULT_API_BASE_URL = 'https://api.github.com';
const DEFAULT_POLL_INTERVAL_MS = 60000;
const DEFAULT_MAX_COMMITS_PER_REPO = 20;
const DEFAULT_MAX_PRS_PER_REPO = 10;
const DEFAULT_MAX_FILES_PER_COMMIT = 10;
const DEFAULT_MAX_PATCH_BYTES_PER_FILE = 4000;

/**
 * Get authorization header for GitHub API
 */
function getAuthHeader(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'zup-sre-agent',
  };
}

/**
 * Truncate patch content to max bytes
 */
function truncatePatch(patch: string | undefined, maxBytes: number): string | undefined {
  if (!patch) return undefined;
  if (patch.length <= maxBytes) return patch;
  return patch.slice(0, maxBytes) + '\n... (truncated)';
}

/**
 * Normalize GitHub API commit to our format
 */
function normalizeCommit(
  apiCommit: GitHubApiCommit,
  repoConfig: GitHubRepoConfig,
  options: GitHubActivityPluginOptions
): GitHubCommit {
  const includePatches = options.includePatches ?? 'none';
  const maxFilesPerCommit = options.maxFilesPerCommit ?? DEFAULT_MAX_FILES_PER_COMMIT;
  const maxPatchBytesPerFile = options.maxPatchBytesPerFile ?? DEFAULT_MAX_PATCH_BYTES_PER_FILE;

  let files: GitHubFileChange[] | undefined;
  let totalAdditions: number | undefined;
  let totalDeletions: number | undefined;
  let totalFilesChanged: number | undefined;

  if (apiCommit.files) {
    totalFilesChanged = apiCommit.files.length;
    totalAdditions = apiCommit.stats?.additions ?? apiCommit.files.reduce((sum, f) => sum + f.additions, 0);
    totalDeletions = apiCommit.stats?.deletions ?? apiCommit.files.reduce((sum, f) => sum + f.deletions, 0);

    files = apiCommit.files.slice(0, maxFilesPerCommit).map((f) => ({
      filename: f.filename,
      status: f.status as GitHubFileChange['status'],
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      previousFilename: f.previous_filename,
      patch: includePatches === 'truncated' ? truncatePatch(f.patch, maxPatchBytesPerFile) : undefined,
    }));
  }

  return {
    sha: apiCommit.sha,
    shortSha: apiCommit.sha.slice(0, 7),
    message: apiCommit.commit.message,
    messageHeadline: apiCommit.commit.message.split('\n')[0] ?? '',
    owner: repoConfig.owner,
    repo: repoConfig.repo,
    serviceName: repoConfig.serviceName,
    author: {
      name: apiCommit.commit.author.name,
      email: apiCommit.commit.author.email,
      date: new Date(apiCommit.commit.author.date),
      username: apiCommit.author?.login,
    },
    committer: {
      name: apiCommit.commit.committer.name,
      email: apiCommit.commit.committer.email,
      date: new Date(apiCommit.commit.committer.date),
      username: apiCommit.committer?.login,
    },
    url: apiCommit.html_url,
    files,
    totalAdditions,
    totalDeletions,
    totalFilesChanged,
    parents: apiCommit.parents.map((p) => p.sha),
    isMergeCommit: apiCommit.parents.length > 1,
  };
}

/**
 * Normalize GitHub API PR to our format
 */
function normalizePR(apiPR: GitHubApiPullRequest, repoConfig: GitHubRepoConfig): GitHubPullRequest {
  return {
    number: apiPR.number,
    title: apiPR.title,
    body: apiPR.body ?? undefined,
    state: apiPR.state as GitHubPullRequest['state'],
    merged: apiPR.merged,
    mergeCommitSha: apiPR.merge_commit_sha ?? undefined,
    owner: repoConfig.owner,
    repo: repoConfig.repo,
    serviceName: repoConfig.serviceName,
    author: {
      username: apiPR.user.login,
      avatarUrl: apiPR.user.avatar_url,
    },
    baseBranch: apiPR.base.ref,
    headBranch: apiPR.head.ref,
    url: apiPR.html_url,
    createdAt: new Date(apiPR.created_at),
    updatedAt: new Date(apiPR.updated_at),
    mergedAt: apiPR.merged_at ? new Date(apiPR.merged_at) : undefined,
    closedAt: apiPR.closed_at ? new Date(apiPR.closed_at) : undefined,
    commits: apiPR.commits,
    changedFiles: apiPR.changed_files,
    additions: apiPR.additions,
    deletions: apiPR.deletions,
    labels: apiPR.labels.map((l) => l.name),
  };
}

/**
 * Fetch commits from GitHub API
 */
async function fetchCommits(
  repoConfig: GitHubRepoConfig,
  options: GitHubActivityPluginOptions,
  since?: string
): Promise<{ commits: GitHubCommit[]; rateLimit?: GitHubRateLimit }> {
  const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const maxCommits = options.maxCommitsPerRepo ?? DEFAULT_MAX_COMMITS_PER_REPO;

  const params = new URLSearchParams({
    per_page: String(maxCommits),
  });

  if (repoConfig.branch) {
    params.set('sha', repoConfig.branch);
  }

  if (since) {
    params.set('since', since);
  }

  const url = `${apiBaseUrl}/repos/${repoConfig.owner}/${repoConfig.repo}/commits?${params}`;

  const response = await fetch(url, {
    headers: getAuthHeader(options.auth.token),
  });

  const rateLimit: GitHubRateLimit | undefined = response.headers.get('x-ratelimit-remaining')
    ? {
        remaining: parseInt(response.headers.get('x-ratelimit-remaining') ?? '0', 10),
        limit: parseInt(response.headers.get('x-ratelimit-limit') ?? '0', 10),
        reset: parseInt(response.headers.get('x-ratelimit-reset') ?? '0', 10),
      }
    : undefined;

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const apiCommits = (await response.json()) as GitHubApiCommit[];

  // If we need file details (for patches or file change info), fetch each commit individually
  const includePatches = options.includePatches ?? 'none';
  let commits: GitHubCommit[];

  if (includePatches !== 'none') {
    // Fetch detailed commit info for each commit (includes files with patches)
    commits = await Promise.all(
      apiCommits.slice(0, maxCommits).map(async (apiCommit) => {
        try {
          const detailUrl = `${apiBaseUrl}/repos/${repoConfig.owner}/${repoConfig.repo}/commits/${apiCommit.sha}`;
          const detailResponse = await fetch(detailUrl, {
            headers: getAuthHeader(options.auth.token),
          });

          if (detailResponse.ok) {
            const detailedCommit = (await detailResponse.json()) as GitHubApiCommit;
            return normalizeCommit(detailedCommit, repoConfig, options);
          }
        } catch {
          // Fall back to basic commit info
        }
        return normalizeCommit(apiCommit, repoConfig, options);
      })
    );
  } else {
    commits = apiCommits.map((c) => normalizeCommit(c, repoConfig, options));
  }

  return { commits, rateLimit };
}

/**
 * Fetch merged PRs from GitHub API
 */
async function fetchMergedPRs(
  repoConfig: GitHubRepoConfig,
  options: GitHubActivityPluginOptions
): Promise<{ prs: GitHubPullRequest[]; rateLimit?: GitHubRateLimit }> {
  if (repoConfig.includePRs === false) {
    return { prs: [] };
  }

  const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const maxPRs = options.maxPRsPerRepo ?? DEFAULT_MAX_PRS_PER_REPO;

  const params = new URLSearchParams({
    state: 'closed',
    sort: 'updated',
    direction: 'desc',
    per_page: String(maxPRs * 2), // Fetch more since we filter for merged only
  });

  if (repoConfig.branch) {
    params.set('base', repoConfig.branch);
  }

  const url = `${apiBaseUrl}/repos/${repoConfig.owner}/${repoConfig.repo}/pulls?${params}`;

  const response = await fetch(url, {
    headers: getAuthHeader(options.auth.token),
  });

  const rateLimit: GitHubRateLimit | undefined = response.headers.get('x-ratelimit-remaining')
    ? {
        remaining: parseInt(response.headers.get('x-ratelimit-remaining') ?? '0', 10),
        limit: parseInt(response.headers.get('x-ratelimit-limit') ?? '0', 10),
        reset: parseInt(response.headers.get('x-ratelimit-reset') ?? '0', 10),
      }
    : undefined;

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const apiPRs = (await response.json()) as GitHubApiPullRequest[];

  // Filter for merged PRs only and limit
  const mergedPRs = apiPRs.filter((pr) => pr.merged).slice(0, maxPRs);

  const prs = mergedPRs.map((pr) => normalizePR(pr, repoConfig));

  return { prs, rateLimit };
}

/**
 * Fetch a single commit with full details (including diff)
 */
async function fetchCommitDetails(
  owner: string,
  repo: string,
  sha: string,
  options: GitHubActivityPluginOptions
): Promise<GitHubApiCommit> {
  const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const url = `${apiBaseUrl}/repos/${owner}/${repo}/commits/${sha}`;

  const response = await fetch(url, {
    headers: getAuthHeader(options.auth.token),
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GitHubApiCommit;
}

/**
 * Get state key for a repo
 */
function getStateKey(repoConfig: GitHubRepoConfig): string {
  return `${PLUGIN_ID}:${repoConfig.owner}/${repoConfig.repo}`;
}

/**
 * Get or initialize repo state
 */
function getRepoState(ctx: AgentContext, repoConfig: GitHubRepoConfig): RepoActivityState {
  const key = getStateKey(repoConfig);
  const existing = ctx.state.get(key) as RepoActivityState | undefined;

  if (existing) {
    return existing;
  }

  const initial: RepoActivityState = {
    recentCommits: [],
    recentPRs: [],
  };

  ctx.state.set(key, initial);
  return initial;
}

/**
 * Update repo state
 */
function updateRepoState(ctx: AgentContext, repoConfig: GitHubRepoConfig, state: RepoActivityState): void {
  const key = getStateKey(repoConfig);
  ctx.state.set(key, state);
}

/**
 * GitHub Activity Plugin
 */
export function githubActivity(options: GitHubActivityPluginOptions) {
  // Validate options
  if (!options.auth?.token) {
    throw new Error(`[${PLUGIN_ID}] GitHub token is required`);
  }

  if (!options.repos || options.repos.length === 0) {
    throw new Error(`[${PLUGIN_ID}] At least one repository must be configured`);
  }

  console.log(`[${PLUGIN_ID}] Initializing plugin with ${options.repos.length} repo(s)`);

  return definePlugin({
    id: PLUGIN_ID,

    observers: {
      recentActivity: createObserver({
        name: 'Recent GitHub Activity',
        description: 'Fetches recent commits and merged PRs from configured repositories',
        interval: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,

        observe: async (ctx: AgentContext): Promise<Observation[]> => {
          const observations: Observation[] = [];
          let totalCommits = 0;
          let totalPRs = 0;
          let errorCount = 0;

          for (const repoConfig of options.repos) {
            try {
              const state = getRepoState(ctx, repoConfig);

              // Fetch commits (incremental if we have a last seen SHA)
              const sinceDate = state.lastFetchTime?.toISOString();
              const { commits } = await fetchCommits(repoConfig, options, sinceDate);

              // Filter to only new commits
              const newCommits = state.lastSeenCommitSha
                ? commits.filter((c) => {
                    const lastSeenIndex = commits.findIndex((commit) => commit.sha === state.lastSeenCommitSha);
                    return lastSeenIndex === -1 || commits.indexOf(c) < lastSeenIndex;
                  })
                : commits;

              // Emit observations for each new commit
              for (const commit of newCommits) {
                observations.push({
                  source: `${PLUGIN_ID}/commit`,
                  timestamp: commit.author.date,
                  type: 'event',
                  severity: 'info',
                  data: {
                    sha: commit.sha,
                    shortSha: commit.shortSha,
                    message: commit.messageHeadline,
                    fullMessage: commit.message,
                    author: commit.author.username ?? commit.author.name,
                    authorEmail: commit.author.email,
                    owner: commit.owner,
                    repo: commit.repo,
                    serviceName: commit.serviceName,
                    url: commit.url,
                    isMergeCommit: commit.isMergeCommit,
                    totalAdditions: commit.totalAdditions,
                    totalDeletions: commit.totalDeletions,
                    totalFilesChanged: commit.totalFilesChanged,
                    files: commit.files?.map((f) => ({
                      filename: f.filename,
                      status: f.status,
                      additions: f.additions,
                      deletions: f.deletions,
                      patch: f.patch,
                    })),
                  },
                });
                totalCommits++;
              }

              // Fetch merged PRs
              const { prs } = await fetchMergedPRs(repoConfig, options);

              // Filter to only new PRs (merged after last fetch)
              const newPRs = state.lastFetchTime
                ? prs.filter((pr) => pr.mergedAt && pr.mergedAt > state.lastFetchTime!)
                : prs;

              // Emit observations for each new merged PR
              for (const pr of newPRs) {
                observations.push({
                  source: `${PLUGIN_ID}/pr`,
                  timestamp: pr.mergedAt ?? pr.updatedAt,
                  type: 'event',
                  severity: 'info',
                  data: {
                    number: pr.number,
                    title: pr.title,
                    author: pr.author.username,
                    owner: pr.owner,
                    repo: pr.repo,
                    serviceName: pr.serviceName,
                    url: pr.url,
                    baseBranch: pr.baseBranch,
                    headBranch: pr.headBranch,
                    mergedAt: pr.mergedAt?.toISOString(),
                    commits: pr.commits,
                    changedFiles: pr.changedFiles,
                    additions: pr.additions,
                    deletions: pr.deletions,
                    labels: pr.labels,
                    mergeCommitSha: pr.mergeCommitSha,
                  },
                });
                totalPRs++;
              }

              // Update state
              const updatedState: RepoActivityState = {
                lastSeenCommitSha: commits[0]?.sha ?? state.lastSeenCommitSha,
                lastSeenPRNumber: prs[0]?.number ?? state.lastSeenPRNumber,
                recentCommits: commits,
                recentPRs: prs,
                lastFetchTime: new Date(),
              };

              updateRepoState(ctx, repoConfig, updatedState);
            } catch (error) {
              errorCount++;
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.error(`[${PLUGIN_ID}] Failed to fetch activity for ${repoConfig.serviceName}: ${errorMessage}`);

              observations.push({
                source: `${PLUGIN_ID}/error`,
                timestamp: new Date(),
                type: 'event',
                severity: 'warning',
                data: {
                  owner: repoConfig.owner,
                  repo: repoConfig.repo,
                  serviceName: repoConfig.serviceName,
                  error: errorMessage,
                },
              });
            }
          }

          // Log summary
          if (errorCount > 0) {
            console.log(`[${PLUGIN_ID}] Loop complete: ${errorCount} API error(s) occurred`);
          } else if (totalCommits > 0 || totalPRs > 0) {
            console.log(`[${PLUGIN_ID}] Loop complete: ${totalCommits} commit(s), ${totalPRs} PR(s) observed`);
          } else {
            console.log(`[${PLUGIN_ID}] Loop complete: no new activity`);
          }

          return observations;
        },
      }),
    },

    orienters: {
      analyzeActivity: createOrienter({
        name: 'GitHub Activity Analyzer',
        description: 'Analyzes recent GitHub activity for incident correlation',

        orient: async (observations: Observation[], ctx: AgentContext): Promise<SituationAssessment> => {
          const findings: string[] = [];

          // Get all GitHub observations
          const commitObs = observations.filter((o) => o.source === `${PLUGIN_ID}/commit`);
          const prObs = observations.filter((o) => o.source === `${PLUGIN_ID}/pr`);

          // Group by service
          const serviceActivity = new Map<
            string,
            {
              commits: Observation[];
              prs: Observation[];
              repoConfig: GitHubRepoConfig;
            }
          >();

          for (const repoConfig of options.repos) {
            const key = repoConfig.serviceName;
            if (!serviceActivity.has(key)) {
              serviceActivity.set(key, { commits: [], prs: [], repoConfig });
            }

            const activity = serviceActivity.get(key)!;
            activity.commits.push(...commitObs.filter((o) => o.data.serviceName === key));
            activity.prs.push(...prObs.filter((o) => o.data.serviceName === key));
          }

          // Generate findings per service
          for (const [serviceName, activity] of serviceActivity) {
            const { commits, prs, repoConfig } = activity;
            const state = getRepoState(ctx, repoConfig);

            // Recent commits summary
            if (state.recentCommits.length > 0) {
              const recentCommit = state.recentCommits[0];
              const timeSince = recentCommit
                ? Math.round((Date.now() - recentCommit.author.date.getTime()) / 60000)
                : null;

              if (timeSince !== null && timeSince < 60) {
                const author = recentCommit?.author.username ?? recentCommit?.author.name ?? 'unknown';
                findings.push(
                  `${serviceName}: latest commit ${timeSince}m ago by ${author} - "${recentCommit?.messageHeadline}"`
                );
              }

              // Count recent activity
              const commitsInLastHour = state.recentCommits.filter(
                (c) => Date.now() - c.author.date.getTime() < 3600000
              ).length;

              if (commitsInLastHour > 3) {
                findings.push(`${serviceName}: high commit activity (${commitsInLastHour} commits in last hour)`);
              }
            }

            // Recent PRs summary
            if (state.recentPRs.length > 0) {
              const recentPR = state.recentPRs[0];
              if (recentPR?.mergedAt) {
                const timeSince = Math.round((Date.now() - recentPR.mergedAt.getTime()) / 60000);

                if (timeSince < 60) {
                  findings.push(
                    `${serviceName}: PR #${recentPR.number} merged ${timeSince}m ago - "${recentPR.title}" (+${recentPR.additions}/-${recentPR.deletions})`
                  );
                }
              }
            }

            // Files changed (useful for correlation)
            const allChangedFiles = new Set<string>();
            for (const commit of state.recentCommits.slice(0, 5)) {
              if (commit.files) {
                for (const file of commit.files) {
                  allChangedFiles.add(file.filename);
                }
              }
            }

            if (allChangedFiles.size > 0) {
              const fileList = Array.from(allChangedFiles).slice(0, 5).join(', ');
              const moreFiles = allChangedFiles.size > 5 ? ` (+${allChangedFiles.size - 5} more)` : '';
              findings.push(`${serviceName}: recently changed files: ${fileList}${moreFiles}`);
            }

            // New observations in this loop
            if (commits.length > 0) {
              findings.push(`${serviceName}: ${commits.length} new commit(s) detected this loop`);
            }

            if (prs.length > 0) {
              findings.push(`${serviceName}: ${prs.length} new merged PR(s) detected this loop`);
            }
          }

          // Check for errors
          const errorObs = observations.filter((o) => o.source === `${PLUGIN_ID}/error`);
          if (errorObs.length > 0) {
            findings.push(`GitHub API errors: ${errorObs.length} repo(s) failed to fetch`);
          }

          return {
            source: `${PLUGIN_ID}/analyze-activity`,
            findings,
            confidence: findings.length > 0 ? 0.8 : 0.5,
          };
        },
      }),
    },

    endpoints: {
      listRepos: createEndpoint({
        method: 'GET',
        path: '/github/repos',
        description: 'List configured GitHub repositories with recent activity summary',
        auth: true,

        handler: async (ctx) => {
          const repos = options.repos.map((repoConfig) => {
            const state = getRepoState(ctx.context, repoConfig);

            return {
              owner: repoConfig.owner,
              repo: repoConfig.repo,
              serviceName: repoConfig.serviceName,
              branch: repoConfig.branch,
              includePRs: repoConfig.includePRs ?? true,
              recentCommitCount: state.recentCommits.length,
              recentPRCount: state.recentPRs.length,
              lastCommit: state.recentCommits[0]
                ? {
                    sha: state.recentCommits[0].shortSha,
                    message: state.recentCommits[0].messageHeadline,
                    author: state.recentCommits[0].author.username ?? state.recentCommits[0].author.name,
                    date: state.recentCommits[0].author.date.toISOString(),
                  }
                : null,
              lastMergedPR: state.recentPRs[0]
                ? {
                    number: state.recentPRs[0].number,
                    title: state.recentPRs[0].title,
                    author: state.recentPRs[0].author.username,
                    mergedAt: state.recentPRs[0].mergedAt?.toISOString(),
                  }
                : null,
              lastFetchTime: state.lastFetchTime?.toISOString(),
            };
          });

          return Response.json({ repos });
        },
      }),

      getRepoCommits: createEndpoint({
        method: 'GET',
        path: '/github/repos/:owner/:repo/commits',
        description: 'Get recent commits for a repository',
        auth: true,

        handler: async (ctx) => {
          const { owner, repo } = ctx.params as { owner: string; repo: string };

          const repoConfig = options.repos.find((r) => r.owner === owner && r.repo === repo);

          if (!repoConfig) {
            return Response.json({ error: 'Repository not configured' }, { status: 404 });
          }

          const state = getRepoState(ctx.context, repoConfig);

          return Response.json({
            repo: {
              owner: repoConfig.owner,
              repo: repoConfig.repo,
              serviceName: repoConfig.serviceName,
            },
            commits: state.recentCommits.map((c) => ({
              sha: c.sha,
              shortSha: c.shortSha,
              message: c.messageHeadline,
              fullMessage: c.message,
              author: {
                name: c.author.name,
                email: c.author.email,
                username: c.author.username,
                date: c.author.date.toISOString(),
              },
              url: c.url,
              isMergeCommit: c.isMergeCommit,
              totalAdditions: c.totalAdditions,
              totalDeletions: c.totalDeletions,
              totalFilesChanged: c.totalFilesChanged,
              files: c.files?.map((f) => ({
                filename: f.filename,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
              })),
            })),
            lastFetchTime: state.lastFetchTime?.toISOString(),
          });
        },
      }),

      getRepoPRs: createEndpoint({
        method: 'GET',
        path: '/github/repos/:owner/:repo/pulls',
        description: 'Get recent merged PRs for a repository',
        auth: true,

        handler: async (ctx) => {
          const { owner, repo } = ctx.params as { owner: string; repo: string };

          const repoConfig = options.repos.find((r) => r.owner === owner && r.repo === repo);

          if (!repoConfig) {
            return Response.json({ error: 'Repository not configured' }, { status: 404 });
          }

          const state = getRepoState(ctx.context, repoConfig);

          return Response.json({
            repo: {
              owner: repoConfig.owner,
              repo: repoConfig.repo,
              serviceName: repoConfig.serviceName,
            },
            pullRequests: state.recentPRs.map((pr) => ({
              number: pr.number,
              title: pr.title,
              author: pr.author.username,
              baseBranch: pr.baseBranch,
              headBranch: pr.headBranch,
              url: pr.url,
              mergedAt: pr.mergedAt?.toISOString(),
              commits: pr.commits,
              changedFiles: pr.changedFiles,
              additions: pr.additions,
              deletions: pr.deletions,
              labels: pr.labels,
              mergeCommitSha: pr.mergeCommitSha,
            })),
            lastFetchTime: state.lastFetchTime?.toISOString(),
          });
        },
      }),

      getCommitDiff: createEndpoint({
        method: 'GET',
        path: '/github/repos/:owner/:repo/commits/:sha/diff',
        description: 'Fetch full diff for a specific commit (on-demand)',
        auth: true,

        handler: async (ctx) => {
          const { owner, repo, sha } = ctx.params as { owner: string; repo: string; sha: string };

          const repoConfig = options.repos.find((r) => r.owner === owner && r.repo === repo);

          if (!repoConfig) {
            return Response.json({ error: 'Repository not configured' }, { status: 404 });
          }

          try {
            const commitDetails = await fetchCommitDetails(owner, repo, sha, options);

            return Response.json({
              sha: commitDetails.sha,
              message: commitDetails.commit.message,
              author: {
                name: commitDetails.commit.author.name,
                email: commitDetails.commit.author.email,
                date: commitDetails.commit.author.date,
                username: commitDetails.author?.login,
              },
              stats: commitDetails.stats,
              files: commitDetails.files?.map((f) => ({
                filename: f.filename,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                changes: f.changes,
                patch: f.patch,
                previousFilename: f.previous_filename,
              })),
            });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return Response.json({ error: errorMessage }, { status: 500 });
          }
        },
      }),
    },
  });
}

export default githubActivity;

// Re-export types
export * from './types';
