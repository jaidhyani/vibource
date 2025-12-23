import { useState } from 'react';
import { Github, Key, Loader2, GitBranch } from 'lucide-react';

interface RepoInputProps {
  onSubmit: (repoUrl: string, token?: string) => void;
  isLoading: boolean;
  loadingProgress?: { loaded: number; total: number };
  error?: string | null;
}

export default function RepoInput({ onSubmit, isLoading, loadingProgress, error }: RepoInputProps) {
  const [repoUrl, setRepoUrl] = useState('');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (repoUrl.trim()) {
      onSubmit(repoUrl.trim(), token.trim() || undefined);
    }
  };

  const exampleRepos = [
    { name: 'React', url: 'facebook/react' },
    { name: 'Vue', url: 'vuejs/vue' },
    { name: 'Svelte', url: 'sveltejs/svelte' },
    { name: 'D3', url: 'd3/d3' },
  ];

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
            onClick={() => setShowToken(!showToken)}
          >
            <Key size={16} />
            {showToken ? 'Hide' : 'Add'} GitHub Token (optional)
          </button>

          {showToken && (
            <div className="input-group">
              <Key size={20} className="input-icon" />
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="GitHub personal access token"
                className="repo-input"
                disabled={isLoading}
              />
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
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: `${(loadingProgress.loaded / loadingProgress.total) * 100}%`,
                }}
              />
            </div>
            <p className="progress-text">
              Fetching commits: {loadingProgress.loaded} / {loadingProgress.total}
            </p>
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
            See contributors working on the codebase in real-time.
          </p>
          <p className="note">
            For private repos or higher API limits, add a GitHub token.
          </p>
        </div>
      </div>
    </div>
  );
}
