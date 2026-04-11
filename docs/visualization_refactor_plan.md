# Visualization refactor plan

## Problem statement

`src/components/Visualization.tsx` (830 lines) is a React component wrapping a d3
force simulation. It combines React-owned props/state with ~10 long-lived mutable
refs and 9 `useEffect`s that read and write those refs in an implicit order. This
has produced a series of bugs where a cross-cutting invariant held only as a side
effect of some d3 call, and broke when the call was moved or skipped:

- **PRs #22/#23 (graph oscillation)**: reheating the simulation every commit
  caused forceCenter to re-initialize, which caused a visible directional shift.
  Fix: only call `simulation.nodes()` / `.alpha().restart()` on structural changes.
- **PR #25 (missing tree links at high speed, the bug we just fixed)**: the
  previous fix accidentally left the DOM link datums bound to objects with
  *string* `source`/`target` IDs on non-structural commits, because those strings
  were previously turned into `SimNode` refs as a *side effect* of
  `d3.forceLink.links()`. `renderGraph` then wrote `x1="undefined"` and the whole
  tree went invisible until the next structural change.

Both bugs share a root cause: the d3 state (`simulation`, `forceLink`, DOM
selections) and the derived React state (`fileTree`, `modifiedFiles`,
`currentCommit`) are stitched together by refs and effects, and the contract
between them lives in programmer memory instead of one place. There are more
footguns of the same shape waiting.

## Specific things that are brittle today

All line numbers are against `src/components/Visualization.tsx` on the
`worktree-missing_animations` branch at commit `d3091d7`.

1. **Init effect has `[dimensions]` in its dep array** (line 315) **with an
   `initializedRef.current` early return** (line 246). On the first container
   resize, React runs the cleanup (`simulation.stop()`, line 313) but the re-run
   early-exits — so the simulation is permanently stopped until some other
   effect happens to call `.alpha().restart()`. Currently masked by the fact that
   the `fileTree` effect does reheat on structural changes, but it's luck, not
   design.

2. **Throttle in `renderGraph`** (lines 81–87): `forceRender=true` still
   writes `lastTickRef.current = now`, so the next *genuine* simulation tick
   inside the 33 ms window gets dropped. It's a subtle coupling: every call site
   for `renderGraph(true)` costs you one dropped frame of motion.

3. **`authorLinkGroup.selectAll('*').remove()` every commit** (line 632) +
   `stroke-opacity` 0→0.35 transition over 200 ms (line 852): at 5+ commits/sec,
   the fade-in is wiped before it becomes visible. The whole author-link path
   fights itself at speed.

4. **`nodeGroup.selectAll().filter(d => d.id === file.id)`** inside
   `modifiedFiles.forEach` (lines 653–655). That's `O(n·m)` per commit, scanning
   every DOM node for every modified file. On a repo the size of React (~5k
   nodes) × 20 commits/sec × ~10 modified files per commit, we're doing ~1M
   filter iterations per second on the hot path. Observed as playback falling
   behind the rAF clock on medium repos.

5. **Shared ref zoo**: `simulationRef`, `nodesRef`, `authorNodesRef`, `gRef`,
   `zoomRef`, `initializedRef`, `cachedPositionsRef`, `positionsLoadedRef`,
   `nodeSelectionRef`, `linkSelectionRef`, `authorSelectionRef`,
   `authorLinkSelectionRef`, `lastTickRef` (lines 61–78). Every effect reads or
   writes several of them. The ordering constraints between effects are
   implicit — the `modifiedFiles` effect depends on the `fileTree` effect having
   already populated `nodesRef`, which depends on `gRef` being set by the init
   effect, and so on. Breaking any link silently produces stale or missing
   visuals.

6. **The "link datum shape" invariant was never written down** — it lived in
   the knowledge that d3's `forceLink.links()` happens to mutate its argument
   in place. PR #25 adds a defensive fallback in `renderGraph`, but the real
   fix would be to stop threading this invariant through the d3 API at all.

7. **Visibility change handler blindly blows away author links** (line 148)
   because "they may be in weird states". That's a symptom of not having a
   clear way to rebuild the world from derived state.

## Goal

Turn the d3 side of `Visualization.tsx` into a small, testable, imperative
object — let's call it `GraphRenderer` — that owns the simulation, the DOM
selections, and the node/link maps, and exposes one method:

