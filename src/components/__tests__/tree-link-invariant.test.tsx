/**
 * Regression test for PR #25.
 *
 * Before commit d3091d7, a non-structural commit (same file tree, different
 * currentCommit/modifiedFiles) left tree link DOM datums bound to plain
 * string source/target IDs, and renderGraph wrote x1="undefined" on every
 * line — tree links silently disappeared until the next structural change.
 *
 * This test fails against the buggy version and passes against the fixed one.
 */
import { render, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import Visualization from '../Visualization';
import { createFileTree, addFileToTree } from '../../utils/fileTree';
import type { Commit, Author, FileNode } from '../../types';

// Minimal tree with enough depth to produce multiple tree links.
function buildTree(): FileNode {
  const tree = createFileTree();
  addFileToTree(tree, 'src/a.ts');
  addFileToTree(tree, 'src/b.ts');
  addFileToTree(tree, 'src/components/c.tsx');
  addFileToTree(tree, 'src/components/d.tsx');
  addFileToTree(tree, 'README.md');
  return tree;
}

function buildCommit(index: number, modifiedPath: string): Commit {
  return {
    sha: `sha-${index}`,
    message: `commit ${index}`,
    author: {
      name: 'Test',
      email: 'test@example.com',
      date: new Date(2026, 0, index + 1).toISOString(),
    },
    files: [{ filename: modifiedPath, status: 'modified', additions: 1, deletions: 0 }],
  };
}

function finiteCoordinates(svg: HTMLElement): { total: number; finite: number; bad: string[] } {
  const lines = svg.querySelectorAll('g.links line');
  let finite = 0;
  const bad: string[] = [];
  lines.forEach((line) => {
    const attrs = ['x1', 'y1', 'x2', 'y2'].map((a) => line.getAttribute(a));
    const allFinite = attrs.every((v) => v !== null && v !== 'undefined' && Number.isFinite(parseFloat(v)));
    if (allFinite) finite++;
    else bad.push(JSON.stringify(Object.fromEntries(['x1', 'y1', 'x2', 'y2'].map((k, i) => [k, attrs[i]]))));
  });
  return { total: lines.length, finite, bad };
}

describe('tree link invariant', () => {
  it('tree links keep finite coordinates after a non-structural commit', async () => {
    const tree = buildTree();
    const authors = new Map<string, Author>();
    authors.set('test@example.com', {
      name: 'Test',
      email: 'test@example.com',
      commitCount: 1,
      color: '#abcdef',
    });

    const firstCommit = buildCommit(0, 'src/a.ts');

    // App.tsx does setFileTree({ ...treeRef.current }) on every commit, so
    // the fileTree prop must be a NEW object reference on each render even
    // when the structure is unchanged. If you pass the same reference twice
    // React skips the fileTree useEffect and the bug path never runs — the
    // test will pass on buggy code and be useless as a regression guard.
    const { container, rerender } = render(
      <Visualization
        fileTree={{ ...tree }}
        authors={authors}
        currentCommit={firstCommit}
        currentCommitIndex={0}
        modifiedFiles={[]}
        repoInfo={null}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    const before = finiteCoordinates(container);
    expect(before.total).toBeGreaterThan(0);
    expect(before.bad).toEqual([]);
    expect(before.finite).toBe(before.total);

    // NON-STRUCTURAL rerender: fresh tree spread, same node set,
    // new currentCommit object, new modifiedFiles array.
    const secondCommit = buildCommit(1, 'src/b.ts');
    const bNode = tree.children
      ?.find((c) => c.name === 'src')
      ?.children?.find((c) => c.name === 'b.ts');
    const secondModified: FileNode[] = bNode ? [bNode] : [];

    rerender(
      <Visualization
        fileTree={{ ...tree }}
        authors={authors}
        currentCommit={secondCommit}
        currentCommitIndex={1}
        modifiedFiles={secondModified}
        repoInfo={null}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    const after = finiteCoordinates(container);
    expect(after.total).toBe(before.total);
    expect(after.bad).toEqual([]);
    expect(after.finite).toBe(after.total);
  });
});
