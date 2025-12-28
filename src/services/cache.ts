import type { Commit, FileNode, Author } from '../types';

const DB_NAME = 'vibource-cache';
const DB_VERSION = 2; // Upgraded for new stores
const STORE_NAME = 'commits';
const TREE_SNAPSHOTS_STORE = 'treeSnapshots';
const NODE_POSITIONS_STORE = 'nodePositions';
const FILE_CONTENT_STORE = 'fileContents';
const CACHE_EXPIRY_DAYS = 7;

// How often to save tree snapshots (every N commits)
const TREE_SNAPSHOT_INTERVAL = 50;

interface CachedData {
  key: string;
  commits: Commit[];
  headSha: string;
  timestamp: number;
}

// Playback state stored in sessionStorage
export interface PlaybackState {
  repoKey: string;
  commitIndex: number;
  playbackSpeed: number;
  selectedFile: string | null;
  isPlaying: boolean;
  showStats: boolean;
  showSidebar: boolean;
  showFilePanel: boolean;
}

// Tree snapshot for quick restoration
export interface TreeSnapshot {
  key: string; // owner/repo/branch
  commitIndex: number;
  fileTree: SerializableFileNode;
  authors: [string, SerializableAuthor][];
  timestamp: number;
}

// Serializable versions (without circular refs)
interface SerializableFileNode {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: SerializableFileNode[];
  lastModified?: string;
  lastAuthor?: string;
  status?: 'added' | 'modified' | 'removed' | 'idle';
  color?: string;
}

interface SerializableAuthor {
  name: string;
  email: string;
  login?: string;
  avatarUrl?: string;
  commitCount: number;
  color: string;
}

// D3 node positions
export interface NodePositions {
  key: string; // owner/repo/branch
  positions: Map<string, { x: number; y: number }>;
  commitIndex: number;
  timestamp: number;
}

interface CachedNodePositions {
  key: string;
  positions: [string, { x: number; y: number }][];
  commitIndex: number;
  timestamp: number;
}

// File content cache entry
export interface CachedFileContent {
  key: string; // sha:filepath
  content: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  timestamp: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.warn('IndexedDB not available, caching disabled');
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Commits store
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }

      // Tree snapshots store - compound key for multiple snapshots per repo
      if (!db.objectStoreNames.contains(TREE_SNAPSHOTS_STORE)) {
        const store = db.createObjectStore(TREE_SNAPSHOTS_STORE, { keyPath: ['key', 'commitIndex'] });
        store.createIndex('byKey', 'key', { unique: false });
      }

      // Node positions store
      if (!db.objectStoreNames.contains(NODE_POSITIONS_STORE)) {
        db.createObjectStore(NODE_POSITIONS_STORE, { keyPath: 'key' });
      }

      // File content store
      if (!db.objectStoreNames.contains(FILE_CONTENT_STORE)) {
        const store = db.createObjectStore(FILE_CONTENT_STORE, { keyPath: 'key' });
        store.createIndex('byTimestamp', 'timestamp', { unique: false });
      }
    };
  });

  return dbPromise;
}

function getCacheKey(owner: string, repo: string, branch: string): string {
  return `${owner}/${repo}/${branch}`;
}

function isExpired(timestamp: number): boolean {
  const now = Date.now();
  const expiryMs = CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  return now - timestamp > expiryMs;
}

/**
 * Get cached commits for a repository if available and valid
 */
export async function getCachedCommits(
  owner: string,
  repo: string,
  branch: string,
  headSha?: string
): Promise<Commit[] | null> {
  try {
    const db = await openDB();
    const key = getCacheKey(owner, repo, branch);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const data = request.result as CachedData | undefined;

        if (!data) {
          resolve(null);
          return;
        }

        // Check if expired
        if (isExpired(data.timestamp)) {
          console.log('Cache expired, will refetch');
          resolve(null);
          return;
        }

        // If we have a head SHA to compare, validate cache
        if (headSha && data.headSha !== headSha) {
          console.log('Cache stale (head SHA changed), will refetch');
          resolve(null);
          return;
        }

        console.log(`Using cached commits for ${key} (${data.commits.length} commits)`);
        resolve(data.commits);
      };
    });
  } catch (error) {
    console.warn('Failed to read from cache:', error);
    return null;
  }
}

