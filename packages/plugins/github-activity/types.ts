/**
 * GitHub Activity Plugin Types
 */

/**
 * Authentication configuration
 * Uses GitHub Personal Access Token with repo scope
 */
export type GitHubAuthConfig = {
  /** GitHub Personal Access Token */
  token: string;
};

/**
 * Repository configuration for monitoring
 */
export type GitHubRepoConfig = {
  /** Repository owner (user or organization) */
  owner: string;

  /** Repository name */
  repo: string;

  /** Human-readable service name for SRE context */
  serviceName: string;

  /** Branch to monitor (default: default branch) */
  branch?: string;

  /** Include merged PRs in activity (default: true) */
  includePRs?: boolean;
};

/**
 * Patch inclusion mode
 */
export type PatchInclusionMode = 'none' | 'truncated';

/**
 * Plugin options
 */
export type GitHubActivityPluginOptions = {
  /** Authentication configuration */
  auth: GitHubAuthConfig;

  /** Repositories to monitor */
  repos: GitHubRepoConfig[];

  /** How often to poll for new activity in ms (default: 60000) */
  pollIntervalMs?: number;

  /** Maximum commits to fetch per repo (default: 20) */
  maxCommitsPerRepo?: number;

  /** Maximum PRs to fetch per repo (default: 10) */
  maxPRsPerRepo?: number;

  /** Whether to include patch content (default: 'none') */
  includePatches?: PatchInclusionMode;

  /** Maximum files to include per commit when patches enabled (default: 10) */
  maxFilesPerCommit?: number;

  /** Maximum patch bytes per file when patches enabled (default: 4000) */
  maxPatchBytesPerFile?: number;

  /** GitHub API base URL (default: https://api.github.com) */
  apiBaseUrl?: string;
};

/**
 * Commit author information
 */
export type GitHubCommitAuthor = {
  /** Author name */
  name: string;

  /** Author email */
  email: string;

  /** Author date */
  date: Date;

  /** GitHub username if available */
  username?: string;
};

/**
 * File change information
 */
export type GitHubFileChange = {
  /** File path */
  filename: string;

  /** Change status */
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';

  /** Lines added */
  additions: number;

  /** Lines deleted */
  deletions: number;

  /** Total changes */
  changes: number;

  /** Previous filename (for renames) */
  previousFilename?: string;

  /** Patch content (if includePatches is enabled) */
  patch?: string;
};

/**
 * Normalized commit data
 */
export type GitHubCommit = {
  /** Commit SHA */
  sha: string;

  /** Short SHA (first 7 characters) */
  shortSha: string;

  /** Commit message */
  message: string;

  /** First line of commit message */
  messageHeadline: string;

  /** Repository owner */
  owner: string;

  /** Repository name */
  repo: string;

  /** Service name (human-readable) */
  serviceName: string;

  /** Author information */
  author: GitHubCommitAuthor;

  /** Committer information (may differ from author) */
  committer: GitHubCommitAuthor;

  /** Commit URL on GitHub */
  url: string;

  /** Files changed (if fetched) */
  files?: GitHubFileChange[];

  /** Total additions across all files */
  totalAdditions?: number;

  /** Total deletions across all files */
  totalDeletions?: number;

  /** Total files changed */
  totalFilesChanged?: number;

  /** Parent commit SHAs */
  parents: string[];

  /** Whether this is a merge commit */
  isMergeCommit: boolean;
};

/**
 * Pull request state
 */
export type GitHubPRState = 'open' | 'closed';

/**
 * Normalized pull request data
 */
export type GitHubPullRequest = {
  /** PR number */
  number: number;

  /** PR title */
  title: string;

  /** PR body/description */
  body?: string;

  /** PR state */
  state: GitHubPRState;

  /** Whether the PR was merged */
  merged: boolean;

  /** Merge commit SHA if merged */
  mergeCommitSha?: string;

  /** Repository owner */
  owner: string;

  /** Repository name */
  repo: string;

  /** Service name (human-readable) */
  serviceName: string;

  /** PR author */
  author: {
    username: string;
    avatarUrl?: string;
  };

  /** Base branch */
  baseBranch: string;

  /** Head branch */
  headBranch: string;

  /** PR URL on GitHub */
  url: string;

  /** Creation timestamp */
  createdAt: Date;

  /** Last update timestamp */
  updatedAt: Date;

  /** Merge timestamp if merged */
  mergedAt?: Date;

  /** Closed timestamp if closed */
  closedAt?: Date;

  /** Number of commits in the PR */
  commits: number;

  /** Number of files changed */
  changedFiles: number;

  /** Total additions */
  additions: number;

  /** Total deletions */
  deletions: number;

  /** Labels */
  labels: string[];
};

