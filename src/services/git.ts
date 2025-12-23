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
      depth: maxCommits + 1, // Shallow clone with enough history
      onProgress: (event) => {
        if (event.total) {
          onProgress?.('Cloning...', event.loaded, event.total);
        }
      },
    });
  } catch (err) {
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
      throw err;
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

  // Process commits (oldest first)
  const reversedLog = [...log].reverse();

  for (let i = 0; i < reversedLog.length; i++) {
    const entry = reversedLog[i];
    onProgress?.('Processing commits...', i + 1, total);

    // Get file changes by comparing trees
    const files = await getCommitChanges(lfs, dir, entry.oid, i > 0 ? reversedLog[i - 1].oid : null);

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
  }

  return commits;
}

async function getCommitChanges(
  fs: LightningFS,
  dir: string,
  commitOid: string,
  parentOid: string | null
): Promise<FileChange[]> {
  const changes: FileChange[] = [];

  try {
    // Get the tree for current commit
    const currentTree = await getTreeFiles(fs, dir, commitOid);

    // Get the tree for parent commit (or empty if first commit)
    const parentTree = parentOid
      ? await getTreeFiles(fs, dir, parentOid)
      : new Map<string, string>();

    // Find added and modified files
    for (const [path, oid] of currentTree) {
      const parentOidForPath = parentTree.get(path);
      if (!parentOidForPath) {
        changes.push({
          filename: path,
          status: 'added',
          additions: 0,
          deletions: 0,
        });
      } else if (parentOidForPath !== oid) {
        changes.push({
          filename: path,
          status: 'modified',
          additions: 0,
          deletions: 0,
        });
      }
    }

    // Find removed files
    for (const [path] of parentTree) {
      if (!currentTree.has(path)) {
        changes.push({
          filename: path,
          status: 'removed',
          additions: 0,
          deletions: 0,
        });
      }
    }
  } catch {
    // If we can't get the tree, return empty changes
  }

  return changes;
}

async function getTreeFiles(
  fs: LightningFS,
  dir: string,
  commitOid: string
): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  try {
    const { commit } = await git.readCommit({ fs, dir, oid: commitOid });

    async function walkTree(treeOid: string, basePath: string) {
      const { tree } = await git.readTree({ fs, dir, oid: treeOid });

      for (const entry of tree) {
        const fullPath = basePath ? `${basePath}/${entry.path}` : entry.path;

        if (entry.type === 'blob') {
          files.set(fullPath, entry.oid);
        } else if (entry.type === 'tree') {
          await walkTree(entry.oid, fullPath);
        }
      }
    }

    await walkTree(commit.tree, '');
  } catch {
    // Ignore errors
  }

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
  // We'll try main first, then master in cloneAndGetCommits
  return repoInfo.branch || 'main';
}
