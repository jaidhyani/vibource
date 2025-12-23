import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import type { FileNode, Author, Commit, RepoInfo } from './types';
import { parseRepoUrl, fetchCommitsWithFiles } from './services/git';
import { createFileTree, applyCommitToTree } from './utils/fileTree';
import Controls from './components/Controls';
import RepoInput from './components/RepoInput';
import { Info, X, PanelRightOpen, PanelRightClose, PanelLeftOpen, PanelLeftClose } from 'lucide-react';
import './App.css';

// Lazy load heavy components for code splitting
const Visualization = lazy(() => import('./components/Visualization'));
const StatsPanel = lazy(() => import('./components/StatsPanel'));
const CommitSidebar = lazy(() => import('./components/CommitSidebar'));
const FileViewer = lazy(() => import('./components/FileViewer'));

// Loading fallback component
function LoadingFallback() {
  return (
    <div className="loading-fallback">
      <div className="loading-spinner" />
    </div>
  );
}

type AppState = 'input' | 'loading' | 'visualizing';

// URL state utilities
function getUrlParams(): { repo?: string; branch?: string; commits?: number; at?: number } {
  const params = new URLSearchParams(window.location.search);
  return {
    repo: params.get('repo') || undefined,
    branch: params.get('branch') || undefined,
    commits: params.get('commits') ? parseInt(params.get('commits')!, 10) : undefined,
    at: params.get('at') ? parseInt(params.get('at')!, 10) : undefined,
  };
}

function updateUrlParams(params: { repo?: string; branch?: string; commits?: number; at?: number }) {
  const url = new URL(window.location.href);
  if (params.repo) url.searchParams.set('repo', params.repo);
  else url.searchParams.delete('repo');
  if (params.branch) url.searchParams.set('branch', params.branch);
  else url.searchParams.delete('branch');
  if (params.commits) url.searchParams.set('commits', String(params.commits));
  else url.searchParams.delete('commits');
  if (params.at !== undefined && params.at >= 0) url.searchParams.set('at', String(params.at));
  else url.searchParams.delete('at');
  window.history.replaceState({}, '', url.toString());
}

