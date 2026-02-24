/**
 * GitHub Activity Plugin Tests
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createAgent } from '../../core/src/index';
import { githubActivity } from './index';
import type { GitHubApiCommit, GitHubApiPullRequest } from './types';

describe('GitHub Activity Plugin', () => {
  let mockServer: ReturnType<typeof Bun.serve>;
  let mockServerUrl: string;
  let mockCommits: GitHubApiCommit[];
  let mockPRs: GitHubApiPullRequest[];

  beforeAll(() => {
    // Default mock commits
    mockCommits = [
      {
        sha: 'abc123def456789012345678901234567890abcd',
        node_id: 'C_abc123',
        commit: {
          author: {
            name: 'Developer',
            email: 'dev@example.com',
            date: new Date(Date.now() - 600000).toISOString(), // 10 minutes ago
          },
          committer: {
            name: 'Developer',
            email: 'dev@example.com',
            date: new Date(Date.now() - 600000).toISOString(),
          },
          message: 'feat: add new feature\n\nThis is a detailed description.',
          tree: { sha: 'tree123', url: 'https://api.github.com/repos/owner/repo/git/trees/tree123' },
          url: 'https://api.github.com/repos/owner/repo/git/commits/abc123',
          comment_count: 0,
        },
        url: 'https://api.github.com/repos/owner/repo/commits/abc123',
        html_url: 'https://github.com/owner/repo/commit/abc123',
        comments_url: 'https://api.github.com/repos/owner/repo/commits/abc123/comments',
        author: {
          login: 'developer',
          id: 1,
          avatar_url: 'https://github.com/images/developer.png',
          url: 'https://api.github.com/users/developer',
          type: 'User',
        },
        committer: {
          login: 'developer',
          id: 1,
          avatar_url: 'https://github.com/images/developer.png',
          url: 'https://api.github.com/users/developer',
          type: 'User',
        },
        parents: [{ sha: 'parent123', url: '', html_url: '' }],
        stats: {
          total: 50,
          additions: 40,
          deletions: 10,
        },
        files: [
          {
            sha: 'file123',
            filename: 'src/api/handler.ts',
            status: 'modified',
            additions: 30,
            deletions: 5,
            changes: 35,
            blob_url: 'https://github.com/owner/repo/blob/abc123/src/api/handler.ts',
            raw_url: 'https://github.com/owner/repo/raw/abc123/src/api/handler.ts',
            contents_url: 'https://api.github.com/repos/owner/repo/contents/src/api/handler.ts',
            patch: '@@ -1,5 +1,10 @@\n+import { newFeature } from "./feature";\n',
          },
          {
            sha: 'file456',
            filename: 'src/utils/auth.ts',
            status: 'modified',
            additions: 10,
            deletions: 5,
            changes: 15,
            blob_url: 'https://github.com/owner/repo/blob/abc123/src/utils/auth.ts',
            raw_url: 'https://github.com/owner/repo/raw/abc123/src/utils/auth.ts',
            contents_url: 'https://api.github.com/repos/owner/repo/contents/src/utils/auth.ts',
            patch: '@@ -10,3 +10,8 @@\n+export function validateToken() {}',
          },
        ],
      },
      {
        sha: 'def456abc789012345678901234567890abcdef',
        node_id: 'C_def456',
        commit: {
          author: {
            name: 'Another Dev',
            email: 'another@example.com',
            date: new Date(Date.now() - 1200000).toISOString(), // 20 minutes ago
          },
          committer: {
            name: 'Another Dev',
            email: 'another@example.com',
            date: new Date(Date.now() - 1200000).toISOString(),
          },
          message: 'fix: bug fix in auth module',
          tree: { sha: 'tree456', url: 'https://api.github.com/repos/owner/repo/git/trees/tree456' },
          url: 'https://api.github.com/repos/owner/repo/git/commits/def456',
          comment_count: 0,
        },
        url: 'https://api.github.com/repos/owner/repo/commits/def456',
        html_url: 'https://github.com/owner/repo/commit/def456',
        comments_url: 'https://api.github.com/repos/owner/repo/commits/def456/comments',
        author: {
          login: 'anotherdev',
          id: 2,
          avatar_url: 'https://github.com/images/anotherdev.png',
          url: 'https://api.github.com/users/anotherdev',
          type: 'User',
        },
        committer: {
          login: 'anotherdev',
          id: 2,
          avatar_url: 'https://github.com/images/anotherdev.png',
          url: 'https://api.github.com/users/anotherdev',
          type: 'User',
        },
        parents: [{ sha: 'parent456', url: '', html_url: '' }],
      },
    ];

    // Default mock PRs
    mockPRs = [
      {
        url: 'https://api.github.com/repos/owner/repo/pulls/42',
        id: 42,
        node_id: 'PR_42',
        html_url: 'https://github.com/owner/repo/pull/42',
        diff_url: 'https://github.com/owner/repo/pull/42.diff',
        patch_url: 'https://github.com/owner/repo/pull/42.patch',
        issue_url: 'https://api.github.com/repos/owner/repo/issues/42',
        number: 42,
        state: 'closed',
        locked: false,
        title: 'feat: Add rate limiting',
        user: {
          login: 'developer',
          id: 1,
          avatar_url: 'https://github.com/images/developer.png',
          url: 'https://api.github.com/users/developer',
          type: 'User',
        },
        body: 'This PR adds rate limiting to the API.',
        created_at: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
        updated_at: new Date(Date.now() - 300000).toISOString(), // 5 minutes ago
        closed_at: new Date(Date.now() - 300000).toISOString(),
        merged_at: new Date(Date.now() - 300000).toISOString(), // 5 minutes ago
        merge_commit_sha: 'merge123abc',
        labels: [
          { id: 1, node_id: 'L_1', url: '', name: 'enhancement', color: '00ff00', default: false },
        ],
        draft: false,
        commits: 3,
        additions: 150,
        deletions: 20,
        changed_files: 5,
        head: {
          label: 'owner:feature-branch',
          ref: 'feature-branch',
          sha: 'head123',
          user: { login: 'owner', id: 1 },
          repo: {
            id: 1,
            name: 'repo',
            full_name: 'owner/repo',
            owner: { login: 'owner', id: 1 },
          },
        },
        base: {
          label: 'owner:main',
          ref: 'main',
          sha: 'base123',
          user: { login: 'owner', id: 1 },
          repo: {
            id: 1,
            name: 'repo',
            full_name: 'owner/repo',
            owner: { login: 'owner', id: 1 },
          },
        },
        merged: true,
        merged_by: {
          login: 'developer',
          id: 1,
          avatar_url: 'https://github.com/images/developer.png',
        },
      },
      {
        url: 'https://api.github.com/repos/owner/repo/pulls/41',
        id: 41,
        node_id: 'PR_41',
        html_url: 'https://github.com/owner/repo/pull/41',
        diff_url: 'https://github.com/owner/repo/pull/41.diff',
        patch_url: 'https://github.com/owner/repo/pull/41.patch',
        issue_url: 'https://api.github.com/repos/owner/repo/issues/41',
        number: 41,
        state: 'closed',
        locked: false,
        title: 'fix: Fix memory leak',
        user: {
          login: 'anotherdev',
          id: 2,
          avatar_url: 'https://github.com/images/anotherdev.png',
          url: 'https://api.github.com/users/anotherdev',
          type: 'User',
        },
        body: 'Fixes the memory leak in the worker pool.',
        created_at: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago
        updated_at: new Date(Date.now() - 1800000).toISOString(), // 30 minutes ago
        closed_at: new Date(Date.now() - 1800000).toISOString(),
        merged_at: new Date(Date.now() - 1800000).toISOString(), // 30 minutes ago
        merge_commit_sha: 'merge456def',
        labels: [{ id: 2, node_id: 'L_2', url: '', name: 'bug', color: 'ff0000', default: false }],
        draft: false,
        commits: 1,
        additions: 10,
        deletions: 50,
        changed_files: 2,
        head: {
          label: 'owner:fix-memory-leak',
          ref: 'fix-memory-leak',
          sha: 'head456',
          user: { login: 'owner', id: 1 },
        },
        base: {
          label: 'owner:main',
          ref: 'main',
          sha: 'base456',
          user: { login: 'owner', id: 1 },
          repo: {
            id: 1,
            name: 'repo',
            full_name: 'owner/repo',
            owner: { login: 'owner', id: 1 },
          },
        },
        merged: true,
      },
    ];

    // Create mock GitHub API server
    mockServer = Bun.serve({
      port: 0, // Random port
      fetch(req) {
        const url = new URL(req.url);

        // Check authorization
        const authHeader = req.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return new Response(JSON.stringify({ message: 'Bad credentials' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Mock commits endpoint
        if (url.pathname === '/repos/owner/repo/commits') {
          return new Response(JSON.stringify(mockCommits), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'X-RateLimit-Remaining': '4999',
              'X-RateLimit-Limit': '5000',
              'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
            },
          });
        }

        // Mock single commit endpoint (for detailed info)
        const commitMatch = url.pathname.match(/^\/repos\/owner\/repo\/commits\/([a-f0-9]+)$/);
        if (commitMatch) {
          const sha = commitMatch[1];
          const commit = mockCommits.find((c) => c.sha.startsWith(sha ?? ''));
          if (commit) {
            return new Response(JSON.stringify(commit), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({ message: 'Not Found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Mock PRs endpoint
        if (url.pathname === '/repos/owner/repo/pulls') {
          return new Response(JSON.stringify(mockPRs), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'X-RateLimit-Remaining': '4998',
              'X-RateLimit-Limit': '5000',
              'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
            },
          });
        }

        return new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    mockServerUrl = `http://localhost:${mockServer.port}`;
  });

  afterAll(() => {
    mockServer.stop();
  });

  describe('Plugin Initialization', () => {
    test('should initialize with valid configuration', async () => {
      const agent = await createAgent({
        plugins: [
          githubActivity({
            auth: { token: 'test-token' },
            repos: [
              {
                owner: 'owner',
                repo: 'repo',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const ctx = agent.getContext();
      expect(ctx).toBeDefined();
    });

    test('should throw error if no token provided', async () => {
      expect(async () => {
        await createAgent({
          plugins: [
            githubActivity({
              auth: { token: '' },
              repos: [{ owner: 'owner', repo: 'repo', serviceName: 'my-service' }],
            }),
          ],
        });
      }).toThrow('GitHub token is required');
    });

    test('should throw error if no repos configured', async () => {
      expect(async () => {
        await createAgent({
          plugins: [
            githubActivity({
              auth: { token: 'test-token' },
              repos: [],
            }),
          ],
        });
      }).toThrow('At least one repository must be configured');
    });
  });

  describe('Activity Observer', () => {
    test('should fetch and observe commits', async () => {
      const agent = await createAgent({
        plugins: [
          githubActivity({
            auth: { token: 'test-token' },
            repos: [
              {
                owner: 'owner',
                repo: 'repo',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const result = await agent.runLoop();

      expect(result.observations.length).toBeGreaterThan(0);

      const commitObs = result.observations.filter((obs) => obs.source === 'github-activity/commit');

      expect(commitObs.length).toBe(2);
    });

    test('should include commit metadata in observations', async () => {
      const agent = await createAgent({
        plugins: [
          githubActivity({
            auth: { token: 'test-token' },
            repos: [
              {
                owner: 'owner',
                repo: 'repo',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const result = await agent.runLoop();

      const commitObs = result.observations.find(
        (obs) => obs.source === 'github-activity/commit' && obs.data.shortSha === 'abc123d'
      );

      expect(commitObs).toBeDefined();
      expect(commitObs?.data.message).toBe('feat: add new feature');
      expect(commitObs?.data.author).toBe('developer');
      expect(commitObs?.data.serviceName).toBe('my-service');
    });

    test('should fetch and observe merged PRs', async () => {
      const agent = await createAgent({
        plugins: [
          githubActivity({
            auth: { token: 'test-token' },
            repos: [
              {
                owner: 'owner',
                repo: 'repo',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const result = await agent.runLoop();

      const prObs = result.observations.filter((obs) => obs.source === 'github-activity/pr');

      expect(prObs.length).toBe(2);
    });

    test('should include PR metadata in observations', async () => {
      const agent = await createAgent({
        plugins: [
          githubActivity({
            auth: { token: 'test-token' },
            repos: [
              {
                owner: 'owner',
                repo: 'repo',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const result = await agent.runLoop();

      const prObs = result.observations.find(
        (obs) => obs.source === 'github-activity/pr' && obs.data.number === 42
      );

      expect(prObs).toBeDefined();
      expect(prObs?.data.title).toBe('feat: Add rate limiting');
      expect(prObs?.data.author).toBe('developer');
      expect(prObs?.data.additions).toBe(150);
      expect(prObs?.data.deletions).toBe(20);
      expect(prObs?.data.labels).toContain('enhancement');
    });

    test('should skip PRs when includePRs is false', async () => {
      const agent = await createAgent({
        plugins: [
          githubActivity({
            auth: { token: 'test-token' },
            repos: [
              {
                owner: 'owner',
                repo: 'repo',
                serviceName: 'my-service',
                includePRs: false,
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const result = await agent.runLoop();

      const prObs = result.observations.filter((obs) => obs.source === 'github-activity/pr');

      expect(prObs.length).toBe(0);
    });

    test('should handle API errors gracefully', async () => {
      const agent = await createAgent({
        plugins: [
          githubActivity({
            auth: { token: 'invalid-token' },
            repos: [
              {
                owner: 'owner',
                repo: 'repo',
                serviceName: 'my-service',
              },
            ],
            // Use a non-existent endpoint to trigger error
            apiBaseUrl: 'http://localhost:1',
          }),
        ],
      });

      const result = await agent.runLoop();

      // Should have an error observation
      const errorObs = result.observations.find((obs) => obs.source === 'github-activity/error');

      expect(errorObs).toBeDefined();
      expect(errorObs?.severity).toBe('warning');
    });

    test('should include file changes when includePatches is truncated', async () => {
      const agent = await createAgent({
        plugins: [
          githubActivity({
            auth: { token: 'test-token' },
            repos: [
              {
                owner: 'owner',
                repo: 'repo',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
            includePatches: 'truncated',
            maxFilesPerCommit: 5,
            maxPatchBytesPerFile: 1000,
          }),
        ],
      });

      const result = await agent.runLoop();

      const commitObs = result.observations.find(
        (obs) => obs.source === 'github-activity/commit' && obs.data.shortSha === 'abc123d'
      );

      expect(commitObs).toBeDefined();
      expect(commitObs?.data.files).toBeDefined();

      const files = commitObs?.data.files as Array<{ filename: string; patch?: string }>;
      expect(files.length).toBeGreaterThan(0);
      expect(files[0]?.filename).toBe('src/api/handler.ts');
      expect(files[0]?.patch).toBeDefined();
    });
  });

  describe('Activity Analysis Orienter', () => {
    test('should analyze activity and produce findings', async () => {
      const agent = await createAgent({
        plugins: [
          githubActivity({
            auth: { token: 'test-token' },
            repos: [
              {
                owner: 'owner',
                repo: 'repo',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const result = await agent.runLoop();

      expect(result.situation).toBeDefined();
      expect(result.situation?.assessments.length).toBeGreaterThan(0);

      const githubAssessment = result.situation?.assessments.find(
        (a) => a.source === 'github-activity/analyze-activity'
      );

      expect(githubAssessment).toBeDefined();
      expect(githubAssessment?.findings.length).toBeGreaterThan(0);
      expect(githubAssessment?.findings.some((f) => f.includes('my-service'))).toBe(true);
    });

    test('should report recent commits in findings', async () => {
      const agent = await createAgent({
        plugins: [
          githubActivity({
            auth: { token: 'test-token' },
            repos: [
              {
                owner: 'owner',
                repo: 'repo',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const result = await agent.runLoop();

      const githubAssessment = result.situation?.assessments.find(
        (a) => a.source === 'github-activity/analyze-activity'
      );

      // Should mention new commits detected
      expect(githubAssessment?.findings.some((f) => f.includes('commit'))).toBe(true);
    });

    test('should report recently changed files', async () => {
      const agent = await createAgent({
        plugins: [
          githubActivity({
            auth: { token: 'test-token' },
            repos: [
              {
                owner: 'owner',
                repo: 'repo',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
            includePatches: 'truncated',
          }),
        ],
      });

      const result = await agent.runLoop();

      const githubAssessment = result.situation?.assessments.find(
        (a) => a.source === 'github-activity/analyze-activity'
      );

      // Should mention changed files
      expect(githubAssessment?.findings.some((f) => f.includes('changed files'))).toBe(true);
    });
  });

  describe('Plugin Endpoints', () => {
    let agent: Awaited<ReturnType<typeof createAgent>>;
    let apiServer: ReturnType<typeof agent.startApi>;
    const apiKey = 'test-key-123';

    beforeAll(async () => {
      agent = await createAgent({
        plugins: [
          githubActivity({
            auth: { token: 'test-token' },
            repos: [
              {
                owner: 'owner',
                repo: 'repo',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      // Run a loop to populate state
      await agent.runLoop();

      apiServer = agent.startApi({
        port: 3005,
        hostname: 'localhost',
        apiKeys: [apiKey],
      });

      // Wait for server to start
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    afterAll(() => {
      apiServer.stop();
    });

    test('GET /github/repos - should list repos', async () => {
      const response = await fetch('http://localhost:3005/api/v0/github/repos', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      expect(response.status).toBe(200);

      const data = (await response.json()) as { repos: unknown[] };
      expect(data.repos).toHaveLength(1);

      const repo = data.repos[0] as {
        owner: string;
        repo: string;
        serviceName: string;
        recentCommitCount: number;
        lastCommit: unknown;
      };
      expect(repo.owner).toBe('owner');
      expect(repo.repo).toBe('repo');
      expect(repo.serviceName).toBe('my-service');
      expect(repo.recentCommitCount).toBe(2);
      expect(repo.lastCommit).toBeDefined();
    });

    test('GET /github/repos/:owner/:repo/commits - should get repo commits', async () => {
      const response = await fetch('http://localhost:3005/api/v0/github/repos/owner/repo/commits', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      expect(response.status).toBe(200);

      const data = (await response.json()) as {
        repo: { owner: string; repo: string };
        commits: unknown[];
      };
      expect(data.repo.owner).toBe('owner');
      expect(data.repo.repo).toBe('repo');
      expect(data.commits.length).toBe(2);
    });

    test('GET /github/repos/:owner/:repo/pulls - should get repo PRs', async () => {
      const response = await fetch('http://localhost:3005/api/v0/github/repos/owner/repo/pulls', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      expect(response.status).toBe(200);

      const data = (await response.json()) as {
        repo: { owner: string; repo: string };
        pullRequests: unknown[];
      };
      expect(data.repo.owner).toBe('owner');
      expect(data.repo.repo).toBe('repo');
      expect(data.pullRequests.length).toBe(2);
    });

    test('GET /github/repos/:owner/:repo/commits/:sha/diff - should get commit diff', async () => {
      const response = await fetch(
        'http://localhost:3005/api/v0/github/repos/owner/repo/commits/abc123/diff',
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        }
      );

      expect(response.status).toBe(200);

      const data = (await response.json()) as {
        sha: string;
        message: string;
        files: Array<{ filename: string; patch?: string }>;
      };
      expect(data.sha).toBe('abc123def456789012345678901234567890abcd');
      expect(data.files).toBeDefined();
      expect(data.files.length).toBeGreaterThan(0);
      expect(data.files[0]?.patch).toBeDefined();
    });

    test('GET /github/repos/:owner/:repo/commits - should return 404 for unknown repo', async () => {
      const response = await fetch(
        'http://localhost:3005/api/v0/github/repos/unknown/unknown/commits',
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        }
      );

      expect(response.status).toBe(404);
    });

    test('should require authentication', async () => {
      const response = await fetch('http://localhost:3005/api/v0/github/repos');

      expect(response.status).toBe(401);
    });
  });
});
