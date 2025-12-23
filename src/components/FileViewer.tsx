import { useEffect, useState, useRef } from 'react';
import { X, FileText, AlertCircle, FileCode } from 'lucide-react';
import type { Commit } from '../types';
import { readFileAtCommit, type FileContent } from '../services/git';

interface FileViewerProps {
  filePath: string | null;
  currentCommit: Commit | null;
  commits: Commit[];
  currentCommitIndex: number;
  onClose: () => void;
}

// Simple language detection for syntax highlighting hints
function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    kt: 'kotlin',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    css: 'css',
    scss: 'scss',
    html: 'html',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sh: 'bash',
    bash: 'bash',
    sql: 'sql',
    xml: 'xml',
  };
  return langMap[ext] || 'plaintext';
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Global cache shared across component instances
const fileCache = new Map<string, FileContent>();
const MAX_CACHE_SIZE = 1024;

function addToCache(key: string, content: FileContent) {
  fileCache.set(key, content);
  // LRU eviction - remove oldest entries if over limit
  if (fileCache.size > MAX_CACHE_SIZE) {
    const keysToDelete = Array.from(fileCache.keys()).slice(0, fileCache.size - MAX_CACHE_SIZE);
    keysToDelete.forEach(k => fileCache.delete(k));
  }
}

export default function FileViewer({
  filePath,
  currentCommit,
  commits,
  currentCommitIndex,
  onClose
}: FileViewerProps) {
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const prefetchAbortRef = useRef<AbortController | null>(null);

  // Main effect for loading current file content
  useEffect(() => {
    // Cancel any pending operations
    abortControllerRef.current?.abort();
    prefetchAbortRef.current?.abort();

    if (!filePath || !currentCommit) {
      setFileContent(null);
      setError(null);
      return;
    }

    const cacheKey = `${currentCommit.sha}:${filePath}`;

    // Check cache first
    const cached = fileCache.get(cacheKey);
    if (cached) {
      setFileContent(cached);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    readFileAtCommit(currentCommit.sha, filePath)
      .then(content => {
        if (abortController.signal.aborted) return;
        setLoading(false);
        if (content) {
          addToCache(cacheKey, content);
          setFileContent(content);
        } else {
          setError('File not found at this commit');
        }
      })
      .catch(() => {
        if (abortController.signal.aborted) return;
        setLoading(false);
        setError('Failed to load file content');
      });

    return () => {
      abortController.abort();
    };
  }, [filePath, currentCommit]);

  // Prefetch effect - load next 5 versions of the file
  useEffect(() => {
    if (!filePath || currentCommitIndex < 0) return;

    prefetchAbortRef.current?.abort();
    const abortController = new AbortController();
    prefetchAbortRef.current = abortController;

    // Prefetch next 5 commits that might contain this file
    const prefetchCommits: Commit[] = [];
    for (let i = currentCommitIndex + 1; i < commits.length && prefetchCommits.length < 5; i++) {
      prefetchCommits.push(commits[i]);
    }

    // Also prefetch previous 2 commits
    for (let i = currentCommitIndex - 1; i >= 0 && prefetchCommits.length < 7; i--) {
      prefetchCommits.push(commits[i]);
    }

    // Prefetch in background
    const prefetch = async () => {
      for (const commit of prefetchCommits) {
        if (abortController.signal.aborted) break;

        const cacheKey = `${commit.sha}:${filePath}`;
        if (fileCache.has(cacheKey)) continue;

        try {
          const content = await readFileAtCommit(commit.sha, filePath);
          if (abortController.signal.aborted) break;
          if (content) {
            addToCache(cacheKey, content);
          }
        } catch {
          // Ignore prefetch errors
        }

        // Small delay between prefetches to not block main thread
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };

    prefetch();

    return () => {
      abortController.abort();
    };
  }, [filePath, currentCommitIndex, commits]);

  if (!filePath) return null;

  const filename = filePath.split('/').pop() || filePath;
  const language = detectLanguage(filename);

  // Find file status from current commit
  const fileChange = currentCommit?.files.find(f => f.filename === filePath);
  const status = fileChange?.status;

  return (
    <div className="file-viewer">
      <div className="file-viewer-header">
        <div className="file-viewer-title">
          <FileCode size={16} />
          <span className="file-viewer-name">{filename}</span>
          {status && (
            <span className={`file-status-badge ${status}`}>
              {status}
            </span>
          )}
        </div>
        <div className="file-viewer-meta">
          <span className="file-viewer-path">{filePath}</span>
          <span className="file-viewer-lang">{language}</span>
          {fileContent && (
            <span className="file-viewer-size">{formatFileSize(fileContent.size)}</span>
          )}
        </div>
        <button onClick={onClose} className="file-viewer-close" title="Close">
          <X size={18} />
        </button>
      </div>

      <div className="file-viewer-content">
        {loading && (
          <div className="file-viewer-loading">
            <div className="loading-spinner" />
            <p>Loading file...</p>
          </div>
        )}

        {error && (
          <div className="file-viewer-error">
            <AlertCircle size={24} />
            <p>{error}</p>
          </div>
        )}

        {fileContent?.binary && (
          <div className="file-viewer-binary">
            <FileText size={48} />
            <p>Binary file ({formatFileSize(fileContent.size)})</p>
            <p className="binary-hint">Cannot display binary content</p>
          </div>
        )}

        {fileContent && !fileContent.binary && (
          <>
            {fileContent.truncated && (
              <div className="file-viewer-truncated">
                File truncated (showing first 100KB of {formatFileSize(fileContent.size)})
              </div>
            )}
            <pre className="file-viewer-code">
              <code>{fileContent.content}</code>
            </pre>
          </>
        )}

        {!loading && !error && !fileContent && (
          <div className="file-viewer-placeholder">
            <FileText size={48} />
            <p>Select a file to view its contents</p>
          </div>
        )}
      </div>
    </div>
  );
}
