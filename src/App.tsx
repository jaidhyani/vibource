import { useState, useCallback, useEffect, useRef } from 'react';
import type { FileNode, Author, Commit, RepoInfo } from './types';
import { parseRepoUrl, fetchCommitsWithFiles } from './services/git';
import { createFileTree, applyCommitToTree } from './utils/fileTree';
import Visualization from './components/Visualization';
import Controls from './components/Controls';
import RepoInput from './components/RepoInput';
import StatsPanel from './components/StatsPanel';
import { Info, X } from 'lucide-react';
import './App.css';

type AppState = 'input' | 'loading' | 'visualizing';

export default function App() {
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

  const playIntervalRef = useRef<number | null>(null);
  const treeRef = useRef<FileNode>(createFileTree());
  const authorsRef = useRef<Map<string, Author>>(new Map());

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

  // Playback control
  useEffect(() => {
    if (isPlaying && appState === 'visualizing') {
      const interval = 1000 / playbackSpeed;

      playIntervalRef.current = window.setInterval(() => {
        setCurrentCommitIndex(prev => {
          const next = prev + 1;
          if (next >= commits.length) {
            setIsPlaying(false);
            return prev;
          }
          processCommit(next);
          return next;
        });
      }, interval);
    }

    return () => {
      if (playIntervalRef.current) {
        clearInterval(playIntervalRef.current);
        playIntervalRef.current = null;
      }
    };
  }, [isPlaying, playbackSpeed, commits.length, processCommit, appState]);

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
  }, []);

  // Start playback automatically when visualization is ready
  useEffect(() => {
    if (appState === 'visualizing' && currentCommitIndex === -1 && commits.length > 0) {
      // Small delay before starting
      const timeout = setTimeout(() => {
        setIsPlaying(true);
        processCommit(0);
      }, 500);

      return () => clearTimeout(timeout);
    }
  }, [appState, currentCommitIndex, commits.length, processCommit]);

  const currentCommit = currentCommitIndex >= 0 ? commits[currentCommitIndex] : null;
  const currentDate = currentCommit ? new Date(currentCommit.author.date) : null;

  if (appState === 'input' || appState === 'loading') {
    return (
      <RepoInput
        onSubmit={handleRepoSubmit}
        isLoading={appState === 'loading'}
        loadingProgress={loadingProgress}
        error={error}
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
        <button
          onClick={() => setShowStats(!showStats)}
          className={`info-btn ${showStats ? 'active' : ''}`}
          title="Toggle stats panel"
        >
          {showStats ? <X size={20} /> : <Info size={20} />}
        </button>
      </header>

      <main className="app-main">
        <Visualization
          fileTree={fileTree}
          authors={authors}
          currentCommit={currentCommit}
          modifiedFiles={modifiedFiles}
          isPlaying={isPlaying}
        />

        {showStats && repoInfo && (
          <StatsPanel
            repoInfo={repoInfo}
            fileTree={fileTree}
            authors={authors}
            commits={commits}
            currentCommitIndex={currentCommitIndex}
            onClose={() => setShowStats(false)}
          />
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