/**
 * Internal state for tracking activity per repo
 */
export type RepoActivityState = {
  /** Last seen commit SHA (for incremental fetching) */
  lastSeenCommitSha?: string;

  /** Last seen PR number (for incremental fetching) */
  lastSeenPRNumber?: number;

  /** Recent commits cache */
  recentCommits: GitHubCommit[];

  /** Recent PRs cache */
  recentPRs: GitHubPullRequest[];

  /** Last fetch timestamp */
  lastFetchTime?: Date;
};

/**
 * Raw commit response from GitHub API
 */
export type GitHubApiCommit = {
  sha: string;
  node_id: string;
  commit: {
    author: {
      name: string;
      email: string;
      date: string;
    };
    committer: {
      name: string;
      email: string;
      date: string;
    };
    message: string;
    tree: {
      sha: string;
      url: string;
    };
    url: string;
    comment_count: number;
    verification?: {
      verified: boolean;
      reason: string;
      signature?: string;
      payload?: string;
    };
  };
  url: string;
  html_url: string;
  comments_url: string;
  author?: {
    login: string;
    id: number;
    avatar_url: string;
    url: string;
    type: string;
  };
  committer?: {
    login: string;
    id: number;
    avatar_url: string;
    url: string;
    type: string;
  };
  parents: Array<{
    sha: string;
    url: string;
    html_url: string;
  }>;
  stats?: {
    total: number;
    additions: number;
    deletions: number;
  };
  files?: Array<{
    sha: string;
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    blob_url: string;
    raw_url: string;
    contents_url: string;
    patch?: string;
    previous_filename?: string;
  }>;
};

/**
 * Raw PR response from GitHub API
 */
export type GitHubApiPullRequest = {
  url: string;
  id: number;
  node_id: string;
  html_url: string;
  diff_url: string;
  patch_url: string;
  issue_url: string;
  number: number;
  state: string;
  locked: boolean;
  title: string;
  user: {
    login: string;
    id: number;
    avatar_url: string;
    url: string;
    type: string;
  };
  body?: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  merged_at?: string;
  merge_commit_sha?: string;
  assignee?: {
    login: string;
    id: number;
    avatar_url: string;
  };
  assignees?: Array<{
    login: string;
    id: number;
    avatar_url: string;
  }>;
  requested_reviewers?: Array<{
    login: string;
    id: number;
    avatar_url: string;
  }>;
  labels: Array<{
    id: number;
    node_id: string;
    url: string;
    name: string;
    description?: string;
    color: string;
    default: boolean;
  }>;
  milestone?: {
    url: string;
    html_url: string;
    id: number;
    number: number;
    title: string;
    description?: string;
    state: string;
  };
  draft: boolean;
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
  head: {
    label: string;
    ref: string;
    sha: string;
    user: {
      login: string;
      id: number;
    };
    repo?: {
      id: number;
      name: string;
      full_name: string;
      owner: {
        login: string;
        id: number;
      };
    };
  };
  base: {
    label: string;
    ref: string;
    sha: string;
    user: {
      login: string;
      id: number;
    };
    repo: {
      id: number;
      name: string;
      full_name: string;
      owner: {
        login: string;
        id: number;
      };
    };
  };
  merged: boolean;
  mergeable?: boolean;
  rebaseable?: boolean;
  mergeable_state?: string;
  merged_by?: {
    login: string;
    id: number;
    avatar_url: string;
  };
};

/**
 * GitHub API rate limit info
 */
export type GitHubRateLimit = {
  /** Requests remaining */
  remaining: number;

  /** Total limit */
  limit: number;

  /** Reset timestamp (Unix seconds) */
  reset: number;
};

/**
 * Correlation between an error and code changes
 */
export type CodeChangeCorrelation = {
  /** File path from error (e.g., stack trace) */
  errorFilePath: string;

  /** Matching commits that touched this file */
  matchingCommits: Array<{
    sha: string;
    shortSha: string;
    message: string;
    author: string;
    timestamp: Date;
    additions: number;
    deletions: number;
  }>;

  /** Matching PRs that touched this file */
  matchingPRs: Array<{
    number: number;
    title: string;
    author: string;
    mergedAt?: Date;
  }>;

  /** Confidence score (0-1) based on recency and change size */
  confidence: number;
};
