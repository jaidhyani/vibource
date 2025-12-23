import type { Commit } from '../types';

const DB_NAME = 'vibource-cache';
const DB_VERSION = 1;
const STORE_NAME = 'commits';
const CACHE_EXPIRY_DAYS = 7;

interface CachedData {
  key: string;
  commits: Commit[];
  headSha: string;
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
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
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
