import { useEffect, useState } from 'react';
import { X, FileText, AlertCircle } from 'lucide-react';
import type { Commit } from '../types';

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

// Check if file is likely binary
function isBinaryFile(filename: string): boolean {
  const binaryExtensions = [
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'zip', 'tar', 'gz', 'rar', '7z',
    'exe', 'dll', 'so', 'dylib',
    'mp3', 'mp4', 'wav', 'avi', 'mov', 'webm',
    'ttf', 'otf', 'woff', 'woff2', 'eot',
    'pyc', 'class', 'o', 'obj',
  ];
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return binaryExtensions.includes(ext);
}

export default function FileViewer({ filePath, currentCommit, onClose }: FileViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!filePath) {
      setContent(null);
      setError(null);
      return;
    }

    // Check if binary
    if (isBinaryFile(filePath)) {
      setContent(null);
      setError('Binary file - cannot display contents');
      return;
    }

    // For now, we'll show a placeholder since we don't have actual file content
    // In a full implementation, we'd fetch from git using isomorphic-git
    setLoading(true);
    setError(null);

    // Simulate loading
    const timeout = setTimeout(() => {
      setLoading(false);
      // We don't have actual file content access yet
      // This would require reading from the git repo
      setContent(null);
      setError('File content viewing not yet implemented.\nThe file tree shows file changes per commit.');
    }, 100);

    return () => clearTimeout(timeout);
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
          <FileText size={16} />
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
        </div>
        <button onClick={onClose} className="file-viewer-close" title="Close">
          <X size={18} />
        </button>
      </div>

      <div className="file-viewer-content">
        {loading && (
          <div className="file-viewer-loading">
            Loading...
          </div>
        )}

        {error && (
          <div className="file-viewer-error">
            <AlertCircle size={24} />
            <p>{error}</p>
          </div>
        )}

        {content && (
          <pre className="file-viewer-code">
            <code>{content}</code>
          </pre>
        )}

        {!loading && !error && !content && (
          <div className="file-viewer-placeholder">
            <FileText size={48} />
            <p>Select a file to view its contents</p>
          </div>
        )}
      </div>
    </div>
  );
}