```ts
renderer.update({
  fileTree,
  modifiedFiles,
  currentCommit,
  currentCommitIndex,
  authors,
  dimensions,
  selectedFile,
  hoveredNodePath,
});
```

React's job shrinks to:
- `useEffect(() => { rendererRef.current = new GraphRenderer(svgEl); return () => rendererRef.current.destroy(); }, [])` — once on mount.
- `useEffect(() => { rendererRef.current?.update({...all props}); }, [fileTree, modifiedFiles, currentCommit, ...])` — one effect, one call, one place where the contract lives.
- Minor shell: the tooltip state (still React), the `<svg>` element, the repo-position-caching effect (can stay, it's genuinely async side-effect).

The point isn't to remove d3 or React. It's to collapse the 9-useEffect weave
into "React renders the shell, `GraphRenderer.update()` owns everything inside
the `<svg>`."

## Proposed new module layout

```
src/components/Visualization.tsx          (~150 lines — React shell only)
src/viz/GraphRenderer.ts                   (~400 lines — imperative d3)
src/viz/forces.ts                          (~60 lines  — force configuration)
src/viz/animations.ts                      (~80 lines  — pulse + author link fade)
src/viz/types.ts                           (SimNode, SimLink, RendererUpdate)
src/viz/__tests__/GraphRenderer.test.ts    (real DOM via jsdom)
```

## GraphRenderer.update() — precise semantics

`update(props)` is the only entry point after construction. It does, in order:

1. **Reconcile node set.** Walk `props.fileTree`, diff against `this.nodes` map
   (id → SimNode). Compute `added`, `removed`, `kept` sets. Keep existing node
   objects by identity for `kept` so the simulation's internal references stay
   valid. Seed positions for `added` from cache → parent → depth-radial, same
   as today.
2. **Reconcile author set.** Same pattern. Compute `avgX/avgY` from
   `props.modifiedFiles`' current positions. Remove authors whose
   `lastActiveIndex` is past the inactivity threshold.
3. **Reconcile links.** Build `links` from the tree, *using SimNode references
   from `this.nodes` directly*. No string IDs anywhere downstream. This is the
   invariant that PR #25 enforces in two places; in the new structure it's
   enforced once, in the one place that constructs links.
4. **If nodes or links changed set, update the simulation.** Call
   `simulation.nodes(...)` and `forceLink.links(...)`. If only attributes (e.g.
   author target position) changed, skip this step. This is the same
   optimization as today, but the "only update on structural change" policy now
   applies to *simulation data*, not to the DOM binding.
5. **Data-bind DOM once, using the same arrays.** `enter/update/exit` for
   nodes, tree links, authors, author links. The bound datum is always a
   `SimNode` or a `{source: SimNode, target: SimNode}`, never a string.
6. **Fire the animation queue.** Per modified file: look up the DOM circle in a
   precomputed `Map<id, SVGCircleElement>` (built in step 5 during enter, not
   via `selectAll().filter()`), then run the pulse. This gets `O(m)` instead of
   `O(n·m)`.
7. **Render once explicitly** (what `renderGraph(true)` does today), then
   decide whether to reheat the simulation based on whether nodes/links changed
   set, same policy as today.
8. **Tick handler** stays tiny: it only reads `this.nodes` / `this.links` and
   writes transforms. No `any` casts, no string/ref duality.

## Smaller cleanups folded into the refactor

- **Throttle fix**: `renderGraph`'s `lastTickRef` update should only happen on
  *non-forced* renders. Or, simpler: drop the throttle and let the rAF loop do
  its job. 60 Hz render with 30 nodes is not a perf problem. For large repos,
  throttle inside the tick handler, not across explicit calls.
- **Init dependency fix**: init effect gets `[]` deps. Dimensions are applied
  via a separate effect that calls `renderer.resize(width, height)` — that one
  already exists in spirit (line 318), it just needs to stop tearing the
  simulation down.
- **Visibility change handler**: becomes `renderer.onVisible()` which reheats
  and does a render pass. No more `selectAll('*').remove()` of author links —
  they're derived from `modifiedFiles` / `currentCommit` anyway and will be
  correct after the next `update()` call.
- **Author link fade**: make it `fill-opacity` over 600 ms instead of 200 ms so
  it survives at least 2-3 commits at max speed. Or: make author links
  persistent between consecutive commits by the same author, animating only on
  author change. This is a tiny UX decision but shows up naturally once the
  data flow is clean.

## Tests

- `GraphRenderer.test.ts` uses jsdom + a stubbed `d3.forceSimulation` (or real
  one; it works in jsdom). Cases:
  - Initial load with 50 nodes → DOM has 50 nodes and `links-1` lines, all with
    finite `x1/y1`.
  - Non-structural commit → lines remain finite after update (this is exactly
    the bug PR #25 fixes).
  - Structural commit that adds 10 files → DOM grows by 10, all new nodes have
    x/y set.
  - Removed file → DOM shrinks, no stale references to the node remain in the
    simulation or the link array.
  - Rapid updates (20 `update()` calls in a tight loop) → no exceptions, all
    final state consistent with the final props.
- Puppeteer/Playwright smoke: exactly the before/after check we ran manually
  today, codified. Sample `document.querySelectorAll('g.links line')` attrs
  during max-speed playback, assert 0 invalid.

## Migration strategy

Not a one-shot rewrite. Three commits, each independently mergeable:

1. **Extract `GraphRenderer` skeleton** in `src/viz/GraphRenderer.ts`. Move the
   init effect's contents into the constructor. `Visualization.tsx` still
   contains all the other effects, but now grabs selections via
   `rendererRef.current.selections`. This is a ~0-risk mechanical refactor.
2. **Move `fileTree` + `modifiedFiles` effects into `renderer.update()`**.
   `Visualization.tsx` now has one data effect instead of two. The invariant
   enforcement from PR #25 collapses into the single link-building site.
3. **Move author/selection/hover effects into `renderer.update()`** and drop
   the remaining refs. `Visualization.tsx` is now ~150 lines.

Each commit is independently testable; we can ship #1 and #2 and sit on #3 if
the refactor runs out of time. The bug fix from PR #25 stays in place and is
preserved by commit #1 verbatim.

## What I am explicitly NOT proposing

- **Replacing d3 with something else.** d3 is fine. The problem is the
  *boundary* between d3 and React, not d3 itself.
- **Making the renderer "pure" or moving it into React's render phase.** The
  simulation is inherently stateful and imperative. Pretending otherwise via
  `react-force-graph` or similar would cost us the per-frame control we rely on
  for the custom forces.
- **Adding a state management library.** The refs are the problem, not the
  solution to the problem, and Redux/Zustand wouldn't change the underlying
  coupling.
- **Rewriting the tree/commit data pipeline** in `src/utils/fileTree.ts` or
  `src/App.tsx`. Those are fine. The refactor is localized to the visualization
  layer.

## Risks and things I'm unsure about

- **d3 custom `authorPositionForce`** (line 275) captures a closed-over `nodes`
  array via `force.initialize`. Moving this into `GraphRenderer` needs to make
  sure `initialize` is called whenever the node set changes, not just once. I
  think `simulation.nodes(...)` does call `.initialize` on all forces, but I
  need to verify before landing commit #2.
- **Position caching** (`saveNodePositions` / `getNodePositions`) in
  `src/services/cache.ts` currently runs in its own effect (lines 199–227). I
  want to leave that alone in commit #1, move it into `GraphRenderer.onSettled`
  hook in commit #3. Risk: if the settle callback fires more or less often than
  the current `simulation.on('end')`, we could save positions at wrong times.
  Mitigation: same debouncer, wrapped inside `GraphRenderer`.
- **Hover and selection effects** (lines 590–615) currently interrupt
  in-flight pulse transitions on circles via `circle.transition()`. Moving
  these into `update()` preserves the interaction but we should be deliberate
  about transition naming so the pulse and the hover don't fight. d3 supports
  named transitions; today's code doesn't use that, which is part of the
  problem.
- **Worktree runtime rule**: per `~/projects/CLAUDE.md`, each worktree must
  shut its services down when the task ends. This refactor will need the dev
  server running for manual testing; I'll tear it down at the end of each
  commit.

## Definition of done

- `Visualization.tsx` is ≤200 lines and contains zero `d3.select` calls except
  to pass the root `<svg>` to the renderer.
- No ref in `Visualization.tsx` other than `svgRef` and `rendererRef`.
- All invariants around link datum shape are enforced in one function.
- A jsdom test covers the "non-structural commit keeps links valid" case so
  the PR #25 bug cannot regress.
- Max-speed playback on React-size repo has no visible link drops and no
  frame drops below ~45 fps on my laptop.
- Existing PR #25 behavior is preserved exactly; no visible diff to the user
  at normal or max speed other than (optionally) the author-link fade tuning.
