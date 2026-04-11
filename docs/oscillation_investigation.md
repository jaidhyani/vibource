# Oscillation investigation — were PRs #22/#23 necessary?

This doc answers the Task 8 question from `docs/devil_shortlist_plan.md`:
was commit `1d96069` ("only update simulation when graph structure changes")
load-bearing for preventing oscillation, or was it a redundant over-fix that
introduced the PR #25 tree-link invariant bug for no benefit?

**Bottom line first:** `1d96069` is empirically redundant. Commit `2044566`
(the `simulation.alpha(...).restart()` reheat guard) is what actually
prevents the oscillation. Reverting `1d96069` is a valid narrow fix that
eliminates the root cause of PR #25 (string→ref resolution depending on a
`forceLink.links()` call that the optimization skipped).

---

## What PRs #22/#23 actually fixed

Observable symptom: during commit-playback scrubbing, the tree-visualization
graph "oscillated" or "poked" — nodes would visibly shift each time a new
commit was selected, then snap back. On a multi-commit drag this produced a
jittering layout.

The PR #23 branch landed **three** separate fixes claiming to address this:

| commit    | effect                                                                                    |
| --------- | ----------------------------------------------------------------------------------------- |
| `0342d9c` | Guards the modifiedFiles / authors effect: skips `sim.nodes()` + `sim.alpha().restart()` unless the author set changed. |
| `2044566` | Guards the fileTree effect's reheat: skips `sim.alpha(targetAlpha).restart()` unless nodes were added or removed. |
| `1d96069` | Guards the fileTree effect's simulation data update: skips `sim.nodes(newNodes)` and `forceLink.links(newLinks)` unless nodes were added or removed. |

