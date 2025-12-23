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

let diffComputationAbort: (() => void) | null = null;

export async function fetchCommitsWithFiles(
  repoInfo: RepoInfo,
  maxCommits: number = 1000,
  onProgress?: (phase: string, loaded: number, total: number | null) => void
): Promise<Commit[]> {
  if (diffComputationAbort) {
    diffComputationAbort();
    diffComputationAbort = null;
  }

  const repoId = `${repoInfo.owner}-${repoInfo.repo}`;
  const lfs = getFs(repoId);
  const dir = repoDir!;
  const repoUrl = `https://github.com/${repoInfo.owner}/${repoInfo.repo}.git`;

  onProgress?.('Connecting...', 0, null);

  // Clone
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
        if (event.phase === 'Receiving objects' && event.total) {
          onProgress?.('Cloning repository...', event.loaded, event.total);
        } else if (event.phase) {
          onProgress?.(event.phase, 0, null);
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
          if (event.phase === 'Receiving objects' && event.total) {
            onProgress?.('Cloning repository...', event.loaded, event.total);
          } else if (event.phase) {
            onProgress?.(event.phase, 0, null);
          }
        },
      });
    } else {
      throw new Error('Failed to clone repository');
    }
  }

  onProgress?.('Reading commit history...', 0, null);

  const log = await git.log({ fs: lfs, dir, depth: maxCommits });

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

  onProgress?.('Ready!', commits.length, commits.length);

  // Start background diff with incremental tree comparison
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

  let prevTreeOid: string | null = null;

  for (let i = 0; i < commits.length; i++) {
    if (aborted) break;

    const commit = commits[i];

    try {
      const { commit: commitObj } = await git.readCommit({ fs: lfs, dir, oid: commit.sha });
      const treeOid = commitObj.tree;

      // Incremental diff: only walk into subtrees that changed
      const files = await diffTreesIncremental(lfs, dir, prevTreeOid, treeOid, '');
      commit.files = files;

      prevTreeOid = treeOid;
    } catch {
      // Skip
    }

    // Yield every 10 commits
    if (i % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}

// Incremental tree diff - only descends into subtrees with different OIDs
async function diffTreesIncremental(
  lfs: LightningFS,
  dir: string,
  oldTreeOid: string | null,
  newTreeOid: string,
  basePath: string
): Promise<FileChange[]> {
  const changes: FileChange[] = [];

  // If trees are identical, no changes
  if (oldTreeOid === newTreeOid) {
    return changes;
  }

  // Read both trees
  const newTree = await readTreeSafe(lfs, dir, newTreeOid);
  const oldTree = oldTreeOid ? await readTreeSafe(lfs, dir, oldTreeOid) : [];

  // Build maps for O(1) lookup
  const oldMap = new Map(oldTree.map(e => [e.path, e]));
  const newMap = new Map(newTree.map(e => [e.path, e]));

  // Check entries in new tree
  for (const entry of newTree) {
    const fullPath = basePath ? `${basePath}/${entry.path}` : entry.path;
    const oldEntry = oldMap.get(entry.path);

    if (!oldEntry) {
      // Added - collect all files if it's a tree
      if (entry.type === 'blob') {
        changes.push({ filename: fullPath, status: 'added', additions: 0, deletions: 0 });
      } else if (entry.type === 'tree') {
        const subFiles = await collectAllFiles(lfs, dir, entry.oid, fullPath);
        for (const f of subFiles) {
          changes.push({ filename: f, status: 'added', additions: 0, deletions: 0 });
        }
      }
    } else if (oldEntry.oid !== entry.oid) {
      // Changed
      if (entry.type === 'blob' && oldEntry.type === 'blob') {
        changes.push({ filename: fullPath, status: 'modified', additions: 0, deletions: 0 });
      } else if (entry.type === 'tree' && oldEntry.type === 'tree') {
        // Recurse into changed subtree
        const subChanges = await diffTreesIncremental(lfs, dir, oldEntry.oid, entry.oid, fullPath);
        changes.push(...subChanges);
      } else {
        // Type changed (rare) - treat as remove + add
        if (oldEntry.type === 'blob') {
          changes.push({ filename: fullPath, status: 'removed', additions: 0, deletions: 0 });
        } else {
          const oldFiles = await collectAllFiles(lfs, dir, oldEntry.oid, fullPath);
          for (const f of oldFiles) {
            changes.push({ filename: f, status: 'removed', additions: 0, deletions: 0 });
          }
        }
        if (entry.type === 'blob') {
          changes.push({ filename: fullPath, status: 'added', additions: 0, deletions: 0 });
        } else {
          const newFiles = await collectAllFiles(lfs, dir, entry.oid, fullPath);
          for (const f of newFiles) {
            changes.push({ filename: f, status: 'added', additions: 0, deletions: 0 });
          }
        }
      }
    }
    // If OIDs match, no change - skip entirely
  }

  // Check for removed entries
  for (const entry of oldTree) {
    if (!newMap.has(entry.path)) {
      const fullPath = basePath ? `${basePath}/${entry.path}` : entry.path;
      if (entry.type === 'blob') {
        changes.push({ filename: fullPath, status: 'removed', additions: 0, deletions: 0 });
      } else if (entry.type === 'tree') {
        const subFiles = await collectAllFiles(lfs, dir, entry.oid, fullPath);
        for (const f of subFiles) {
          changes.push({ filename: f, status: 'removed', additions: 0, deletions: 0 });
        }
      }
    }
  }

  return changes;
}

async function readTreeSafe(
  lfs: LightningFS,
  dir: string,
  oid: string
): Promise<{ path: string; oid: string; type: string }[]> {
  try {
    const { tree } = await git.readTree({ fs: lfs, dir, oid });
    return tree;
  } catch {
    return [];
  }
}

async function collectAllFiles(
  lfs: LightningFS,
  dir: string,
  treeOid: string,
  basePath: string
): Promise<string[]> {
  const files: string[] = [];
  const tree = await readTreeSafe(lfs, dir, treeOid);

  for (const entry of tree) {
    const fullPath = basePath ? `${basePath}/${entry.path}` : entry.path;
    if (entry.type === 'blob') {
      files.push(fullPath);
    } else if (entry.type === 'tree') {
      const subFiles = await collectAllFiles(lfs, dir, entry.oid, fullPath);
      files.push(...subFiles);
    }
  }

  return files;
}

export async function getDefaultBranch(repoInfo: RepoInfo): Promise<string> {
  return repoInfo.branch || 'main';
}