/**
 * Store commits in cache
 */
export async function cacheCommits(
  owner: string,
  repo: string,
  branch: string,
  commits: Commit[]
): Promise<void> {
  if (commits.length === 0) return;

  try {
    const db = await openDB();
    const key = getCacheKey(owner, repo, branch);
    const headSha = commits[commits.length - 1].sha; // Most recent commit

    const data: CachedData = {
      key,
      commits,
      headSha,
      timestamp: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(data);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        console.log(`Cached ${commits.length} commits for ${key}`);
        resolve();
      };
    });
  } catch (error) {
    console.warn('Failed to write to cache:', error);
  }
}

/**
 * Clear cache for a specific repository
 */
export async function clearCache(
  owner: string,
  repo: string,
  branch: string
): Promise<void> {
  try {
    const db = await openDB();
    const key = getCacheKey(owner, repo, branch);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch (error) {
    console.warn('Failed to clear cache:', error);
  }
}

/**
 * Clear all cached data
 */
export async function clearAllCache(): Promise<void> {
  try {
    const db = await openDB();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch (error) {
    console.warn('Failed to clear all cache:', error);
  }
}

/**
 * Get cache stats for debugging
 */
export async function getCacheStats(): Promise<{ count: number; keys: string[] }> {
  try {
    const db = await openDB();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAllKeys();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const keys = request.result as string[];
        resolve({ count: keys.length, keys });
      };
    });
  } catch (error) {
    console.warn('Failed to get cache stats:', error);
    return { count: 0, keys: [] };
  }
}

// ============================================================================
// PLAYBACK STATE (sessionStorage - survives refresh, clears on tab close)
// ============================================================================

const PLAYBACK_STATE_KEY = 'vibource-playback-state';

/**
 * Save playback state to sessionStorage
 */
export function savePlaybackState(state: PlaybackState): void {
  try {
    sessionStorage.setItem(PLAYBACK_STATE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('Failed to save playback state:', error);
  }
}

/**
 * Get playback state from sessionStorage
 */
export function getPlaybackState(repoKey: string): PlaybackState | null {
  try {
    const stored = sessionStorage.getItem(PLAYBACK_STATE_KEY);
    if (!stored) return null;

    const state = JSON.parse(stored) as PlaybackState;
    // Only return if it matches the current repo
    if (state.repoKey !== repoKey) return null;

    return state;
  } catch (error) {
    console.warn('Failed to get playback state:', error);
    return null;
  }
}

/**
 * Clear playback state
 */
export function clearPlaybackState(): void {
  try {
    sessionStorage.removeItem(PLAYBACK_STATE_KEY);
  } catch (error) {
    console.warn('Failed to clear playback state:', error);
  }
}

// ============================================================================
// TREE SNAPSHOTS (IndexedDB - persists across sessions)
// ============================================================================

/**
 * Serialize FileNode tree (remove circular parent refs)
 */
function serializeTree(node: FileNode): SerializableFileNode {
  return {
    id: node.id,
    name: node.name,
    path: node.path,
    type: node.type,
    children: node.children?.map(serializeTree),
    lastModified: node.lastModified?.toISOString(),
    lastAuthor: node.lastAuthor,
    status: node.status,
    color: node.color,
  };
}

/**
 * Deserialize FileNode tree (rebuild parent refs)
 */
function deserializeTree(node: SerializableFileNode, parent?: FileNode): FileNode {
  const result: FileNode = {
    id: node.id,
    name: node.name,
    path: node.path,
    type: node.type,
    parent,
    lastModified: node.lastModified ? new Date(node.lastModified) : undefined,
    lastAuthor: node.lastAuthor,
    status: node.status,
    color: node.color,
  };

  if (node.children) {
    result.children = node.children.map(child => deserializeTree(child, result));
  }

  return result;
}

/**
 * Check if we should save a snapshot at this commit index
 */
export function shouldSaveTreeSnapshot(commitIndex: number): boolean {
  return commitIndex > 0 && commitIndex % TREE_SNAPSHOT_INTERVAL === 0;
}

/**
 * Save a tree snapshot
 */
export async function saveTreeSnapshot(
  owner: string,
  repo: string,
  branch: string,
  commitIndex: number,
  fileTree: FileNode,
  authors: Map<string, Author>
): Promise<void> {
  try {
    const db = await openDB();
    const key = getCacheKey(owner, repo, branch);

    const snapshot: TreeSnapshot = {
      key,
      commitIndex,
      fileTree: serializeTree(fileTree),
      authors: Array.from(authors.entries()).map(([k, v]) => [k, {
        name: v.name,
        email: v.email,
        login: v.login,
        avatarUrl: v.avatarUrl,
        commitCount: v.commitCount,
        color: v.color,
      }]),
      timestamp: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(TREE_SNAPSHOTS_STORE, 'readwrite');
      const store = transaction.objectStore(TREE_SNAPSHOTS_STORE);
      const request = store.put(snapshot);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        console.log(`Saved tree snapshot at commit ${commitIndex} for ${key}`);
        resolve();
      };
    });
  } catch (error) {
    console.warn('Failed to save tree snapshot:', error);
  }
}

