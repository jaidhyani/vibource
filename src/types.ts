export interface Commit {
  sha: string;
  message: string;
  author: {
    name: string;
    email: string;
    login?: string;
    avatarUrl?: string;
    date: string;
  };
  files: FileChange[];
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  previousFilename?: string;
}

export interface FileNode {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  parent?: FileNode;
  // For visualization
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
  vx?: number;
  vy?: number;
  // For animation
  lastModified?: Date;
  lastAuthor?: string;
  status?: 'added' | 'modified' | 'removed' | 'idle';
  color?: string;
}

export interface Author {
  name: string;
  email: string;
  login?: string;
  avatarUrl?: string;
  commitCount: number;
  color: string;
}

export interface VisualizationState {
  currentTime: Date;
  isPlaying: boolean;
  playbackSpeed: number;
  commits: Commit[];
  currentCommitIndex: number;
  fileTree: FileNode;
  authors: Map<string, Author>;
  activeAuthors: Map<string, { x: number; y: number; targetNode: FileNode }>;
}

export interface RepoInfo {
  owner: string;
  repo: string;
  branch: string;
}

export interface GitHubCommitResponse {
  sha: string;
  commit: {
    message: string;
    author: {
      name: string;
      email: string;
      date: string;
    };
  };
  author?: {
    login: string;
    avatar_url: string;
  };
  files?: {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    previous_filename?: string;
  }[];
}
