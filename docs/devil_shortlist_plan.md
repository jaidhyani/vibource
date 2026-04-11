# Devil's Shortlist — Implementation Plan

**Goal:** Ship the low-risk wins from the devil's critique of `visualization_refactor_plan.md` — a regression test, a type narrowing that makes the PR #25 invariant compile-enforced, and three single-line bug fixes — as one PR. Separately, time-box an investigation of PRs #22/#23 to decide whether a finer oscillation fix exists before anyone commits to the larger `GraphRenderer` refactor.

**Architecture:** No new abstractions. Surgical edits to `src/components/Visualization.tsx`. One new test file. Vitest + jsdom + Testing Library are added as dev deps because the project currently has zero test infrastructure.

**Tech Stack:** React 19, d3 v7, TypeScript 5.9, Vite 7. Adding: Vitest, jsdom, `@testing-library/react`, `@testing-library/jest-dom`.

---

## Context for a fresh agent

You are picking up a task that was planned at the end of a session that will be `/clear`'d before execution. This file is your only durable context. Here is what you need to know before touching any code.

### What just shipped

PR #25 (`fix: keep tree link data valid on non-structural commits`, commit `d3091d7`) fixed a bug where tree links disappeared at high playback speed. The root cause was an undocumented invariant:

> `SimLink` datums bound to DOM line elements must have `source` and `target` as `SimNode` references, not string IDs.

