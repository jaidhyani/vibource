import type { Commit, FileNode } from '../types';
import { GitCommit, User, Clock, FileText, FilePlus, FileEdit, FileX } from 'lucide-react';

interface CommitSidebarProps {
  currentCommit: Commit | null;
  modifiedFiles: FileNode[];
  onFileSelect: (path: string) => void;
  selectedFile: string | null;
}

export default function CommitSidebar({
  currentCommit,
  modifiedFiles,
  onFileSelect,
  selectedFile,
}: CommitSidebarProps) {
  if (!currentCommit) {
    return (
      <div className="commit-sidebar">
        <div className="commit-sidebar-empty">
          <GitCommit size={32} className="empty-icon" />
          <p>No commit selected</p>
          <p className="empty-hint">Press play or use the timeline to view commits</p>
        </div>
      </div>
    );
  }

  const commitDate = new Date(currentCommit.author.date);
  const formattedDate = commitDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const formattedTime = commitDate.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const getFileIcon = (status?: string) => {
    switch (status) {
      case 'added':
        return <FilePlus size={14} className="file-icon added" />;
      case 'removed':
        return <FileX size={14} className="file-icon removed" />;
      case 'modified':
        return <FileEdit size={14} className="file-icon modified" />;
      default:
        return <FileText size={14} className="file-icon" />;
    }
  };

  // Get files from commit.files if available, otherwise use modifiedFiles
  const files = currentCommit.files.length > 0
    ? currentCommit.files.map(f => ({
        path: f.filename,
        status: f.status,
        name: f.filename.split('/').pop() || f.filename,
      }))
    : modifiedFiles.map(f => ({
        path: f.path,
        status: f.status,
        name: f.name,
      }));

  return (
    <div className="commit-sidebar">
      <div className="commit-header">
        <div className="commit-sha">
          <GitCommit size={14} />
          <span>{currentCommit.sha.slice(0, 7)}</span>
        </div>
      </div>

      <div className="commit-message-section">
        <h3 className="commit-title">
          {currentCommit.message.split('\n')[0]}
        </h3>
        {currentCommit.message.includes('\n') && (
          <p className="commit-body">
            {currentCommit.message.split('\n').slice(1).join('\n').trim()}
          </p>
        )}
      </div>

      <div className="commit-meta">
        <div className="meta-item">
          <User size={14} />
          <span>{currentCommit.author.name}</span>
        </div>
        <div className="meta-item">
          <Clock size={14} />
          <span>{formattedDate} {formattedTime}</span>
        </div>
      </div>

      {files.length > 0 && (
        <div className="commit-files">
          <div className="files-header">
            <span className="files-count">{files.length} file{files.length !== 1 ? 's' : ''} changed</span>
          </div>
          <ul className="files-list">
            {files.map((file, idx) => (
              <li key={idx}>
                <button
                  className={`file-item ${selectedFile === file.path ? 'selected' : ''}`}
                  onClick={() => onFileSelect(file.path)}
                  title={file.path}
                >
                  {getFileIcon(file.status)}
                  <span className="file-name">{file.name}</span>
                  <span className="file-path">{file.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
