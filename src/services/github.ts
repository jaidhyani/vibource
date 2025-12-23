import type { Commit, FileChange, GitHubCommitResponse, RepoInfo } from '../types';

const GITHUB_API_BASE = 'https://api.github.com';

export function parseRepoUrl(url: string): RepoInfo | null {
  // Handle various GitHub URL formats
  const patterns = [
    /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+))?$/,
    /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/commit\/([^/]+))?$/,
    /^([^/]+)\/([^/]+)$/,
  ];

  for (const pattern of patterns) {
    const match = url.trim().match(pattern);
    if (match) {
      return {
        owner: match[1],
        repo: match[2].replace(/\.git$/, ''),
        branch: match[3] || 'main',
      };
    }
  }
  return null;
}

export async function fetchCommits(
  repoInfo: RepoInfo,
  token?: string,
  maxCommits: number = 500
): Promise<Commit[]> {
  const headers: HeadersInit = {
    Accept: 'application/vnd.github.v3+json',
  };
  if (token) {
    headers.Authorization = `token ${token}`;
  }

  const commits: Commit[] = [];
  let page = 1;
  const perPage = 100;

  while (commits.length < maxCommits) {
    const url = `${GITHUB_API_BASE}/repos/${repoInfo.owner}/${repoInfo.repo}/commits?sha=${repoInfo.branch}&page=${page}&per_page=${perPage}`;

    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error('Rate limit exceeded. Please provide a GitHub token or wait.');
      }
      if (response.status === 404) {
        throw new Error('Repository not found. Check the URL and ensure the repository is public.');
      }
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data: GitHubCommitResponse[] = await response.json();

    if (data.length === 0) break;

    for (const commit of data) {
      if (commits.length >= maxCommits) break;

      commits.push({
        sha: commit.sha,
        message: commit.commit.message,
        author: {
          name: commit.commit.author.name,
          email: commit.commit.author.email,
          login: commit.author?.login,
          avatarUrl: commit.author?.avatar_url,
          date: commit.commit.author.date,
        },
        files: [], // Will be fetched separately for detailed view
      });
    }

    page++;

    // Small delay between pages
    if (commits.length < maxCommits) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  return commits.reverse(); // Oldest first
}

export async function fetchCommitDetails(
  repoInfo: RepoInfo,
  sha: string,
  token?: string
): Promise<FileChange[]> {
  const headers: HeadersInit = {
    Accept: 'application/vnd.github.v3+json',
  };
  if (token) {
    headers.Authorization = `token ${token}`;
  }

  const url = `${GITHUB_API_BASE}/repos/${repoInfo.owner}/${repoInfo.repo}/commits/${sha}`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    return [];
  }

  const data: GitHubCommitResponse = await response.json();

  return (data.files || []).map(file => ({
    filename: file.filename,
    status: file.status as FileChange['status'],
    additions: file.additions,
    deletions: file.deletions,
    previousFilename: file.previous_filename,
  }));
}

export async function fetchCommitsWithFiles(
  repoInfo: RepoInfo,
  token?: string,
  maxCommits: number = 200,
  onProgress?: (loaded: number, total: number) => void
): Promise<Commit[]> {
  const commits = await fetchCommits(repoInfo, token, maxCommits);
  const total = commits.length;

  // Fetch file details in parallel batches for speed
  const BATCH_SIZE = 10;
  let completed = 0;

  for (let i = 0; i < commits.length; i += BATCH_SIZE) {
    const batch = commits.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(commit => fetchCommitDetails(repoInfo, commit.sha, token))
    );

    results.forEach((files, idx) => {
      commits[i + idx].files = files;
    });

    completed += batch.length;
    onProgress?.(completed, total);

    // Small delay between batches to avoid rate limits
    if (i + BATCH_SIZE < commits.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return commits;
}

export async function getDefaultBranch(
  repoInfo: RepoInfo,
  token?: string
): Promise<string> {
  const headers: HeadersInit = {
    Accept: 'application/vnd.github.v3+json',
  };
  if (token) {
    headers.Authorization = `token ${token}`;
  }

  const url = `${GITHUB_API_BASE}/repos/${repoInfo.owner}/${repoInfo.repo}`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    return 'main';
  }

  const data = await response.json();
  return data.default_branch || 'main';
}
