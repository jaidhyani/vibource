import type { FileNode, Author, Commit, RepoInfo } from '../types';
import { countNodes } from '../utils/fileTree';
import { GitBranch, Users, FileCode, FolderTree, Clock, X } from 'lucide-react';

interface StatsPanelProps {
  repoInfo: RepoInfo;
  fileTree: FileNode;
  authors: Map<string, Author>;
  commits: Commit[];
  currentCommitIndex: number;
  onClose: () => void;
}

export default function StatsPanel({
  repoInfo,
  fileTree,
  authors,
  commits,
  currentCommitIndex,
  onClose,
}: StatsPanelProps) {
  const { files, directories } = countNodes(fileTree);
  const sortedAuthors = Array.from(authors.values())
    .sort((a, b) => b.commitCount - a.commitCount)
    .slice(0, 10);

  const currentCommit = commits[currentCommitIndex];
  const startDate = commits.length > 0 ? new Date(commits[0].author.date) : null;
  const endDate = commits.length > 0 ? new Date(commits[commits.length - 1].author.date) : null;

  const formatDateRange = () => {
    if (!startDate || !endDate) return '--';
    const start = startDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    const end = endDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    return `${start} → ${end}`;
  };

  return (
    <div className="stats-panel">
      <div className="stats-header">
        <h2>
          <GitBranch size={18} />
          {repoInfo.owner}/{repoInfo.repo}
        </h2>
        <button onClick={onClose} className="close-btn">
          <X size={18} />
        </button>
      </div>

      <div className="stats-section">
        <h3>Repository</h3>
        <div className="stat-grid">
          <div className="stat-item">
            <FileCode size={16} />
            <span className="stat-value">{files}</span>
            <span className="stat-label">Files</span>
          </div>
          <div className="stat-item">
            <FolderTree size={16} />
            <span className="stat-value">{directories}</span>
            <span className="stat-label">Directories</span>
          </div>
          <div className="stat-item">
            <GitBranch size={16} />
            <span className="stat-value">{commits.length}</span>
            <span className="stat-label">Commits</span>
          </div>
          <div className="stat-item">
            <Users size={16} />
            <span className="stat-value">{authors.size}</span>
            <span className="stat-label">Contributors</span>
          </div>
        </div>
      </div>

      <div className="stats-section">
        <h3>
          <Clock size={16} />
          Timeline
        </h3>
        <p className="date-range">{formatDateRange()}</p>
      </div>

      <div className="stats-section">
        <h3>
          <Users size={16} />
          Top Contributors
        </h3>
        <div className="author-list">
          {sortedAuthors.map((author, index) => (
            <div key={author.email} className="author-item">
              <div className="author-rank">{index + 1}</div>
              <div
                className="author-avatar"
                style={{ backgroundColor: author.color }}
              >
                {author.avatarUrl ? (
                  <img src={author.avatarUrl} alt={author.name} />
                ) : (
                  <span>{author.name.charAt(0).toUpperCase()}</span>
                )}
              </div>
              <div className="author-info">
                <span className="author-name">{author.name}</span>
                <span className="author-commits">
                  {author.commitCount} commit{author.commitCount !== 1 ? 's' : ''}
                </span>
              </div>
              <div
                className="author-bar"
                style={{
                  width: `${(author.commitCount / sortedAuthors[0].commitCount) * 100}%`,
                  backgroundColor: author.color,
                }}
              />
            </div>
          ))}
        </div>
      </div>

      {currentCommit && (
        <div className="stats-section current-commit">
          <h3>Current Commit</h3>
          <div className="commit-detail">
            <code className="commit-sha">{currentCommit.sha.slice(0, 7)}</code>
            <p className="commit-msg">{currentCommit.message.split('\n')[0]}</p>
            <div className="commit-meta">
              <span>{currentCommit.author.name}</span>
              <span>•</span>
              <span>
                {new Date(currentCommit.author.date).toLocaleDateString()}
              </span>
            </div>
            {currentCommit.files.length > 0 && (
              <div className="commit-files">
                <span className="files-count">
                  {currentCommit.files.length} file{currentCommit.files.length !== 1 ? 's' : ''} changed
                </span>
                <div className="files-list">
                  {currentCommit.files.slice(0, 5).map(file => (
                    <div
                      key={file.filename}
                      className={`file-change ${file.status}`}
                    >
                      <span className="file-status">{file.status[0].toUpperCase()}</span>
                      <span className="file-name">
                        {file.filename.split('/').pop()}
                      </span>
                    </div>
                  ))}
                  {currentCommit.files.length > 5 && (
                    <div className="more-files">
                      +{currentCommit.files.length - 5} more
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
