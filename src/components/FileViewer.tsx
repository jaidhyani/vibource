import { useEffect, useState, useRef, useMemo } from 'react';
import { X, FileText, AlertCircle, FileCode, ChevronDown, GitCommit } from 'lucide-react';
import type { Commit } from '../types';
import { readFileAtCommit, type FileContent } from '../services/git';

interface FileViewerProps {
  filePath: string | null;
  currentCommit: Commit | null;
  commits: Commit[];
  currentCommitIndex: number;
  onClose: () => void;
  onSeekToCommit?: (index: number) => void;
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

// Simple diff algorithm - returns lines with their status
interface DiffLine {
  content: string;
  type: 'unchanged' | 'added' | 'removed';
  lineNumber?: number;
}

function computeSimpleDiff(oldContent: string | null, newContent: string): DiffLine[] {
  if (!oldContent) {
    // All lines are added
    return newContent.split('\n').map((line, i) => ({
      content: line,
      type: 'added' as const,
      lineNumber: i + 1,
    }));
  }

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const result: DiffLine[] = [];

  // Simple LCS-based diff
  const lcs = computeLCS(oldLines, newLines);

  let oldIdx = 0;
  let newIdx = 0;
  let lineNum = 1;

  for (const match of lcs) {
    // Add removed lines
    while (oldIdx < match.oldIndex) {
      result.push({ content: oldLines[oldIdx], type: 'removed' });
      oldIdx++;
    }
    // Add added lines
    while (newIdx < match.newIndex) {
      result.push({ content: newLines[newIdx], type: 'added', lineNumber: lineNum++ });
      newIdx++;
    }
    // Add unchanged line
    result.push({ content: newLines[newIdx], type: 'unchanged', lineNumber: lineNum++ });
    oldIdx++;
    newIdx++;
  }

  // Add remaining removed lines
  while (oldIdx < oldLines.length) {
    result.push({ content: oldLines[oldIdx], type: 'removed' });
    oldIdx++;
  }
  // Add remaining added lines
  while (newIdx < newLines.length) {
    result.push({ content: newLines[newIdx], type: 'added', lineNumber: lineNum++ });
    newIdx++;
  }

  return result;
}

function computeLCS(oldLines: string[], newLines: string[]): { oldIndex: number; newIndex: number }[] {
  const m = oldLines.length;
  const n = newLines.length;

  // For performance, use a simpler approach for large files
  if (m * n > 1000000) {
    // Fall back to line-by-line comparison
    const result: { oldIndex: number; newIndex: number }[] = [];
    let j = 0;
    for (let i = 0; i < m && j < n; i++) {
      while (j < n && oldLines[i] !== newLines[j]) j++;
      if (j < n) {
        result.push({ oldIndex: i, newIndex: j });
        j++;
      }
    }
    return result;
  }

  // Standard LCS DP
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find LCS
  const result: { oldIndex: number; newIndex: number }[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ oldIndex: i - 1, newIndex: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

export default function FileViewer({
  filePath,
  currentCommit,
  commits,
  currentCommitIndex,
  onClose,
  onSeekToCommit
}: FileViewerProps) {
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [previousContent, setPreviousContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [showCommitDropdown, setShowCommitDropdown] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const prefetchAbortRef = useRef<AbortController | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Find commits where this file was changed
  const fileCommits = useMemo(() => {
    if (!filePath) return [];
    return commits
      .map((commit, index) => ({ commit, index }))
      .filter(({ commit }) =>
        commit.files.some(f => f.filename === filePath)
      );
  }, [filePath, commits]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowCommitDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Main effect for loading current file content
  useEffect(() => {
    // Cancel any pending operations
    abortControllerRef.current?.abort();
    prefetchAbortRef.current?.abort();

    if (!filePath || !currentCommit) {
      setFileContent(null);
      setPreviousContent(null);
      setError(null);
      return;
    }

    const cacheKey = `${currentCommit.sha}:${filePath}`;

    // Check cache first
    const cached = fileCache.get(cacheKey);
    if (cached) {
      setFileContent(cached);
      setError(null);
    } else {
      setLoading(true);
      setError(null);
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const loadContent = async () => {
      try {
        // Load current content
        if (!cached) {
          const content = await readFileAtCommit(currentCommit.sha, filePath);
          if (abortController.signal.aborted) return;

          if (content) {
            addToCache(cacheKey, content);
            setFileContent(content);
          } else {
            setError('File not found at this commit');
          }
        }

        // Load previous version for diff (find the previous commit that touched this file)
        const prevCommitIndex = fileCommits.findIndex(fc => fc.index === currentCommitIndex);
        if (prevCommitIndex > 0) {
          const prevCommit = fileCommits[prevCommitIndex - 1].commit;
          const prevCacheKey = `${prevCommit.sha}:${filePath}`;
          const prevCached = fileCache.get(prevCacheKey);

          if (prevCached) {
            setPreviousContent(prevCached);
          } else {
            const prevContent = await readFileAtCommit(prevCommit.sha, filePath);
            if (abortController.signal.aborted) return;
            if (prevContent) {
              addToCache(prevCacheKey, prevContent);
              setPreviousContent(prevContent);
            } else {
              setPreviousContent(null);
            }
          }
        } else {
          setPreviousContent(null);
        }

        setLoading(false);
      } catch {
        if (abortController.signal.aborted) return;
        setLoading(false);
        setError('Failed to load file content');
      }
    };

    loadContent();

    return () => {
      abortController.abort();
    };
  }, [filePath, currentCommit, currentCommitIndex, fileCommits]);

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

  // Compute diff when showing diff view
  const diffLines = useMemo(() => {
    if (!showDiff || !fileContent || fileContent.binary) return null;
    return computeSimpleDiff(
      previousContent?.content || null,
      fileContent.content
    );
  }, [showDiff, fileContent, previousContent]);

  if (!filePath) return null;

  const filename = filePath.split('/').pop() || filePath;
  const language = detectLanguage(filename);

  // Find file status from current commit
  const fileChange = currentCommit?.files.find(f => f.filename === filePath);
  const status = fileChange?.status;

  // Find current position in file commits
  const currentFileCommitIndex = fileCommits.findIndex(fc => fc.index === currentCommitIndex);

  return (
    <div className="file-viewer file-viewer-left">
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
        <button onClick={onClose} className="file-viewer-close" title="Close">
          <X size={18} />
        </button>
      </div>

      <div className="file-viewer-toolbar">
        <div className="file-viewer-path-row">
          <span className="file-viewer-path">{filePath}</span>
          <span className="file-viewer-lang">{language}</span>
          {fileContent && (
            <span className="file-viewer-size">{formatFileSize(fileContent.size)}</span>
          )}
        </div>

        <div className="file-viewer-actions">
          {fileCommits.length > 0 && (
            <div className="commit-jump-dropdown" ref={dropdownRef}>
              <button
                className="toolbar-btn"
                onClick={() => setShowCommitDropdown(!showCommitDropdown)}
                title="Jump to commit where file changed"
              >
                <GitCommit size={14} />
                <span>{currentFileCommitIndex + 1} / {fileCommits.length}</span>
                <ChevronDown size={14} />
              </button>
              {showCommitDropdown && (
                <div className="commit-dropdown-menu">
                  <div className="dropdown-header">Commits with changes</div>
                  <div className="dropdown-list">
                    {fileCommits.map(({ commit, index }) => (
                      <button
                        key={commit.sha}
                        className={`dropdown-item ${index === currentCommitIndex ? 'active' : ''}`}
                        onClick={() => {
                          onSeekToCommit?.(index);
                          setShowCommitDropdown(false);
                        }}
                      >
                        <span className="dropdown-sha">{commit.sha.slice(0, 7)}</span>
                        <span className="dropdown-msg">
                          {commit.message.split('\n')[0].slice(0, 40)}
                          {commit.message.length > 40 ? '...' : ''}
                        </span>
                        <span className={`dropdown-status ${commit.files.find(f => f.filename === filePath)?.status}`}>
                          {commit.files.find(f => f.filename === filePath)?.status?.charAt(0).toUpperCase()}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <button
            className={`toolbar-btn ${showDiff ? 'active' : ''}`}
            onClick={() => setShowDiff(!showDiff)}
            disabled={!previousContent && !fileChange?.status?.includes('added')}
            title={previousContent ? 'Toggle diff view' : 'No previous version'}
          >
            Diff
          </button>
        </div>
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
            {showDiff && diffLines ? (
              <pre className="file-viewer-code file-viewer-diff">
                <code>
                  {diffLines.map((line, i) => (
                    <div key={i} className={`diff-line diff-${line.type}`}>
                      <span className="diff-line-num">
                        {line.type === 'removed' ? '-' : line.lineNumber || ''}
                      </span>
                      <span className="diff-line-content">{line.content}</span>
                    </div>
                  ))}
                </code>
              </pre>
            ) : (
              <pre className="file-viewer-code">
                <code>{fileContent.content}</code>
              </pre>
            )}
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