export default function App() {
  // Parse initial URL params
  const [urlParams] = useState(getUrlParams);

  const [appState, setAppState] = useState<AppState>('input');
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [currentCommitIndex, setCurrentCommitIndex] = useState(-1);
  const [fileTree, setFileTree] = useState<FileNode>(createFileTree());
  const [authors, setAuthors] = useState<Map<string, Author>>(new Map());
  const [modifiedFiles, setModifiedFiles] = useState<FileNode[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [loadingProgress, setLoadingProgress] = useState<{ phase: string; loaded: number; total: number | null }>({ phase: '', loaded: 0, total: null });
  const [error, setError] = useState<string | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showFilePanel, setShowFilePanel] = useState(true);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const playIntervalRef = useRef<number | null>(null);
  const treeRef = useRef<FileNode>(createFileTree());
  const authorsRef = useRef<Map<string, Author>>(new Map());
  const lastPlaybackTimeRef = useRef<number>(0);
  const commitsRef = useRef<Commit[]>([]);
  const currentIndexRef = useRef<number>(-1);

  // Keep refs in sync with state
  commitsRef.current = commits;
  currentIndexRef.current = currentCommitIndex;

  // Handle repo submission
  const handleRepoSubmit = useCallback(async (repoUrl: string, branch?: string, commitCount?: number) => {
    const parsed = parseRepoUrl(repoUrl);
    if (!parsed) {
      setError('Invalid repository URL. Use format: owner/repo or full GitHub URL');
      return;
    }

    // Override branch if provided
    if (branch) {
      parsed.branch = branch;
    }

    setError(null);
    setAppState('loading');
    setRepoInfo(parsed);

    try {
      // Fetch commits with file changes (git clone handles branch detection)
      const fetchedCommits = await fetchCommitsWithFiles(
        parsed,
        commitCount || 1000,
        (phase, loaded, total) => setLoadingProgress({ phase, loaded, total })
      );

      if (fetchedCommits.length === 0) {
        setError('No commits found in this repository');
        setAppState('input');
        return;
      }

      // Reset state for new visualization
      treeRef.current = createFileTree();
      authorsRef.current = new Map();

      setCommits(fetchedCommits);
      setCurrentCommitIndex(-1);
      setFileTree(createFileTree());
      setAuthors(new Map());
      setModifiedFiles([]);
      setSelectedFile(null);
      setAppState('visualizing');
      setIsPlaying(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch repository data');
      setAppState('input');
    }
  }, []);

  // Process a single commit
  const processCommit = useCallback((index: number) => {
    if (index < 0 || index >= commits.length) return;

    const commit = commits[index];

    // Apply commit to tree
    const modified = applyCommitToTree(treeRef.current, commit, authorsRef.current);

    // Update state
    setFileTree({ ...treeRef.current });
    setAuthors(new Map(authorsRef.current));
    setModifiedFiles(modified);
    setCurrentCommitIndex(index);
  }, [commits]);

  // Playback control - uses requestAnimationFrame for consistent timing
  useEffect(() => {
    if (!isPlaying || appState !== 'visualizing') {
      if (playIntervalRef.current) {
        cancelAnimationFrame(playIntervalRef.current);
        playIntervalRef.current = null;
      }
      return;
    }

    const interval = 1000 / playbackSpeed;
    lastPlaybackTimeRef.current = performance.now();

    const tick = (now: number) => {
      const elapsed = now - lastPlaybackTimeRef.current;

      if (elapsed >= interval) {
        lastPlaybackTimeRef.current = now - (elapsed % interval); // Account for drift

        const nextIndex = currentIndexRef.current + 1;
        if (nextIndex >= commitsRef.current.length) {
          setIsPlaying(false);
          return;
        }

        // Apply commit directly using refs to avoid stale closures
        const commit = commitsRef.current[nextIndex];
        const modified = applyCommitToTree(treeRef.current, commit, authorsRef.current);

        setFileTree({ ...treeRef.current });
        setAuthors(new Map(authorsRef.current));
        setModifiedFiles(modified);
        setCurrentCommitIndex(nextIndex);
      }

      playIntervalRef.current = requestAnimationFrame(tick);
    };

    playIntervalRef.current = requestAnimationFrame(tick);

    return () => {
      if (playIntervalRef.current) {
        cancelAnimationFrame(playIntervalRef.current);
        playIntervalRef.current = null;
      }
    };
  }, [isPlaying, playbackSpeed, appState]);

  // Handle seeking
  const handleSeek = useCallback((targetIndex: number) => {
    // Reset tree and rebuild up to target index
    treeRef.current = createFileTree();
    authorsRef.current = new Map();

    for (let i = 0; i <= targetIndex; i++) {
      applyCommitToTree(treeRef.current, commits[i], authorsRef.current);
    }

    setFileTree({ ...treeRef.current });
    setAuthors(new Map(authorsRef.current));
    setCurrentCommitIndex(targetIndex);
    setModifiedFiles([]);
  }, [commits]);

  // Skip controls
  const handleSkipBack = useCallback(() => {
    if (currentCommitIndex > 0) {
      handleSeek(currentCommitIndex - 1);
    }
  }, [currentCommitIndex, handleSeek]);

  const handleSkipForward = useCallback(() => {
    if (currentCommitIndex < commits.length - 1) {
      processCommit(currentCommitIndex + 1);
    }
  }, [currentCommitIndex, commits.length, processCommit]);

  // Reset to input
  const handleReset = useCallback(() => {
    setAppState('input');
    setCommits([]);
    setCurrentCommitIndex(-1);
    treeRef.current = createFileTree();
    authorsRef.current = new Map();
    setFileTree(createFileTree());
    setAuthors(new Map());
    setModifiedFiles([]);
    setIsPlaying(false);
    setError(null);
    setShowStats(false);
    setSelectedFile(null);
  }, []);

  // Handle file selection
  const handleFileSelect = useCallback((path: string) => {
    setSelectedFile(prev => prev === path ? null : path);
  }, []);

  // Start playback automatically when visualization is ready
  useEffect(() => {
    if (appState === 'visualizing' && currentCommitIndex === -1 && commits.length > 0) {
      // Small delay before starting
      const timeout = setTimeout(() => {
        // Check if URL has a specific commit to jump to
        const targetIndex = urlParams.at !== undefined ? Math.min(urlParams.at, commits.length - 1) : 0;

        if (targetIndex > 0) {
          // Seek to the target commit
          for (let i = 0; i <= targetIndex; i++) {
            applyCommitToTree(treeRef.current, commitsRef.current[i], authorsRef.current);
          }
          setFileTree({ ...treeRef.current });
          setAuthors(new Map(authorsRef.current));
          setCurrentCommitIndex(targetIndex);
          setModifiedFiles([]);
          setIsPlaying(false); // Don't autoplay when seeking to specific commit
        } else {
          // Apply first commit
          const commit = commitsRef.current[0];
          if (commit) {
            const modified = applyCommitToTree(treeRef.current, commit, authorsRef.current);
            setFileTree({ ...treeRef.current });
            setAuthors(new Map(authorsRef.current));
            setModifiedFiles(modified);
            setCurrentCommitIndex(0);
          }
          setIsPlaying(true);
        }
      }, 500);

      return () => clearTimeout(timeout);
    }
  }, [appState, currentCommitIndex, commits.length, urlParams.at]);

  // Update URL when state changes
  useEffect(() => {
    if (repoInfo && appState === 'visualizing') {
      updateUrlParams({
        repo: `${repoInfo.owner}/${repoInfo.repo}`,
        branch: repoInfo.branch !== 'main' ? repoInfo.branch : undefined,
        commits: commits.length !== 1000 ? commits.length : undefined,
        at: currentCommitIndex > 0 ? currentCommitIndex : undefined,
      });
    } else if (appState === 'input') {
      // Clear URL params when going back to input
      updateUrlParams({});
    }
  }, [repoInfo, appState, currentCommitIndex, commits.length]);

  // Auto-load from URL params on mount
  useEffect(() => {
    if (urlParams.repo && appState === 'input') {
      handleRepoSubmit(urlParams.repo, urlParams.branch, urlParams.commits);
    }
  // Only run on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentCommit = currentCommitIndex >= 0 ? commits[currentCommitIndex] : null;
  const currentDate = currentCommit ? new Date(currentCommit.author.date) : null;

  if (appState === 'input' || appState === 'loading') {
    return (
      <RepoInput
        onSubmit={handleRepoSubmit}
        isLoading={appState === 'loading'}
        loadingProgress={loadingProgress}
        error={error}
        initialRepo={urlParams.repo}
        initialBranch={urlParams.branch}
        initialCommitCount={urlParams.commits}
      />
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <button onClick={handleReset} className="header-logo">
          <span className="logo-text">Vibource</span>
        </button>
        {repoInfo && (
          <button onClick={handleReset} className="repo-badge" title="Click to switch repository">
            <span>{repoInfo.owner}/{repoInfo.repo}</span>
            <span className="branch-badge">{repoInfo.branch}</span>
          </button>
        )}
        <div className="header-actions">
          <button
            onClick={() => setShowFilePanel(!showFilePanel)}
            className={`icon-btn ${showFilePanel && selectedFile ? 'active' : ''}`}
            title="Toggle file panel"
            disabled={!selectedFile}
          >
            {showFilePanel ? <PanelLeftClose size={20} /> : <PanelLeftOpen size={20} />}
          </button>
          <button
            onClick={() => setShowSidebar(!showSidebar)}
            className={`icon-btn ${showSidebar ? 'active' : ''}`}
            title="Toggle commit sidebar"
          >
            {showSidebar ? <PanelRightClose size={20} /> : <PanelRightOpen size={20} />}
          </button>
          <button
            onClick={() => setShowStats(!showStats)}
            className={`icon-btn ${showStats ? 'active' : ''}`}
            title="Toggle stats panel"
          >
            {showStats ? <X size={20} /> : <Info size={20} />}
          </button>
        </div>
      </header>

      <main className="app-main">
        {selectedFile && showFilePanel && (
          <Suspense fallback={<LoadingFallback />}>
            <FileViewer
              filePath={selectedFile}
              currentCommit={currentCommit}
              commits={commits}
              currentCommitIndex={currentCommitIndex}
              onClose={() => setSelectedFile(null)}
              onSeekToCommit={handleSeek}
            />
          </Suspense>
        )}

        <div className="main-content">
          <Suspense fallback={<LoadingFallback />}>
            <Visualization
              fileTree={fileTree}
              authors={authors}
              currentCommit={currentCommit}
              modifiedFiles={modifiedFiles}
              onFileSelect={handleFileSelect}
              selectedFile={selectedFile}
            />
          </Suspense>
        </div>

        {showSidebar && (
          <Suspense fallback={<LoadingFallback />}>
            <CommitSidebar
              currentCommit={currentCommit}
              modifiedFiles={modifiedFiles}
              onFileSelect={handleFileSelect}
              selectedFile={selectedFile}
            />
          </Suspense>
        )}

        {showStats && repoInfo && (
          <Suspense fallback={<LoadingFallback />}>
            <StatsPanel
              repoInfo={repoInfo}
              fileTree={fileTree}
              authors={authors}
              commits={commits}
              currentCommitIndex={currentCommitIndex}
              onClose={() => setShowStats(false)}
            />
          </Suspense>
        )}
      </main>

      <Controls
        isPlaying={isPlaying}
        onPlayPause={() => setIsPlaying(!isPlaying)}
        onSpeedChange={setPlaybackSpeed}
        currentSpeed={playbackSpeed}
        currentCommitIndex={currentCommitIndex}
        totalCommits={commits.length}
        onSeek={handleSeek}
        onSkipBack={handleSkipBack}
        onSkipForward={handleSkipForward}
        currentDate={currentDate}
      />
    </div>
  );
}