/**
 * Get the nearest tree snapshot at or before the target commit index
 */
export async function getNearestTreeSnapshot(
  owner: string,
  repo: string,
  branch: string,
  targetCommitIndex: number
): Promise<{ snapshot: TreeSnapshot; fileTree: FileNode; authors: Map<string, Author> } | null> {
  try {
    const db = await openDB();
    const key = getCacheKey(owner, repo, branch);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(TREE_SNAPSHOTS_STORE, 'readonly');
      const store = transaction.objectStore(TREE_SNAPSHOTS_STORE);
      const index = store.index('byKey');
      const request = index.getAll(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const snapshots = request.result as TreeSnapshot[];
        if (snapshots.length === 0) {
          resolve(null);
          return;
        }

        // Find the nearest snapshot at or before target
        const validSnapshots = snapshots.filter(s => s.commitIndex <= targetCommitIndex);
        if (validSnapshots.length === 0) {
          resolve(null);
          return;
        }

        // Get the one closest to target
        const nearest = validSnapshots.reduce((best, current) =>
          current.commitIndex > best.commitIndex ? current : best
        );

        // Check if expired
        if (isExpired(nearest.timestamp)) {
          resolve(null);
          return;
        }

        // Deserialize
        const fileTree = deserializeTree(nearest.fileTree);
        const authors = new Map<string, Author>(
          nearest.authors.map(([k, v]) => [k, v as Author])
        );

        console.log(`Found tree snapshot at commit ${nearest.commitIndex} for ${key}`);
        resolve({ snapshot: nearest, fileTree, authors });
      };
    });
  } catch (error) {
    console.warn('Failed to get tree snapshot:', error);
    return null;
  }
}

/**
 * Clear tree snapshots for a repository
 */
export async function clearTreeSnapshots(
  owner: string,
  repo: string,
  branch: string
): Promise<void> {
  try {
    const db = await openDB();
    const key = getCacheKey(owner, repo, branch);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(TREE_SNAPSHOTS_STORE, 'readwrite');
      const store = transaction.objectStore(TREE_SNAPSHOTS_STORE);
      const index = store.index('byKey');
      const request = index.getAllKeys(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const keys = request.result;
        keys.forEach(k => store.delete(k));
        resolve();
      };
    });
  } catch (error) {
    console.warn('Failed to clear tree snapshots:', error);
  }
}

// ============================================================================
// NODE POSITIONS (IndexedDB - D3 simulation positions)
// ============================================================================

/**
 * Save D3 node positions
 */
export async function saveNodePositions(
  owner: string,
  repo: string,
  branch: string,
  positions: Map<string, { x: number; y: number }>,
  commitIndex: number
): Promise<void> {
  try {
    const db = await openDB();
    const key = getCacheKey(owner, repo, branch);

    const data: CachedNodePositions = {
      key,
      positions: Array.from(positions.entries()),
      commitIndex,
      timestamp: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(NODE_POSITIONS_STORE, 'readwrite');
      const store = transaction.objectStore(NODE_POSITIONS_STORE);
      const request = store.put(data);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch (error) {
    console.warn('Failed to save node positions:', error);
  }
}

/**
 * Get saved D3 node positions
 */
export async function getNodePositions(
  owner: string,
  repo: string,
  branch: string
): Promise<NodePositions | null> {
  try {
    const db = await openDB();
    const key = getCacheKey(owner, repo, branch);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(NODE_POSITIONS_STORE, 'readonly');
      const store = transaction.objectStore(NODE_POSITIONS_STORE);
      const request = store.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const data = request.result as CachedNodePositions | undefined;
        if (!data || isExpired(data.timestamp)) {
          resolve(null);
          return;
        }

        resolve({
          key: data.key,
          positions: new Map(data.positions),
          commitIndex: data.commitIndex,
          timestamp: data.timestamp,
        });
      };
    });
  } catch (error) {
    console.warn('Failed to get node positions:', error);
    return null;
  }
}