Only the first commit (`0342d9c`) matches the PR title and description. The
other two commits were follow-ons added iteratively, with commit messages
proposing hypotheses ("forceCenter being reinitialized on every commit was
causing directional shift even without explicit reheat") that were never
empirically validated.

The PR #25 bug was a direct consequence of `1d96069`: by skipping
`forceLink.links(newLinks)` on non-structural commits, the DOM-bound link
datums were left as `{ source: string, target: string }` objects. d3 relies
on the side-effect of `forceLink.links()` to mutate those string ids into
`SimNode` refs in place. With the call skipped, renderGraph reached for
`d.source.x` on a string and wrote `x1="undefined"` — the tree links
silently disappeared during playback.

## d3 forceLink internals

Read from `node_modules/d3-force/src/link.js` (d3-force 7.x).

`forceLink.initialize(nodes)` and `force.links(newLinks)` both eventually
call a shared `initialize()` closure:

```js
function initialize() {
  if (!nodes) return;
  var nodeById = new Map(nodes.map((d, i) => [id(d, i, nodes), d]));
  for (i = 0; i < m; ++i) {
    link = links[i], link.index = i;
    if (typeof link.source !== "object") link.source = find(nodeById, link.source);
    if (typeof link.target !== "object") link.target = find(nodeById, link.target);
    count[link.source.index] = (count[link.source.index] || 0) + 1;
    count[link.target.index] = (count[link.target.index] || 0) + 1;
  }
  // ...bias[], strengths[], distances[] computed from count + callbacks
}
```

Things `initialize()` mutates:
- Each link's `source` / `target` (string → SimNode, *in place*).
- Each link's `.index`.
- Internal closure arrays `count`, `bias`, `strengths`, `distances`.

Things `initialize()` does **not** touch:
- `node.x`, `node.y`, `node.vx`, `node.vy`.
- The `nodes` array passed in.

So `forceLink.initialize` is non-positional. Calling it repeatedly with the
same node instances is a no-op with respect to layout — it only recomputes
caches that would produce identical values anyway.

## d3 forceCenter internals

`node_modules/d3-force/src/center.js`:

```js
force.initialize = function(_) { nodes = _; };
```

That is the entire initializer. It captures the array reference. It has zero
side effects.

The `force()` function (run from `tick()`, not `initialize()`) computes the
centroid and shifts all nodes so the centroid lands at `(x, y)`:

```js
for (sx = (sx / n - x) * strength, sy = (sy / n - y) * strength, i = 0; i < n; ++i) {
  node = nodes[i], node.x -= sx, node.y -= sy;
}
```

The shift magnitude is `strength * (currentCentroid - targetCenter)`. In the
app, `forceCenter(0, 0).strength(0.02)`. This effect is **tick-driven and
alpha-gated**: `force(alpha)` isn't reached in `forceCenter` specifically,
but the general pattern is that force contributions scale with `alpha`. So
when alpha has decayed to `alphaMin (0.001)`, the positional correction per
tick is effectively invisible.

The hypothesis in `1d96069`'s commit message — "forceCenter being
reinitialized on every commit was causing the directional shift even without
explicit reheat" — is not supported by the source. `forceCenter.initialize`
literally only reassigns a reference; it cannot cause any directional shift.

## d3 simulation.nodes() internals

`node_modules/d3-force/src/simulation.js`:

```js
nodes: function(_) {
  return arguments.length
    ? (nodes = _, initializeNodes(), forces.forEach(initializeForce), simulation)
    : nodes;
},
```

`initializeNodes()` mutates each node:
- `node.index = i`
- If `node.fx != null`: `node.x = node.fx`
- If `isNaN(node.x) || isNaN(node.y)`: reset to a radial seed position
- If `isNaN(node.vx) || isNaN(node.vy)`: set to 0

For **existing nodes with valid `x`/`y`/`vx`/`vy`** (which is what the
fileTree effect passes in — it reuses instances from `existingNodes`), every
branch except `node.index = i` is skipped. So `simulation.nodes(sameArray)`
is positionally a no-op.

`forces.forEach(initializeForce)` then calls `force.initialize(nodes, random)`
on every force. `forceCenter`, `forceLink`, `forceManyBody`, `forceCollide`,
`forceRadial`, and the custom `authorPosition` force all have initializers
that recompute caches or reassign references. None of them mutates node
positions or velocities.

**Conclusion:** `simulation.nodes(newNodes)` on a non-structural commit is
non-positional. The theoretical basis for `1d96069` does not hold.

## Reproduction results

Rather than run the app against a 100-commit repo and try to eyeball
oscillation, I wrote a headless probe — `scripts/oscillation-probe.mjs` —
that replicates the vibource force configuration and measures the maximum
per-commit positional drift across 200 non-structural commits.

The probe:

1. Builds a 56-node, 55-link tree with the same force graph as
   `Visualization.tsx` (link, charge, center, collision, radial).
2. Warms the simulation up to full settle (alpha decayed to `alphaMin`).
3. Runs 200 iterations of: `sim.nodes(sameArray)` + `sim.force('link').links(freshStrings)` + 10 ticks.
4. Tracks the maximum per-commit displacement and cumulative drift.
5. Runs a control that skips the `nodes()` / `links()` calls entirely.
6. Runs a "warm tail" pair (alpha pinned to 0.3) for the same comparison
   during the reheat period after a structural change.

Output:

```text
Post-settle — worst per-commit delta: 0.1173 px
Post-settle — worst cumulative drift: 0.7397 px
Control (no nodes()/links() calls) — worst cumulative drift: 0.7397 px
Warm-tail run — worst per-commit delta: 9.2150 px
Warm-tail CONTROL — worst per-commit delta: 9.2150 px
```

Both the settled and the warm-tail runs produce **byte-identical** drift
whether or not `sim.nodes()` / `forceLink.links()` are called on every
non-structural commit. The sub-pixel drift that does occur is pure tick
dynamics — it's what happens whether you call `sim.nodes()` or not.

This is strong empirical evidence that `1d96069` was not load-bearing. The
oscillation that PR #23 was trying to fix was caused by the alpha reheat
(`simulation.alpha(targetAlpha).restart()`), and commit `2044566` alone is
sufficient to eliminate it.

### Caveat

The probe is headless and does not include the `authorPosition` custom force
or the React lifecycle; it also assumes the fileTree effect is the only
caller mutating `sim.nodes(...)`. I did not manually scrub through a
100-commit repo in the running app. A visual confirmation step is cheap and
worth doing before landing the revert as a follow-up PR, but the probe
covers the specific claim in `1d96069`'s commit message (initialize
side-effects cause position drift), and that claim is false.

