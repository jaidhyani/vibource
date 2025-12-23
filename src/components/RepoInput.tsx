import { useState } from 'react';
import { Github, Loader2, GitBranch, Hash, Settings } from 'lucide-react';

interface RepoInputProps {
  onSubmit: (repoUrl: string, branch?: string, commitCount?: number) => void;
  isLoading: boolean;
  loadingProgress?: { phase: string; loaded: number; total: number | null };
  error?: string | null;
}

export default function RepoInput({ onSubmit, isLoading, loadingProgress, error }: RepoInputProps) {
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [commitCount, setCommitCount] = useState('1000');
  const [showOptions, setShowOptions] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (repoUrl.trim()) {
      const count = parseInt(commitCount, 10) || 1000;
      onSubmit(repoUrl.trim(), branch.trim() || undefined, count);
    }
  };

  const exampleRepos = [
    { name: 'React', url: 'facebook/react' },
    { name: 'Vue', url: 'vuejs/vue' },
    { name: 'Svelte', url: 'sveltejs/svelte' },
    { name: 'D3', url: 'd3/d3' },
  ];

  const progressPercent = loadingProgress?.total
    ? Math.round((loadingProgress.loaded / loadingProgress.total) * 100)
    : null;

  return (
    <div className="repo-input-container">
      <div className="repo-input-card">
        <div className="logo-section">
          <div className="logo">
            <GitBranch size={48} className="logo-icon" />
          </div>
          <h1>Vibource</h1>
          <p className="tagline">Visualize your repository's evolution</p>
        </div>

        <form onSubmit={handleSubmit} className="repo-form">
          <div className="input-group">
            <Github size={20} className="input-icon" />
            <input
              type="text"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="owner/repo or GitHub URL"
              className="repo-input"
              disabled={isLoading}
            />
          </div>

          <button
            type="button"
            className="token-toggle"
            onClick={() => setShowOptions(!showOptions)}
          >
            <Settings size={16} />
            {showOptions ? 'Hide' : 'Show'} Options
          </button>

          {showOptions && (
            <div className="options-section">
              <div className="input-group">
                <GitBranch size={20} className="input-icon" />
                <input
                  type="text"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="Branch (default: main)"
                  className="repo-input"
                  disabled={isLoading}
                />
              </div>
              <div className="input-group">
                <Hash size={20} className="input-icon" />
                <input
                  type="number"
                  value={commitCount}
                  onChange={(e) => setCommitCount(e.target.value)}
                  placeholder="Number of commits"
                  className="repo-input"
                  disabled={isLoading}
                  min={1}
                  max={10000}
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            className="submit-btn"
            disabled={isLoading || !repoUrl.trim()}
          >
            {isLoading ? (
              <>
                <Loader2 size={20} className="spinner" />
                Loading...
              </>
            ) : (
              <>
                <GitBranch size={20} />
                Visualize
              </>
            )}
          </button>
        </form>

        {isLoading && loadingProgress && (
          <div className="loading-progress">
            {progressPercent !== null ? (
              <>
                <div className="progress-bar">
                  <div
                    className="progress-fill"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <p className="progress-text">
                  {loadingProgress.phase} ({progressPercent}%)
                </p>
              </>
            ) : (
              <p className="progress-text">
                {loadingProgress.phase}
              </p>
            )}
          </div>
        )}

        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        <div className="examples">
          <p className="examples-label">Try an example:</p>
          <div className="example-buttons">
            {exampleRepos.map(repo => (
              <button
                key={repo.url}
                type="button"
                onClick={() => setRepoUrl(repo.url)}
                className="example-btn"
                disabled={isLoading}
              >
                {repo.name}
              </button>
            ))}
          </div>
        </div>

        <div className="info-text">
          <p>
            Watch your project grow from the first commit.
            See contributors working on the codebase over time.
          </p>
        </div>
      </div>
    </div>
  );
}