The invariant was previously maintained as a *side effect* of `d3.forceLink.links(newLinks)`, which mutates its input array in place, replacing string IDs with `SimNode` references. An earlier optimization (PRs #22/#23, commit `1d96069`) stopped calling `forceLink.links()` on non-structural commits to avoid graph oscillation. That optimization silently broke the invariant, and `renderGraph` started writing `x1="undefined"` to every tree link until the next structural change.

The fix in PR #25 is two parts:
- `src/components/Visualization.tsx:442–446` — build `newLinks` with resolved `SimNode` refs up front.
- `src/components/Visualization.tsx:93–114` — defensive fallback in `renderGraph` that hides lines with missing coordinates.

Both are live on branch `worktree-missing_animations` and merged to `main` via PR #25 (https://github.com/jaidhyani/vibource/pull/25). Before starting this plan, **verify PR #25 is merged and pull `main`**. The line numbers below refer to the state of `src/components/Visualization.tsx` *after* PR #25 lands — if the merge commit hasn't shipped yet, re-read the file and re-anchor the line numbers yourself.

### Why this plan exists

The refactor plan at `docs/visualization_refactor_plan.md` proposes a ~400-line `GraphRenderer` class to eliminate the cross-cutting invariants that caused PR #25. The devil's advocate critique of that plan (last turn of the pre-clear conversation) argued that most of the value could be captured with much less code:

1. A regression test for the PR #25 bug (none currently exists).
2. A type narrowing so the invariant is compile-enforced.
3. Three single-line fixes for independent-but-related bugs.
4. A reconsideration of PRs #22/#23 — the optimization that caused PR #25 in the first place — which is the highest-leverage item but also the one requiring actual investigation rather than mechanical edits.

This plan executes items 1–3 as one PR (Tasks 1–6) and frames item 4 as a separate time-boxed investigation (Task 7) that **must not be committed in the same PR**.

### What is explicitly out of scope

- `src/viz/GraphRenderer.ts` and the 6-file split from `visualization_refactor_plan.md`. Revisit after Task 7 concludes.
- Any perf optimization to the `nodeGroup.selectAll().filter()` hot path (lines 658–659). Devil correctly pointed out the "1M filter iterations/sec" claim was unmeasured and likely not the true hot path. Do not touch it without a flamegraph.
- Any change to author-link fade duration or animation timing. Scoped out; cosmetic.
- Deleting the `renderGraph` defensive fallback from PR #25. It stays as belt-and-suspenders even after the type narrowing.

---

## Hot-path sequence (required by Plan Mode hook)

The sequence of events that produces the bug this plan's regression test guards against. Each `→` is one synchronous step the test must drive.

```
1. mount <Visualization fileTree={treeWithFiles} modifiedFiles={[]} currentCommit={null} ... />
2. wait for first useEffect pass → simulation created, nodes bound, DOM has N <line> elements with finite x1/y1/x2/y2
3. assert: all g.links line have finite numeric x1/y1/x2/y2
4. re-render with same tree (same node set, same link set) but a new currentCommit object and non-empty modifiedFiles
   — this is a NON-STRUCTURAL update: addedNodeIds.size === 0, removedNodeIds.size === 0, hasStructuralChanges === false
5. wait for useEffect pass → fileTree effect runs, rebuilds newLinks, data-binds linkSelection, calls renderGraph(true)
6. assert AGAIN: all g.links line have finite numeric x1/y1/x2/y2

Before PR #25 (commit d3091d7^): step 6 fails — every line has x1="undefined".
After PR #25 (commit d3091d7):   step 6 passes.
```

That sequence is the literal failure mode. Task 2 turns it into a test named `tree-link-invariant.test.tsx::tree links keep finite coordinates after a non-structural commit` (see Task 2 for the exact name and code).

---

## External Contracts

- **d3-force (`d3.forceSimulation`, `d3.forceLink`, `d3.forceCenter`, `d3.forceCollide`, `d3.forceManyBody`, `d3.forceRadial`)** — `forceLink.links(array)` mutates its input array in place, replacing string `source`/`target` with node references via the `.id(...)` accessor. **Invariant this plan preserves:** any code path that binds a link datum to the DOM must pre-resolve `source`/`target` to `SimNode` references, so the DOM binding is valid regardless of whether `forceLink.links()` was called this tick. PR #25 already establishes this; the type split in Task 3 makes it a compile-time error to violate.
- **d3-selection data joins** — `selection.data(newArray, keyFn)` rebinds existing DOM elements to objects from `newArray`. The old datum is discarded. **Invariant:** the key function must use stable node IDs, not object identity, or matched elements will swap datums randomly on every update.
- **React 19 useEffect ordering** — effects run in declaration order after commit, so the `fileTree` effect (declared first in `Visualization.tsx`) populates `nodesRef.current` before the `modifiedFiles` effect (declared later) reads it. **Invariant:** no task in this plan reorders `useEffect` declarations or breaks this ordering. The test in Task 2 will catch any regression here because the "non-structural commit" scenario depends on this ordering.
- **GitHub PR review via `gh`** — `gh pr create` against `jaidhyani/vibource`. No branch protection changes. **Invariant:** the PR body includes the regression-test-fail-before / pass-after evidence as a checklist item so reviewers don't have to re-verify.

## Assumptions

- **Vitest + jsdom run the Visualization component well enough to catch the PR #25 bug.** **Verified** on branch `worktree-missing_animations` in the planning session: the test exercises the synchronous `renderGraph(true)` call at the end of the fileTree effect (no async settling needed) and goes red against `d3091d7^` / green against `d3091d7`. Two jsdom gaps must be stubbed in `src/test-setup.ts`: (a) `SVGSVGElement.prototype.width`/`height` animated length properties (d3-zoom reads `.baseVal.value`), (b) `SVGElement.prototype.getBBox` (used for label sizing at `Visualization.tsx:548`). Exact stub code is inlined in Task 1.
- **PR #25 is merged to `main` by the time this plan runs.** If not, the fresh agent must rebase off `worktree-missing_animations` instead and note the deviation.
- **Line numbers in this plan match the post-merge `main`.** Re-verify with `grep -n` before editing; don't hard-code. Every task below uses `grep -n` to re-anchor before any edit.
- **`d3.forceSimulation` accepts typed generics that let us split `TreeLink` / `AuthorLink`.** Checked against the 12 `SimLink` usage sites in the current file — the simulation's `forceLink` only ever holds *tree* links (never author links, which are DOM-only and never fed to `simulation.force('link').links(...)`). If this assumption is wrong, Task 3 bails to "one union type with a discriminant field" and notes the finding.
- **The visibility-handler deletion (Task 4, step 3) is safe because the tick handler keeps author-link positions current.** The tick handler's `authorLinkSelection.each(...)` block at lines 105–151 updates `x1/y1/x2/y2` for every author link every tick, reading positions from `nodesRef.current`. On tab-show, the simulation restarts via `.alpha(0.1).restart()` (line 166), which triggers ticks, which update positions. No code path depends on the `.remove()`.
- **Task 7 can be time-boxed to ~90 minutes.** If reading `d3-force` source and reproducing the oscillation takes longer, stop and write up what was learned in a new `docs/oscillation_investigation.md` — do not expand scope to "I'll just also refactor it while I'm here."

---

## File map

**Create:**
- `src/components/__tests__/tree-link-invariant.test.tsx` — the one and only regression test this plan adds.
- `vitest.config.ts` — Vitest configuration. Inline with Vite config to minimize new surface.
- `src/test-setup.ts` — loads `@testing-library/jest-dom` matchers and any d3-timer workaround.
- `docs/oscillation_investigation.md` — **created only by Task 7**, separate from the PR 1–6 branch.

**Modify:**
- `package.json` — add `test` script and new devDependencies.
- `src/components/Visualization.tsx` — four edits: type split (Task 3), throttle fix (Task 5 step 1), init-effect dep fix (Task 5 step 2), visibility-handler line deletion (Task 5 step 3).
- `tsconfig.app.json` — add `"types": ["vitest/globals"]` if Vitest globals are used; otherwise untouched.

**Do not touch:**
- Anything under `src/services/`, `src/utils/`, `src/App.tsx`.
- Any existing effect declaration order in `Visualization.tsx`.
- The defensive fallback in `renderGraph` at lines 93–114 (from PR #25). It stays.

---

## Task 0 — Branch setup and ground truth

**Files:** none (git + filesystem only)

- [ ] **Confirm the starting branch and PR #25 state.**
  Run:
  ```bash
  cd /home/jai/projects/vibource   # NOTE: this task is NOT executed inside a worktree
  git fetch origin
  git log origin/main --oneline -5
  gh pr view 25 --json state,mergedAt
  ```
  Expected: `gh pr view 25` shows `"state": "MERGED"`. The top of `origin/main` includes a merge commit for PR #25.
  **If not merged:** stop. Either wait for merge, or if the plan author explicitly said to proceed, rebase this work on top of `worktree-missing_animations` instead and note the deviation in Task 6's PR body.

- [ ] **Create a fresh worktree off main for this work.**
  Run:
  ```bash
  claude --worktree devil-shortlist
  # this creates .claude/worktrees/devil-shortlist/ and checks out branch worktree-devil-shortlist
  cd /home/jai/projects/vibource/.claude/worktrees/devil-shortlist
  ```
  Expected: working tree is clean, branch is `worktree-devil-shortlist`, and `src/components/Visualization.tsx` line 442 reads `const linkNodeMap = nodesRef.current;` (confirming the PR #25 fix is present on main).

- [ ] **Re-anchor every line number in this plan.**
  Run:
  ```bash
  grep -n "interface SimLink" src/components/Visualization.tsx
  grep -n "lastTickRef.current = now" src/components/Visualization.tsx
  grep -n "selectAll('\\*').remove()" src/components/Visualization.tsx
  grep -n "}, \\[dimensions\\])" src/components/Visualization.tsx
  ```
  Record the actual line numbers in a scratch note. The rest of the plan refers to "the line that reads X" — not a hard-coded number. If any of these greps returns zero results, stop and re-read the file from scratch: the code has drifted.

- [ ] **Confirm no existing test infrastructure.**
  Run:
  ```bash
  grep -l vitest package.json || echo "no vitest yet"
  ls src/**/*.test.* 2>/dev/null || echo "no existing tests"
  ```
  Expected: both say "no". If vitest already exists, skip the relevant install steps in Task 1 but still run the verification commands.

- [ ] **No commit for Task 0.** It's verification only.

---

## Task 1 — Install test infrastructure

**Files:** Modify: `package.json`, `vitest.config.ts` (new), `src/test-setup.ts` (new), `tsconfig.app.json`

- [ ] **Install dev dependencies.**
  Run:
  ```bash
  npm install --save-dev vitest@^3 jsdom@^25 @testing-library/react@^16 @testing-library/jest-dom@^6 @testing-library/dom@^10
  ```
  Expected: `package.json` gains the five entries under `devDependencies`. If npm errors on a peer dep mismatch with React 19, try `@testing-library/react@^16.2.0` explicitly — 16.0 through 16.2 have React 19 compat.

- [ ] **Create `vitest.config.ts`.**
  File content:
  ```ts
  import { defineConfig } from 'vitest/config';
  import react from '@vitejs/plugin-react';

  export default defineConfig({
    plugins: [react()],
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test-setup.ts'],
    },
  });
  ```

- [ ] **Create `src/test-setup.ts`.**
  File content (verified to work in planning session — do not simplify):
  ```ts
  import '@testing-library/jest-dom/vitest';

  // jsdom does not implement SVG animated length properties or layout
  // primitives. d3-zoom reads this.width.baseVal.value on the root <svg>
  // element (see d3-zoom/src/zoom.js defaultExtent), and the visualization
  // uses getBBox() to size directory labels. Stub both so the component can
  // render to completion in tests.

  function animatedLengthFromAttr(el: Element, attr: string): { baseVal: { value: number } } {
    const raw = el.getAttribute(attr);
    const value = raw ? parseFloat(raw) : 0;
    return { baseVal: { value: Number.isFinite(value) ? value : 0 } };
  }

  if (typeof SVGSVGElement !== 'undefined') {
    Object.defineProperty(SVGSVGElement.prototype, 'width', {
      configurable: true,
      get() { return animatedLengthFromAttr(this, 'width'); },
    });
    Object.defineProperty(SVGSVGElement.prototype, 'height', {
      configurable: true,
      get() { return animatedLengthFromAttr(this, 'height'); },
    });
  }

  if (typeof SVGElement !== 'undefined' && !('getBBox' in SVGElement.prototype)) {
    (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
      ({ x: 0, y: 0, width: 50, height: 12, top: 0, left: 0, right: 50, bottom: 12, toJSON: () => ({}) } as DOMRect);
  }
  ```

- [ ] **Add a `test` script to `package.json`.**
  Edit the `"scripts"` block so it reads:
  ```json
  {
    "scripts": {
      "dev": "vite",
      "build": "tsc -b && vite build",
      "lint": "eslint .",
      "preview": "vite preview",
      "test": "vitest run",
      "test:watch": "vitest"
    }
  }
  ```

- [ ] **Add Vitest globals type reference to `tsconfig.app.json`.**
  In the `compilerOptions.types` array (add it if missing), include `"vitest/globals"` and `"@testing-library/jest-dom"`. If the file has no `types` field, add:
  ```json
  "types": ["vitest/globals", "@testing-library/jest-dom"]
  ```
  inside `compilerOptions`. Do **not** change any other compiler option.

- [ ] **Verify the empty suite runs.**
  Run:
  ```bash
  npm run test
  ```
  Expected: Vitest starts, reports "No test files found" or similar, exits 0. (Some Vitest versions exit 1 when no tests are found — if so, that's fine; Task 2 immediately adds one.)

- [ ] **Commit.**
  ```bash
  git add package.json package-lock.json vitest.config.ts src/test-setup.ts tsconfig.app.json
  git commit -m "chore: add vitest + jsdom + testing-library for regression tests"
  ```

---

## Task 2 — Write the regression test (fails before fix, passes now)

**Files:** Create: `src/components/__tests__/tree-link-invariant.test.tsx`

The test drives the literal hot-path sequence from the "Hot-path sequence" section above. It constructs a file tree with enough nodes to have tree links, mounts `Visualization`, re-renders with a **non-structural** update, and asserts every `g.links line` still has finite numeric coordinates.

- [ ] **Create the test file.**
  File path: `src/components/__tests__/tree-link-invariant.test.tsx`

  File content:
  ```tsx
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
  ```

- [ ] **Run the test against the current code.**
  Run:
  ```bash
  npm run test -- tree-link-invariant
  ```
  Expected: **PASS.** (PR #25 is already merged, so the invariant holds.) The `[smoke]` console output should show `before: { total: 7, bad: [] }` and `after: { total: 7, bad: [] }` — 7 tree links derived from the fixture (`src/`, `src/a.ts`, `src/b.ts`, `src/components/`, `src/components/c.tsx`, `src/components/d.tsx`, `README.md`).

- [ ] **Run the test against the pre-fix code to prove it's meaningful.**
  In the planning session this returned **7 bad lines**, each `{"x1":null,"y1":null,"x2":null,"y2":null}`.

  Find the fix commit by content-search (survives squash-merge of PR #25):
  ```bash
  FIX_COMMIT=$(git log --all --format=%H -S 'const linkNodeMap = nodesRef.current' -- src/components/Visualization.tsx | head -1)
  echo "fix commit: $FIX_COMMIT"
  test -n "$FIX_COMMIT" || { echo "could not locate fix commit — escalate"; exit 1; }
  cp src/components/Visualization.tsx /tmp/visualization.post-fix.tsx
  git show "${FIX_COMMIT}^:src/components/Visualization.tsx" > src/components/Visualization.tsx
  npm run test -- tree-link-invariant
  ```
  Expected: **FAIL** with `after.bad` containing 7 entries like `{"x1":null,"y1":null,"x2":null,"y2":null}`.

  Then restore:
  ```bash
  cp /tmp/visualization.post-fix.tsx src/components/Visualization.tsx
  rm /tmp/visualization.post-fix.tsx
  npm run test -- tree-link-invariant
  ```
  Confirm green again.

  **If the test does NOT fail on the pre-fix code**, you've almost certainly regressed one of these verified-critical details:
  1. `fileTree={{ ...tree }}` spreads in both the `render` and `rerender` — passing the same reference twice skips the fileTree useEffect and makes the test useless.
  2. The `src/test-setup.ts` stubs are in place — without them the test crashes on `baseVal` instead of running to completion.
  3. The `await act(async () => { await Promise.resolve(); })` flush between `render` and assertion.
  Do not proceed with Tasks 3–6 without a red-green verified test.

- [ ] **Commit.**
  ```bash
  git add src/components/__tests__/tree-link-invariant.test.tsx
  git commit -m "test: add regression test for tree-link finite coordinates invariant"
  ```

---

## Task 3 — Split `SimLink` → `TreeLink` + `AuthorLink`

**Files:** Modify: `src/components/Visualization.tsx`

**Why a split, not a narrow-in-place:** Author links legitimately carry string `source`/`target` (the tick handler resolves them via `nodeMap.get(...)` on every tick, see lines 105–151), and they are rendered to DOM but **never fed to `simulation.force('link').links(...)`**. Tree links are the opposite — fed to the simulation and rendered to DOM, and must hold `SimNode` refs. Collapsing them into a single type is what allowed PR #25 to happen.

The simulation's typed generic `d3.Simulation<SimNode, TreeLink>` becomes expressive enough to make it a **type error** to feed an `AuthorLink` into `simulation.force('link').links(...)`.

- [ ] **Add the two new interfaces, remove `SimLink`.**
  Find the current interface (around line 34) and replace:

  ```ts
  interface SimLink extends d3.SimulationLinkDatum<SimNode> {
    source: SimNode | string;
    target: SimNode | string;
    isAuthorLink?: boolean;
    changeSize?: number;
  }
  ```

  with:

  ```ts
  // Tree links (dir→child). Always hold resolved SimNode refs because the
  // simulation's forceLink.links() mutates its input array to replace string
  // ids with refs — PR #25 had the bug that this happened only on structural
  // commits. Making the type ref-only means the DOM binding cannot hold
  // strings in the first place, so the invariant is compile-enforced.
  interface TreeLink extends d3.SimulationLinkDatum<SimNode> {
    source: SimNode;
    target: SimNode;
  }

  // Author links are DOM-only overlays rendered between an author node and
  // the files they touched in the current commit. They carry string ids
  // because endpoints are looked up dynamically in the tick handler against
  // two node maps (file nodes + author nodes). They are never fed to the
  // simulation's forceLink.
  interface AuthorLink extends d3.SimulationLinkDatum<SimNode> {
    source: SimNode | string;
    target: SimNode | string;
    changeSize: number;
  }
  ```

  Note: `isAuthorLink` is dropped — the type itself discriminates, no runtime flag needed.

- [ ] **Update `simulationRef`.**
  Find the line that reads `useRef<d3.Simulation<SimNode, SimLink> | null>(null)`. Replace `SimLink` with `TreeLink`.

- [ ] **Update `linkSelectionRef`.**
  Find the `linkSelectionRef` declaration. Replace its `SimLink` with `TreeLink`.

- [ ] **Update `authorLinkSelectionRef`.**
  Find the `authorLinkSelectionRef` declaration. Replace its `SimLink` with `AuthorLink`.

- [ ] **Update the `forceLink` generic in the init effect.**
  Find `d3.forceLink<SimNode, SimLink>([])` (inside the `d3.forceSimulation<SimNode>([])` chain). Replace `SimLink` with `TreeLink`.

- [ ] **Update `newLinks` construction.**
  Find the block that reads:
  ```ts
  const linkNodeMap = nodesRef.current;
  const newLinks: SimLink[] = links.map(link => ({
    source: linkNodeMap.get(link.source.id) ?? link.source.id,
    target: linkNodeMap.get(link.target.id) ?? link.target.id,
  }));
  ```
  Replace with:
  ```ts
  const linkNodeMap = nodesRef.current;
  // TreeLink requires resolved SimNode refs — if a node is missing here,
  // the tree is internally inconsistent, so drop the link rather than
  // fabricate a half-valid one.
  const newLinks: TreeLink[] = links.flatMap(link => {
    const source = linkNodeMap.get(link.source.id);
    const target = linkNodeMap.get(link.target.id);
    if (!source || !target) return [];
    return [{ source, target }];
  });
  ```
  This is the key change: the type signature alone now forbids string ids, and the `flatMap` drop replaces the previous "fall back to string" escape hatch.

- [ ] **Update `forceLink.links(...)` cast.**
  Find `(simulation.force('link') as d3.ForceLink<SimNode, SimLink>).links(newLinks);`. Replace `SimLink` with `TreeLink`.

- [ ] **Update `linkGroup.selectAll<...>('line')` inside the fileTree effect.**
  Find `linkGroup.selectAll<SVGLineElement, SimLink>('line')`. Replace `SimLink` with `TreeLink`.

- [ ] **Update the `linkSelectionRef.current = linkGroup.selectAll(...)` reassignment.**
  Same as above — replace `SimLink` with `TreeLink`.

- [ ] **Update `authorLinks` construction.**
  Find:
  ```ts
  const authorLinks: SimLink[] = modifiedPositions.map(pos => ({
    source: authorId,
    target: pos.id,
    isAuthorLink: true,
    changeSize: pos.changeSize,
  }));
  ```
  Replace with:
  ```ts
  const authorLinks: AuthorLink[] = modifiedPositions.map(pos => ({
    source: authorId,
    target: pos.id,
    changeSize: pos.changeSize,
  }));
  ```
  Note: `isAuthorLink: true` is removed because the type is the discriminator now.

- [ ] **Update the two `authorLinkGroup.selectAll<...>('line.author-link')` sites.**
  Find both (one is the data-bound selection inside the modifiedFiles effect; the other is the `authorLinkSelectionRef.current = ...` reassignment). Replace each `SimLink` with `AuthorLink`.

- [ ] **Update the tick handler's `linkSelection.each(...)` typings if needed.**
  The callback at `renderGraph` reads `d.source` / `d.target`. With `TreeLink`, `d.source` is now always `SimNode`, never `string`. Find the `if (typeof d.source === 'string') ...` branch in the tree-links block (this came from PR #25's defensive fallback) and note: **do not delete it yet.** TypeScript will narrow `typeof d.source === 'string'` to `never`, which is a signal the branch is unreachable. Keep it as a belt-and-suspenders runtime guard — add a comment:
  ```ts
  // Runtime guard retained even though the type forbids strings, so a
  // future refactor that re-introduces string ids can't silently regress.
  ```
  The author-links block (which *does* legitimately handle string ids) stays unchanged.

- [ ] **Remove the `isAuthorLink` field from any remaining reader.**
  Run `grep -n isAuthorLink src/components/Visualization.tsx`. Expected: zero matches. If anything still reads it, either convert it to a type check (`link is AuthorLink` via the shape of `AuthorLink` vs `TreeLink`) or delete the dead branch.

- [ ] **Typecheck.**
  Run:
  ```bash
  npx tsc -b
  ```
  Expected: clean. If there are errors, they're almost certainly in one of the 12 sites above — re-grep `grep -n SimLink src/components/Visualization.tsx` (expected: zero matches), and fix whatever site was missed.

- [ ] **Run the regression test.**
  Run:
  ```bash
  npm run test -- tree-link-invariant
  ```
  Expected: **PASS.** If it fails, the type split broke the runtime behavior — most likely the `flatMap` drop-on-missing is removing links that the previous "fall back to string" path preserved. Check by logging `newLinks.length` vs `links.length` and compare against the total in the current test fixture. If they differ, the node map is missing entries; check the `existingNodes`/`newNodes` construction in the fileTree effect.

- [ ] **Commit.**
  ```bash
  git add src/components/Visualization.tsx
  git commit -m "refactor: split SimLink into TreeLink + AuthorLink to compile-enforce PR #25 invariant"
  ```

---

## Task 4 — Throttle fix (one line)

**Files:** Modify: `src/components/Visualization.tsx`

The `renderGraph` callback bypasses its 30fps throttle via a `forceRender` parameter, but unconditionally writes `lastTickRef.current = now` on every call, including forced ones. This means the next *genuine* simulation tick within the 33ms throttle window gets dropped, even though a forced render just happened. At high commit rates, forced renders happen on every fileTree update, so real ticks are dropped regularly.

- [ ] **Find the throttle block.**
  Run:
  ```bash
  grep -n "lastTickRef.current = now" src/components/Visualization.tsx
  ```
  Note the line number.

- [ ] **Edit.**
  Current shape (around line 86):
  ```ts
  const renderGraph = useCallback((forceRender = false) => {
    const now = performance.now();
    if (!forceRender && now - lastTickRef.current < TICK_INTERVAL) {
      return;
    }
    lastTickRef.current = now;
    // ...
  ```
  New shape — move the `lastTickRef.current = now` inside the `!forceRender` branch so forced renders don't consume the throttle budget:
  ```ts
  const renderGraph = useCallback((forceRender = false) => {
    const now = performance.now();
    if (!forceRender) {
      // Throttle to 30fps: skip if we're inside the previous tick window.
      // Forced renders bypass the throttle AND don't consume the budget,
      // so a forced render followed by a natural tick still renders.
      if (now - lastTickRef.current < TICK_INTERVAL) return;
      lastTickRef.current = now;
    }
    // ...
  ```

- [ ] **Typecheck and regression test.**
  ```bash
  npx tsc -b && npm run test -- tree-link-invariant
  ```
  Expected: both pass.

- [ ] **Commit.**
  ```bash
  git add src/components/Visualization.tsx
  git commit -m "fix: don't consume renderGraph throttle budget on forced renders"
  ```

---

## Task 5 — Init-effect dep fix (one line)

**Files:** Modify: `src/components/Visualization.tsx`

The SVG init effect has `[dimensions]` in its dep array but guards its body with `if (initializedRef.current) return;`. When `dimensions` first changes (the post-mount resize observer callback), React runs the effect's cleanup (`simulation.stop()`), then re-runs the effect — which early-exits without re-creating anything. The simulation is left permanently stopped until some other effect reheats it via `.alpha().restart()`.

Recentering on resize is already handled by a *separate* effect later in the file ("Recenter view when dimensions change"), so the init effect has no legitimate reason to depend on dimensions.

- [ ] **Find the init effect's dep array.**
  Run:
  ```bash
  grep -n "Set up tick handler once" src/components/Visualization.tsx
  ```
  The dep array `}, [dimensions]);` is a few lines below the tick handler setup.

- [ ] **Edit.**
  Change `}, [dimensions]);` at the end of the init effect to `}, []);`.

  Add a brief comment above it:
  ```ts
  // Init runs exactly once. Dimensions are applied by the separate
  // "Recenter view" effect below — depending on them here would tear
  // down the simulation on first resize without re-creating it.
  }, []);
  ```

  **ESLint will complain** (`react-hooks/exhaustive-deps` warning for `dimensions` usage inside the effect). That's intentional — the rule is wrong for this case because the body is gated by `initializedRef`. Add an inline disable comment on the line above:
  ```ts
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  ```

- [ ] **Confirm the recenter effect still does its job.**
  Verify by reading the next effect in the file (it's the "Recenter view when dimensions change" one). It should already be `useEffect(() => { ... }, [dimensions])` and call `svg.call(zoomRef.current.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(0.8))`. If not, this task needs rethinking — escalate.

- [ ] **Typecheck, lint, regression test.**
  ```bash
  npx tsc -b && npm run lint 2>&1 | grep -v "^/home" | head -20 && npm run test -- tree-link-invariant
  ```
  Expected: tsc clean, lint has no *new* errors (pre-existing warnings in other files are fine), test passes.

- [ ] **Manual smoke test (required because this effect governs the simulation lifecycle).**
  ```bash
  npm run dev -- --port 5181 &
  DEV_PID=$!
  sleep 3
  # open http://localhost:5181/?repo=jaidhyani/vibource&commits=50&at=0 in a browser
  # verify: tree nodes animate on first load, resize the window, verify tree still animates
  kill $DEV_PID
  ```
  Expected: no visible regression. If the simulation is stuck after a resize, the fix is incomplete — the recenter effect may also be inadvertently stopping the simulation. Investigate before committing.

- [ ] **Commit.**
  ```bash
  git add src/components/Visualization.tsx
  git commit -m "fix: don't tear down simulation on first dimension change"
  ```

---

## Task 6 — Visibility-handler line deletion (one line)

**Files:** Modify: `src/components/Visualization.tsx`

When the tab becomes visible, the handler wipes all children of `g.author-links` with `selectAll('*').remove()` on the theory that author links "may be in weird states." They aren't — the tick handler's `authorLinkSelection.each(...)` block writes `x1/y1/x2/y2` on every tick, reading positions from the node map. On tab show, `simulation.alpha(0.1).restart()` triggers ticks, which update positions. Deleting the line removes the visual flicker on tab show.

- [ ] **Find the line.**
  Run:
  ```bash
  grep -n "selectAll('\\*').remove()" src/components/Visualization.tsx
  ```
  Expected: exactly one match, inside the visibility-change `useEffect`.

- [ ] **Delete that line.** Also delete the preceding comment `// Remove transient author links (they may be in weird states)` since the rationale no longer applies.

- [ ] **Add a replacement comment explaining WHY we *don't* remove them.** One line:
  ```ts
  // Don't clear author links on resume: the tick handler rewrites their
  // coordinates every frame from nodesRef, so whatever stale state is on
  // them is about to be overwritten.
  ```

- [ ] **Regression test.**
  ```bash
  npm run test -- tree-link-invariant
  ```
  Expected: pass. (This change doesn't touch tree links, but running the test keeps the task habit consistent.)

- [ ] **Manual smoke test.**
  ```bash
  npm run dev -- --port 5181 &
  DEV_PID=$!
  sleep 3
  # open in browser, start playback, switch to another tab for 5 seconds, switch back
  # verify: no flicker of author links on tab resume, links remain connected to the correct nodes
  kill $DEV_PID
  ```

- [ ] **Commit.**
  ```bash
  git add src/components/Visualization.tsx
  git commit -m "fix: don't clobber author links on tab resume — tick handler rebuilds coords"
  ```

---

## Task 7 — Full verification and PR

**Files:** none (CI + PR only)

- [ ] **Run the full test suite.**
  ```bash
  npm run test
  ```
  Expected: green, just the one regression test.

- [ ] **Typecheck clean.**
  ```bash
  npx tsc -b
  ```

- [ ] **Lint — expect the pre-existing warnings only.**
  ```bash
  npm run lint 2>&1 | tail -20
  ```
  Expected: no new errors or warnings originating from `Visualization.tsx`. The `react-hooks/exhaustive-deps` disable comment from Task 5 is intentional.

- [ ] **Final manual smoke test.**
  Reproduce the PR #25 scenario at max speed on `jaidhyani/vibource`:
  ```bash
  npm run dev -- --port 5181 &
  DEV_PID=$!
  sleep 3
  # Open http://localhost:5181/?repo=jaidhyani/vibource&commits=50&at=0
  # Drag speed slider to max (20 commits/sec)
  # Observe: tree lines remain visible throughout playback, no flicker on tab switch
  kill $DEV_PID
  ```

- [ ] **Tear down dev server (worktree rule).**
  ```bash
  pkill -f 'vite.*5181' || true
  ```

- [ ] **Push branch and open PR.**
  ```bash
  git push -u origin worktree-devil-shortlist
  gh pr create --title "fix: narrow tree-link types + three surgical Visualization fixes" --body "$(cat <<'EOF'
  ## Summary

  Follow-ups to PR #25 from the devil's-advocate critique of \`docs/visualization_refactor_plan.md\`. Lands the low-risk wins; does not touch the proposed \`GraphRenderer\` refactor.

  - **Type split**: \`SimLink\` → \`TreeLink\` (ref-only \`source\`/\`target\`) + \`AuthorLink\` (string-or-ref, DOM-only). The PR #25 invariant is now compile-enforced: it is a type error to feed strings into a tree link's DOM binding.
  - **Regression test**: \`tree-link-invariant.test.tsx\` mounts \`Visualization\` in jsdom, drives a non-structural commit, asserts all \`g.links line\` have finite numeric coordinates. Verified to fail against \`d3091d7^\` (the pre-PR-#25 commit) and pass against \`main\`.
  - **Throttle fix**: \`renderGraph\` forced renders no longer consume the 30fps throttle budget, so the next real simulation tick inside the window isn't dropped.
  - **Init-effect dep fix**: removing \`[dimensions]\` from the init effect's deps. The first post-mount resize was tearing down the simulation without re-creating it; the separate "Recenter view" effect already handles dimension changes.
  - **Visibility handler**: stop clobbering author links on tab resume. The tick handler rewrites their coordinates every frame, so removing them causes a visible flicker with no benefit.

  ## Test plan

  - [x] \`npm run test\` — regression test green.
  - [x] \`npm run test\` against pre-fix \`src/components/Visualization.tsx\` (\`d3091d7^\`) — regression test red.
  - [x] \`npx tsc -b\` clean.
  - [x] \`npm run lint\` — no new errors/warnings from \`Visualization.tsx\`.
  - [x] Manual smoke on \`jaidhyani/vibource\` at max speed — tree lines remain visible, no flicker on tab switch.
  - [x] Manual smoke: window resize during playback — simulation keeps ticking.

  ## Out of scope

  - \`GraphRenderer\` extraction from \`docs/visualization_refactor_plan.md\` — deferred pending the oscillation investigation.
  - The \`O(n·m)\` filter claim in the \`modifiedFiles\` effect — unmeasured, deferred.
  - Any revisit of the "skip simulation update on non-structural commits" optimization from PRs #22/#23 — that's a separate time-boxed investigation.

  ---
  *Posted by Claude Code (claude-opus-4-6[1m])*
  EOF
  )"
  ```

- [ ] **Capture the PR URL** for the investigation write-up in Task 8.

---

## Task 8 — Time-boxed investigation of PRs #22/#23

**This task does NOT land in the same PR as Tasks 1–7.** Different branch, different PR (or no PR, depending on outcome).

**Files:** Create: `docs/oscillation_investigation.md`. Possibly modify: `src/components/Visualization.tsx` (on a separate branch).

**Time box:** 90 minutes from the first `read_file` of `d3-force/src/link.js` to the final write-up. If the 90 minutes elapse without a clear outcome, stop, write up what was learned, and punt to the plan author.

### Background

PRs #22/#23 (commit `1d96069`) introduced the optimization "only call `simulation.nodes(...)` and `forceLink.links(...)` on structural changes" to fix a visible oscillation. That optimization is what caused PR #25 — by skipping `forceLink.links()`, string `source`/`target` stopped getting resolved to refs. PR #25 patched the symptom by pre-resolving refs in the link-building code. Task 3 in this plan hardens the patch by making the invariant a type.

But the *root* question is still open: **was the wholesale skip actually necessary, or could the oscillation be fixed more narrowly without making the DOM binding depend on simulation-internal side effects at all?**

### Procedure

- [ ] **Create a scratch worktree** off `main` for this investigation.
  ```bash
  claude --worktree oscillation-investigation
  cd /home/jai/projects/vibource/.claude/worktrees/oscillation-investigation
  ```

- [ ] **Read `d3-force/src/link.js`** in the installed copy at `node_modules/d3-force/src/link.js`. You are looking for what `forceLink.initialize(nodes)` actually does. Specifically:
  - What internal state does it compute (strengths, distances, counts)?
  - Is any of that state positional (would reset node positions or velocities)?
  - Does it mutate the `links` array, or only read it?

  Write findings inline in `docs/oscillation_investigation.md` under `## d3 forceLink internals`.

- [ ] **Read `d3-force/src/center.js`.** Same questions. Does `forceCenter.initialize(nodes)` reset anything positional? The devil suggested "pin forceCenter" without reading the source; verify whether that's even a meaningful idea.

- [ ] **Read `d3-force/src/simulation.js`.** Look at `simulation.nodes(newNodes)` — under what conditions does it call `force.initialize` on each force? Does it matter whether `newNodes` is a new array vs the same reference with mutations?

- [ ] **Reproduce the oscillation from PRs #22/#23** with the optimization removed. Revert commit `1d96069` locally:
  ```bash
  git revert --no-commit 1d96069
  # (if that causes conflicts, manually edit the fileTree effect to always call simulation.nodes() and forceLink.links())
  ```
  Run the app on a repo with many commits (`jaidhyani/vibource` at 100 commits works). Observe: does the graph oscillate visibly?

  **Possible outcomes:**
  1. **No oscillation visible.** The PR #22/#23 optimization may have been solving a problem that other fixes (since then) already neutralized. In that case, the fix is: revert `1d96069` cleanly, re-run the regression test from Task 2 (should still pass), open a new PR "revert: restore unconditional simulation updates — oscillation no longer reproduces."
  2. **Oscillation reproduces.** Now the question is *why*. The most common suspects (document which applies):
     - `forceCenter` with strength > 0 re-initialized on every commit: **test** by setting its strength to 0 or removing it, re-run with the optimization removed, see if oscillation vanishes.
     - `forceLink.initialize` recomputing strengths/distances every tick: **test** by checking whether stable strengths/distances (cached across `links(...)` calls) would be possible with a small d3 patch — or more realistically, by keeping the optimization but narrowing it (e.g. call `forceLink.links(newLinks)` but NOT `.alpha().restart()`, verifying the mutation-side-effect happens without reheating).
     - Something about `simulation.nodes(...)` re-assigning velocities: **test** by capturing velocities before and after `simulation.nodes(newNodes)` with a small instrumented harness.

- [ ] **Document findings in `docs/oscillation_investigation.md`.** Sections:
  1. `## What PRs #22/#23 actually fixed` — citing the observable symptom, not just "oscillation."
  2. `## d3 forceLink internals` — from the source reading.
  3. `## Reproduction results` — what happens when you revert the optimization today.
  4. `## Options` — at least two, with pros/cons: narrow fix, wholesale skip, hybrid.
  5. `## Recommendation` — one of:
     - "Narrow fix exists. Implement it on a new branch. Refactor plan in \`docs/visualization_refactor_plan.md\` is not needed for *this* invariant — can still be done on its own merits but not as a PR #25 followup."
     - "Wholesale skip is correct. Document why in a comment at the skip site. The bigger refactor plan's framing stands, but the specific invariant it targets is already handled by Tasks 1–7."
     - "Couldn't resolve in 90 minutes. Here's what I learned. Recommend one of: (a) longer investigation, (b) commission the big refactor as insurance against the unknown, (c) leave it alone."

- [ ] **If the recommendation is "narrow fix exists," implement it on the investigation branch.**
  Guardrails:
  - Every existing test (`tree-link-invariant`) must still pass.
  - Add a new regression test for the oscillation scenario (whatever form it takes) before the fix.
  - Keep the fix strictly under 50 lines. If it grows bigger, stop and reconsider — that's a signal the "narrow fix" is not actually narrow.
  - Open a separate PR with title `fix: narrow <specific root cause> instead of wholesale skip in fileTree effect`.

- [ ] **If the recommendation is "wholesale skip is right," document it in-place.**
  Add a comment at the `if (hasStructuralChanges) { simulation.nodes(...); forceLink.links(...); }` site explaining:
  ```ts
  // We intentionally skip simulation.nodes()/forceLink.links() on non-structural
  // commits to avoid <specific symptom from investigation>. The invariant that
  // tree-link DOM datums must carry SimNode refs (not string ids) is enforced
  // at construction time in the newLinks flatMap above, so skipping forceLink
  // here no longer strands the DOM binding with unresolved strings.
  // See docs/oscillation_investigation.md for the full reasoning.
  ```
  Commit this documentation-only change as its own PR: `docs: explain why the non-structural commit optimization is wholesale`.

- [ ] **If the recommendation is "escalate,"** just push the investigation doc to a branch and stop. Do not land a fix.

- [ ] **Tear down any dev server, remove the investigation worktree** unless you're leaving work in progress for someone else:
  ```bash
  pkill -f 'vite' || true
  cd /home/jai/projects/vibource
  git worktree remove .claude/worktrees/oscillation-investigation
  ```

---

## Self-review checklist

Before merging the Tasks 1–7 PR:

- [ ] The regression test file is at `src/components/__tests__/tree-link-invariant.test.tsx` and contains a test named exactly `tree links keep finite coordinates after a non-structural commit`.
- [ ] The test has been proven to fail on `d3091d7^` and pass on the final branch (captured in the PR body checklist).
- [ ] `grep -n SimLink src/components/Visualization.tsx` returns zero matches. All references are to `TreeLink` or `AuthorLink`.
- [ ] `grep -n isAuthorLink src/components/Visualization.tsx` returns zero matches.
- [ ] No new files under `src/viz/`. No new directories. The file count delta is exactly +4 (`vitest.config.ts`, `src/test-setup.ts`, `src/components/__tests__/tree-link-invariant.test.tsx`, this plan doc itself if you check it in).
- [ ] The PR #25 defensive fallback in `renderGraph` is still present — the runtime guard comment is added, not the branch deleted.
- [ ] The worktree has no running dev server on any port.
- [ ] The investigation in Task 8 is on a *different* branch. Check `git log worktree-devil-shortlist --oneline` — it should contain only Tasks 0–7, nothing from the investigation.

## What this plan is NOT

- Not a refactor. Not an abstraction boundary change.
- Not a test infrastructure overhaul — vitest is added, but only to run the one regression test. Don't add more tests opportunistically; if other tests are warranted, they're a separate plan.
- Not a decision about whether to eventually do the `GraphRenderer` refactor. That decision is blocked on Task 8's outcome.
