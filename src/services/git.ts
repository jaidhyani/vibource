import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import LightningFS from '@isomorphic-git/lightning-fs';
import type { Commit, FileChange, RepoInfo } from '../types';

const CORS_PROXY = 'https://cors.isomorphic-git.org';

let fs: LightningFS;
let currentRepo: string | null = null;
let repoDir: string | null = null;

function getFs(repoId: string): LightningFS {
  if (currentRepo !== repoId) {
    fs = new LightningFS(repoId, { wipe: true });
    currentRepo = repoId;
    repoDir = `/${repoId}`;
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

// Tree cache for diff computation
const treeCache = new Map<string, Map<string, string>>();

// Background diff computation state
let diffComputationAbort: (() => void) | null = null;

export async function fetchCommitsWithFiles(
  repoInfo: RepoInfo,
  _token?: string,
  maxCommits: number = 200,
  onProgress?: (loaded: number, total: number) => void
): Promise<Commit[]> {
  // Abort any previous background computation
  if (diffComputationAbort) {
    diffComputationAbort();
    diffComputationAbort = null;
  }

  const repoId = `${repoInfo.owner}-${repoInfo.repo}`;
  const lfs = getFs(repoId);
  const dir = repoDir!;
  const repoUrl = `https://github.com/${repoInfo.owner}/${repoInfo.repo}.git`;

  treeCache.clear();
  onProgress?.(0, 100);

  // Clone the repository
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
      noCheckout: true,
      onProgress: (event) => {
        if (event.total && event.phase === 'Receiving objects') {
          onProgress?.(Math.floor((event.loaded / event.total) * 90), 100);
        }
      },
    });
  } catch {
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
        noCheckout: true,
        onProgress: (event) => {
          if (event.total && event.phase === 'Receiving objects') {
            onProgress?.(Math.floor((event.loaded / event.total) * 90), 100);
          }
        },
      });
    } else {
      throw new Error('Failed to clone repository');
    }
  }

  onProgress?.(95, 100);

  // Get commit log instantly
  const log = await git.log({ fs: lfs, dir, depth: maxCommits });

  // Build commits (oldest first) with empty files - will be filled in background
  const commits: Commit[] = [...log].reverse().map(entry => ({
    sha: entry.oid,
    message: entry.commit.message,
    author: {
      name: entry.commit.author.name,
      email: entry.commit.author.email,
      date: new Date(entry.commit.author.timestamp * 1000).toISOString(),
    },
    files: [],
  }));

  onProgress?.(100, 100);

  // Start background diff computation
  startBackgroundDiffComputation(lfs, dir, commits);

  return commits;
}

async function startBackgroundDiffComputation(
  lfs: LightningFS,
  dir: string,
  commits: Commit[]
): Promise<void> {
  let aborted = false;
  diffComputationAbort = () => { aborted = true; };

  let previousTree = new Map<string, string>();

  for (let i = 0; i < commits.length; i++) {
    if (aborted) break;

    const commit = commits[i];

    try {
      // Get tree OID for this commit
      const { commit: commitObj } = await git.readCommit({ fs: lfs, dir, oid: commit.sha });
      const treeOid = commitObj.tree;

      // Get current tree (cached if possible)
      let currentTree = treeCache.get(treeOid);
      if (!currentTree) {
        currentTree = await walkTree(lfs, dir, treeOid);
        treeCache.set(treeOid, currentTree);
      }

      // Compute diff
      const files = diffTrees(previousTree, currentTree);

      // Update commit in place (reactive update for UI)
      commit.files = files;

      previousTree = currentTree;
    } catch {
      // Skip commits we can't process
    }

    // Yield to UI every 5 commits
    if (i % 5 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}

async function walkTree(
  lfs: LightningFS,
  dir: string,
  treeOid: string
): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  async function walk(oid: string, basePath: string): Promise<void> {
    try {
      const { tree } = await git.readTree({ fs: lfs, dir, oid });
      const subtrees: Promise<void>[] = [];

      for (const entry of tree) {
        const fullPath = basePath ? `${basePath}/${entry.path}` : entry.path;
        if (entry.type === 'blob') {
          files.set(fullPath, entry.oid);
        } else if (entry.type === 'tree') {
          subtrees.push(walk(entry.oid, fullPath));
        }
      }
      await Promise.all(subtrees);
    } catch {
      // ignore
    }
  }

  await walk(treeOid, '');
  return files;
}

function diffTrees(oldTree: Map<string, string>, newTree: Map<string, string>): FileChange[] {
  const changes: FileChange[] = [];

  for (const [path, oid] of newTree) {
    const oldOid = oldTree.get(path);
    if (!oldOid) {
      changes.push({ filename: path, status: 'added', additions: 0, deletions: 0 });
    } else if (oldOid !== oid) {
      changes.push({ filename: path, status: 'modified', additions: 0, deletions: 0 });
    }
  }

  for (const [path] of oldTree) {
    if (!newTree.has(path)) {
      changes.push({ filename: path, status: 'removed', additions: 0, deletions: 0 });
    }
  }

  return changes;
}

export async function getDefaultBranch(repoInfo: RepoInfo): Promise<string> {
  return repoInfo.branch || 'main';
}