## Options

### A) Revert `1d96069` (narrow fix)

Drop the `hasStructuralChanges` guard around `simulation.nodes(newNodes)`
and `forceLink.links(newLinks)`. Keep the reheat guard from `2044566`.

- ✅ Eliminates the PR #25 bug at its source. `forceLink.links()` is always
  called, so string→ref mutation always happens.
- ✅ Deletes the defensive fallback from `d3091d7` (optional — the fallback
  is also harmless to keep).
- ✅ Matches what the d3-force source actually does. No hidden assumptions.
- ⚠️  Adds a few microseconds of recomputing link `count`/`bias`/`strengths`
  on every non-structural commit. Irrelevant at 50 links; would matter at
  10⁴+ links — not a scale this project targets.
- ⚠️  Visual confirmation against a real repo is still owed (the probe is
  headless).

### B) Keep the wholesale skip, document it

Leave `1d96069` in place. The PR #25 defensive fixes (`d3091d7`, and the
Task 3 type split in the devil-shortlist plan) make the skip safe.

- ✅ Zero code churn. Same behavior we have today.
- ❌ Keeps code whose justification ("forceCenter reinitialization") is not
  actually true. That's an invitation for the next person touching this
  file to break things when they move the skip around without understanding
  why it's there.
- ❌ Leaves the DOM binding silently dependent on a d3-force internal
  side-effect that the code does not call unconditionally — exactly the
  kind of load-bearing invariant that the devil shortlist plan's Task 3
  exists to eradicate.

### C) Hybrid: narrow the skip to just `simulation.nodes()`, always call `forceLink.links()`

A strictly narrower version of the optimization: skip the `sim.nodes()`
call (which triggers `initializeForce` on all 6 forces) but keep the
`forceLink.links()` call (cheap, and preserves the string-resolution
invariant).

- ✅ Preserves any imagined benefit from skipping the 5-force re-init.
- ✅ Fixes the PR #25 root cause.
- ❌ Adds another magic invariant ("`sim.nodes()` skipped on purpose, but
  `forceLink.links()` still called") that a future editor has to understand.
- ❌ The probe shows `sim.nodes()` is a no-op in the settled case anyway, so
  the "benefit" is purely theoretical.

## Recommendation

**Option A: narrow fix exists. Revert `1d96069` on a separate branch and
open a follow-up PR.**

The devil shortlist plan's Tasks 1–7 (invariant test + `TreeLink`/`AuthorLink`
type split + three one-line fixes) should still ship on their own merits —
they encode the invariant as a type, not as a runtime guarantee, and that's
valuable regardless of how we resolve this. But the specific invariant they
target (link datum source/target must be a SimNode ref) is already
structurally handled by reverting `1d96069`, because `forceLink.links(newLinks)`
runs on every commit and mutates strings to refs in place.

After landing both:
- The tree-link-invariant regression test from Task 2 will pass (because
  forceLink.links() resolves strings on every call).
- The type split from Task 3 will still catch any *new* code path that
  forgets to pre-resolve — defense in depth.
- The PR #25 defensive fallback in `renderGraph` can be removed (optional),
  or kept as a belt-and-braces guard.

### Owed follow-up

Before merging the revert:

- [ ] Spin up the dev server, load a real 100+ commit repo, scrub through
  playback at 20x speed. Confirm no visible oscillation and no disappearing
  tree links. (Probe is headless; this is the empirical cross-check.)
- [ ] Run the `tree-link-invariant` test from `devil-shortlist` against the
  reverted code to confirm it still passes.
- [ ] Delete or rewrite the misleading commit message on `1d96069` in the
  revert's commit body so the history explains *why* we're undoing it.

## References

- Commits: `0342d9c`, `2044566`, `1d96069` (on branch `main` after PR #23).
- Regression bug: commit `d3091d7` on branch `devil-shortlist` (PR #25).
- d3-force source: `node_modules/d3-force/src/{link,center,simulation,radial,manyBody,collide}.js`.
- Probe: `scripts/oscillation-probe.mjs` in this branch.