/**
 * Clear node positions
 */
export async function clearNodePositions(
  owner: string,
  repo: string,
  branch: string
): Promise<void> {
  try {
    const db = await openDB();
    const key = getCacheKey(owner, repo, branch);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(NODE_POSITIONS_STORE, 'readwrite');
      const store = transaction.objectStore(NODE_POSITIONS_STORE);
      const request = store.delete(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch (error) {
    console.warn('Failed to clear node positions:', error);
  }
}

// ============================================================================
// FILE CONTENT CACHE (IndexedDB - persists file contents across sessions)
// ============================================================================

const MAX_FILE_CACHE_ENTRIES = 500;
const MAX_FILE_CONTENT_SIZE = 100 * 1024; // 100KB max per file

/**
 * Save file content to IndexedDB cache
 */
export async function cacheFileContent(
  sha: string,
  filepath: string,
  content: string,
  size: number,
  binary: boolean,
  truncated: boolean
): Promise<void> {
  // Don't cache large files or binary files
  if (size > MAX_FILE_CONTENT_SIZE || binary) return;

  try {
    const db = await openDB();
    const key = `${sha}:${filepath}`;

    const data: CachedFileContent = {
      key,
      content,
      size,
      binary,
      truncated,
      timestamp: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(FILE_CONTENT_STORE, 'readwrite');
      const store = transaction.objectStore(FILE_CONTENT_STORE);
      const request = store.put(data);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch (error) {
    console.warn('Failed to cache file content:', error);
  }
}

/**
 * Get cached file content
 */
export async function getCachedFileContent(
  sha: string,
  filepath: string
): Promise<CachedFileContent | null> {
  try {
    const db = await openDB();
    const key = `${sha}:${filepath}`;

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(FILE_CONTENT_STORE, 'readonly');
      const store = transaction.objectStore(FILE_CONTENT_STORE);
      const request = store.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const data = request.result as CachedFileContent | undefined;
        if (!data || isExpired(data.timestamp)) {
          resolve(null);
          return;
        }
        resolve(data);
      };
    });
  } catch (error) {
    console.warn('Failed to get cached file content:', error);
    return null;
  }
}

/**
 * Prune old file content entries to stay under limit
 */
export async function pruneFileContentCache(): Promise<void> {
  try {
    const db = await openDB();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(FILE_CONTENT_STORE, 'readwrite');
      const store = transaction.objectStore(FILE_CONTENT_STORE);
      const countRequest = store.count();

      countRequest.onerror = () => reject(countRequest.error);
      countRequest.onsuccess = () => {
        const count = countRequest.result;
        if (count <= MAX_FILE_CACHE_ENTRIES) {
          resolve();
          return;
        }

        // Get entries sorted by timestamp and delete oldest
        const index = store.index('byTimestamp');
        const deleteCount = count - MAX_FILE_CACHE_ENTRIES;
        let deleted = 0;

        const cursorRequest = index.openCursor();
        cursorRequest.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor && deleted < deleteCount) {
            cursor.delete();
            deleted++;
            cursor.continue();
          } else {
            console.log(`Pruned ${deleted} old file cache entries`);
            resolve();
          }
        };
        cursorRequest.onerror = () => reject(cursorRequest.error);
      };
    });
  } catch (error) {
    console.warn('Failed to prune file content cache:', error);
  }
}

/**
 * Clear all file content cache
 */
export async function clearFileContentCache(): Promise<void> {
  try {
    const db = await openDB();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(FILE_CONTENT_STORE, 'readwrite');
      const store = transaction.objectStore(FILE_CONTENT_STORE);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch (error) {
    console.warn('Failed to clear file content cache:', error);
  }
}
