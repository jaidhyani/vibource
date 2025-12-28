import type { FileNode, Commit, Author } from '../types';

// ============================================================================
// MEMOIZATION: Path → Node lookup Map for O(1) access
// ============================================================================

// Global lookup map maintained across tree operations
// Key: file path, Value: FileNode reference
let pathLookupMap: Map<string, FileNode> = new Map();

/**
 * Get the current path lookup map (for debugging/testing)
 */
export function getPathLookupMap(): Map<string, FileNode> {
  return pathLookupMap;
}

/**
 * Reset the path lookup map (used when creating a new tree)
 */
export function resetPathLookup(): void {
  pathLookupMap = new Map();
}

/**
 * Build the lookup map from an existing tree (used after deserialization)
 */
export function buildPathLookup(root: FileNode): void {
  pathLookupMap = new Map();
  const stack: FileNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.path) {
      pathLookupMap.set(node.path, node);
    }
    if (node.children) {
      stack.push(...node.children);
    }
  }
}

/**
 * Fast O(1) lookup of a file by path
 */
export function findFileByPath(filepath: string): FileNode | null {
  return pathLookupMap.get(filepath) || null;
}

// ============================================================================
// ORIGINAL FUNCTIONS (with memoization integration)
// ============================================================================

// Generate consistent colors for authors based on their name
export function generateAuthorColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }

  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 60%)`;
}

// Get file extension for coloring
export function getFileExtension(filename: string): string {
  const parts = filename.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

// Color mapping for file types
export function getFileColor(filename: string): string {
  const ext = getFileExtension(filename);
  const colors: Record<string, string> = {
    // JavaScript/TypeScript
    js: '#f7df1e',
    jsx: '#61dafb',
    ts: '#3178c6',
    tsx: '#61dafb',
    // Python
    py: '#3776ab',
    // Rust
    rs: '#dea584',
    // Go
    go: '#00add8',
    // Java/Kotlin
    java: '#b07219',
    kt: '#a97bff',
    // C/C++
    c: '#555555',
    cpp: '#f34b7d',
    h: '#555555',
    hpp: '#f34b7d',
    // Web
    html: '#e34c26',
    css: '#563d7c',
    scss: '#c6538c',
    less: '#1d365d',
    // Data
    json: '#292929',
    yaml: '#cb171e',
    yml: '#cb171e',
    xml: '#0060ac',
    // Documentation
    md: '#083fa1',
    txt: '#888888',
    // Config
    toml: '#9c4221',
    ini: '#888888',
    env: '#ecd53f',
    // Shell
    sh: '#89e051',
    bash: '#89e051',
    zsh: '#89e051',
    // Default
    '': '#8da0cb',
  };

  return colors[ext] || '#8da0cb';
}

export function createFileTree(): FileNode {
  // Reset the lookup map when creating a new tree
  resetPathLookup();
  return {
    id: 'root',
    name: 'root',
    path: '',
    type: 'directory',
    children: [],
  };
}

export function addFileToTree(root: FileNode, filepath: string): FileNode | null {
  const parts = filepath.split('/');
  let current = root;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isFile = i === parts.length - 1;
    const currentPath = parts.slice(0, i + 1).join('/');

    if (!current.children) {
      current.children = [];
    }

    let child = current.children.find(c => c.name === part);

    if (!child) {
      child = {
        id: currentPath,
        name: part,
        path: currentPath,
        type: isFile ? 'file' : 'directory',
        children: isFile ? undefined : [],
        parent: current,
        color: isFile ? getFileColor(part) : undefined,
      };
      current.children.push(child);
      // Add to lookup map
      pathLookupMap.set(currentPath, child);
    }

    if (isFile) {
      return child;
    }

    current = child;
  }

  return null;
}

export function removeFileFromTree(root: FileNode, filepath: string): boolean {
  const parts = filepath.split('/');
  let current = root;
  const parents: FileNode[] = [root];

  // Navigate to the file
  for (let i = 0; i < parts.length - 1; i++) {
    const child = current.children?.find(c => c.name === parts[i]);
    if (!child) return false;
    parents.push(child);
    current = child;
  }

  // Remove the file
  const fileName = parts[parts.length - 1];
  const index = current.children?.findIndex(c => c.name === fileName) ?? -1;
  if (index === -1) return false;

  // Remove from lookup map
  pathLookupMap.delete(filepath);

  current.children?.splice(index, 1);

  // Clean up empty directories
  for (let i = parents.length - 1; i > 0; i--) {
    const parent = parents[i];
    if (parent.children?.length === 0 && parent.type === 'directory') {
      const grandParent = parents[i - 1];
      const idx = grandParent.children?.findIndex(c => c.id === parent.id) ?? -1;
      if (idx !== -1) {
        grandParent.children?.splice(idx, 1);
        // Also remove empty directory from lookup map
        pathLookupMap.delete(parent.path);
      }
    }
  }

  return true;
}

export function findFileInTree(root: FileNode, filepath: string): FileNode | null {
  // Try O(1) lookup first
  const cached = pathLookupMap.get(filepath);
  if (cached) return cached;

  // Fall back to tree traversal (for cases where lookup map might be out of sync)
  const parts = filepath.split('/');
  let current = root;

  for (const part of parts) {
    const child = current.children?.find(c => c.name === part);
    if (!child) return null;
    current = child;
  }

  // Add to lookup map for future access
  if (current.path) {
    pathLookupMap.set(current.path, current);
  }

  return current;
}

export function applyCommitToTree(
  root: FileNode,
  commit: Commit,
  authors: Map<string, Author>
): FileNode[] {
  const modifiedNodes: FileNode[] = [];
  const authorKey = commit.author.email || commit.author.name;

  // Update or add author
  let author = authors.get(authorKey);
  if (!author) {
    author = {
      name: commit.author.name,
      email: commit.author.email,
      login: commit.author.login,
      avatarUrl: commit.author.avatarUrl,
      commitCount: 0,
      color: generateAuthorColor(commit.author.name),
    };
    authors.set(authorKey, author);
  }
  author.commitCount++;

  // Apply file changes
  for (const file of commit.files) {
    let node: FileNode | null = null;

    switch (file.status) {
      case 'added':
        node = addFileToTree(root, file.filename);
        if (node) {
          node.status = 'added';
          node.lastModified = new Date(commit.author.date);
          node.lastAuthor = authorKey;
          modifiedNodes.push(node);
        }
        break;

      case 'modified':
        node = findFileInTree(root, file.filename);
        if (!node) {
          node = addFileToTree(root, file.filename);
        }
        if (node) {
          node.status = 'modified';
          node.lastModified = new Date(commit.author.date);
          node.lastAuthor = authorKey;
          modifiedNodes.push(node);
        }
        break;

      case 'removed':
        node = findFileInTree(root, file.filename);
        if (node) {
          node.status = 'removed';
          modifiedNodes.push(node);
        }
        // Actually remove the file from tree
        removeFileFromTree(root, file.filename);
        break;

      case 'renamed':
        if (file.previousFilename) {
          removeFileFromTree(root, file.previousFilename);
        }
        node = addFileToTree(root, file.filename);
        if (node) {
          node.status = 'modified';
          node.lastModified = new Date(commit.author.date);
          node.lastAuthor = authorKey;
          modifiedNodes.push(node);
        }
        break;
    }
  }

  return modifiedNodes;
}

export function flattenTree(node: FileNode): FileNode[] {
  const nodes: FileNode[] = [node];
  if (node.children) {
    for (const child of node.children) {
      nodes.push(...flattenTree(child));
    }
  }
  return nodes;
}

export interface TreeLink {
  source: FileNode;
  target: FileNode;
}

export function getTreeLinks(root: FileNode): TreeLink[] {
  const links: TreeLink[] = [];

  function traverse(node: FileNode) {
    if (node.children) {
      for (const child of node.children) {
        links.push({ source: node, target: child });
        traverse(child);
      }
    }
  }

  traverse(root);
  return links;
}

export function countNodes(root: FileNode): { files: number; directories: number } {
  let files = 0;
  let directories = 0;

  function traverse(node: FileNode) {
    if (node.type === 'file') {
      files++;
    } else {
      directories++;
    }
    node.children?.forEach(traverse);
  }

  traverse(root);
  return { files, directories: directories - 1 }; // Exclude root
}
