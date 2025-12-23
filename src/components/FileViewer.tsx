import { useEffect, useState, useRef } from 'react';
import { X, FileText, AlertCircle, FileCode } from 'lucide-react';
import type { Commit } from '../types';
import { readFileAtCommit, type FileContent } from '../services/git';

interface FileViewerProps {
  filePath: string | null;
  currentCommit: Commit | null;
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

export default function FileViewer({ filePath, currentCommit, onClose }: FileViewerProps) {
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef<Map<string, FileContent>>(new Map());

  useEffect(() => {
    if (!filePath || !currentCommit) {
      setFileContent(null);
      setError(null);
      return;
    }

    const cacheKey = `${currentCommit.sha}:${filePath}`;

    // Check cache first
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setFileContent(cached);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    readFileAtCommit(currentCommit.sha, filePath)
      .then(content => {
        setLoading(false);
        if (content) {
          // Cache the result
          cacheRef.current.set(cacheKey, content);
          // Limit cache size
          if (cacheRef.current.size > 50) {
            const firstKey = cacheRef.current.keys().next().value;
            if (firstKey) cacheRef.current.delete(firstKey);
          }
          setFileContent(content);
        } else {
          setError('File not found at this commit');
        }
      })
      .catch(() => {
        setLoading(false);
        setError('Failed to load file content');
      });
  }, [filePath, currentCommit]);

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
