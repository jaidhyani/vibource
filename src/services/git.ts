import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import LightningFS from '@isomorphic-git/lightning-fs';
import type { Commit, FileChange, RepoInfo } from '../types';

const CORS_PROXY = 'https://cors.isomorphic-git.org';

// Create a new filesystem for each repo
let fs: LightningFS;
let currentRepo: string | null = null;

function getFs(repoId: string): LightningFS {
  if (currentRepo !== repoId) {
    fs = new LightningFS(repoId, { wipe: true });
    currentRepo = repoId;
  }
  return fs;
}

export function parseRepoUrl(url: string): RepoInfo | null {
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

export async function cloneAndGetCommits(
  repoInfo: RepoInfo,
  maxCommits: number = 200,
  onProgress?: (phase: string, loaded: number, total: number) => void
): Promise<Commit[]> {
  const repoId = `${repoInfo.owner}-${repoInfo.repo}`;
  const lfs = getFs(repoId);
  const dir = `/${repoId}`;
  const repoUrl = `https://github.com/${repoInfo.owner}/${repoInfo.repo}.git`;

  // Clone the repository
  onProgress?.('Cloning repository...', 0, 100);

  try {
    await git.clone({
      fs: lfs,
      http,
      dir,
      url: repoUrl,
      corsProxy: CORS_PROXY,
      ref: repoInfo.branch,
      singleBranch: true,
      depth: maxCommits + 1,
      onProgress: (event) => {
        if (event.total) {
          onProgress?.('Cloning...', event.loaded, event.total);
        }
      },
    });
  } catch {
    // Try with 'master' if 'main' fails
    if (repoInfo.branch === 'main') {
      repoInfo.branch = 'master';
      await git.clone({
        fs: lfs,
        http,
        dir,
        url: repoUrl,
        corsProxy: CORS_PROXY,
        ref: 'master',
        singleBranch: true,
        depth: maxCommits + 1,
        onProgress: (event) => {
          if (event.total) {
            onProgress?.('Cloning...', event.loaded, event.total);
          }
        },
      });
    } else {
      throw new Error('Failed to clone repository');
    }
  }

  // Get commit log
  onProgress?.('Reading commits...', 0, 100);

  const log = await git.log({
    fs: lfs,
    dir,
    depth: maxCommits,
  });

  const commits: Commit[] = [];
  const total = log.length;

  // Process commits oldest first
  const reversedLog = [...log].reverse();

  // Cache for tree files - key is tree OID, value is file map
  const treeCache = new Map<string, Map<string, string>>();

  // Pre-fetch all commit objects to get tree OIDs
  onProgress?.('Reading trees...', 0, total);
  const commitTrees: string[] = [];

  for (let i = 0; i < reversedLog.length; i++) {
    const { commit } = await git.readCommit({ fs: lfs, dir, oid: reversedLog[i].oid });
    commitTrees.push(commit.tree);
    if (i % 20 === 0) {
      onProgress?.('Reading trees...', i, total);
    }
  }

  // Build file changes incrementally
  onProgress?.('Processing changes...', 0, total);

  let previousTree = new Map<string, string>();

  for (let i = 0; i < reversedLog.length; i++) {
    const entry = reversedLog[i];
    const treeOid = commitTrees[i];

    // Get current tree (use cache if available)
    let currentTree = treeCache.get(treeOid);
    if (!currentTree) {
      currentTree = await getTreeFiles(lfs, dir, treeOid);
      treeCache.set(treeOid, currentTree);
    }

    // Compute changes
    const files = diffTrees(previousTree, currentTree);

    commits.push({
      sha: entry.oid,
      message: entry.commit.message,
      author: {
        name: entry.commit.author.name,
        email: entry.commit.author.email,
        date: new Date(entry.commit.author.timestamp * 1000).toISOString(),
      },
      files,
    });

    // Update previous tree for next iteration
    previousTree = currentTree;

    if (i % 10 === 0) {
      onProgress?.('Processing changes...', i + 1, total);
    }
  }

  onProgress?.('Done', total, total);
  return commits;
}

function diffTrees(
  oldTree: Map<string, string>,
  newTree: Map<string, string>
): FileChange[] {
  const changes: FileChange[] = [];

  // Find added and modified files
  for (const [path, oid] of newTree) {
    const oldOid = oldTree.get(path);
    if (!oldOid) {
      changes.push({ filename: path, status: 'added', additions: 0, deletions: 0 });
    } else if (oldOid !== oid) {
      changes.push({ filename: path, status: 'modified', additions: 0, deletions: 0 });
    }
  }

  // Find removed files
  for (const [path] of oldTree) {
    if (!newTree.has(path)) {
      changes.push({ filename: path, status: 'removed', additions: 0, deletions: 0 });
    }
  }

  return changes;
}

async function getTreeFiles(
  fs: LightningFS,
  dir: string,
  treeOid: string
): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  async function walkTree(oid: string, basePath: string): Promise<void> {
    try {
      const { tree } = await git.readTree({ fs, dir, oid });

      const subtrees: Promise<void>[] = [];

      for (const entry of tree) {
        const fullPath = basePath ? `${basePath}/${entry.path}` : entry.path;

        if (entry.type === 'blob') {
          files.set(fullPath, entry.oid);
        } else if (entry.type === 'tree') {
          // Walk subtrees in parallel
          subtrees.push(walkTree(entry.oid, fullPath));
        }
      }

      await Promise.all(subtrees);
    } catch {
      // Ignore tree read errors
    }
  }

  await walkTree(treeOid, '');
  return files;
}

// Keep this for backwards compatibility with the UI
export async function fetchCommitsWithFiles(
  repoInfo: RepoInfo,
  _token?: string,
  maxCommits: number = 200,
  onProgress?: (loaded: number, total: number) => void
): Promise<Commit[]> {
  return cloneAndGetCommits(repoInfo, maxCommits, (_phase, loaded, total) => {
    onProgress?.(loaded, total);
  });
}

export async function getDefaultBranch(repoInfo: RepoInfo): Promise<string> {
  return repoInfo.branch || 'main';
}
