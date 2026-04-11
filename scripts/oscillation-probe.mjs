// Empirical probe: does repeatedly calling simulation.nodes() + forceLink.links()
// on non-structural commits (same node instances, fresh link array) cause visible
// position drift when alpha has already decayed to alphaMin?
//
// This is the claim in commit 1d96069 — "directional shift even without explicit
// reheat." We replicate the force config from src/components/Visualization.tsx
// and measure max node displacement across 200 non-structural "commits".
import * as d3 from 'd3';

function buildTree(nFiles = 50) {
  const nodes = [];
  nodes.push({ id: 'root', type: 'directory', depth: 0 });
  const dirs = ['src', 'src/components', 'src/utils', 'tests', 'docs'];
  dirs.forEach((d, i) => nodes.push({ id: d, type: 'directory', depth: d.split('/').length }));
  for (let i = 0; i < nFiles; i++) {
    const parent = dirs[i % dirs.length];
    nodes.push({ id: `${parent}/f${i}.ts`, type: 'file', depth: parent.split('/').length + 1, color: '#8da0cb' });
  }
  // Links: each non-root node links to its parent dir (or 'root' for top dirs).
  const links = [];
  for (const n of nodes) {
    if (n.id === 'root') continue;
    const lastSlash = n.id.lastIndexOf('/');
    const parent = lastSlash === -1 ? 'root' : n.id.slice(0, lastSlash);
    links.push({ source: parent, target: n.id });
  }
  return { nodes, links };
}

function buildLinksFreshStrings(links) {
  // Fresh objects with string source/target — matches the fileTree effect's newLinks build.
  return links.map((l) => ({ source: l.source, target: l.target }));
}

function makeSimulation() {
  return d3
    .forceSimulation([])
    .force('link', d3.forceLink([]).id((d) => d.id).distance(30).strength(0.4))
    .force('charge', d3.forceManyBody().strength((d) => (d.type === 'directory' ? -80 : -15)).distanceMax(200))
    .force('center', d3.forceCenter(0, 0).strength(0.02))
    .force('collision', d3.forceCollide().radius((d) => (d.type === 'directory' ? 14 : 6)).iterations(2).strength(0.7))
    .force(
      'radial',
      d3
        .forceRadial((d) => d.depth * 60, 0, 0)
        .strength(0.1)
    )
    .velocityDecay(0.35)
    .alphaDecay(0.02)
    .alphaMin(0.001);
}

function tickN(sim, n) {
  for (let i = 0; i < n; i++) sim.tick();
}

function measurePositions(nodes) {
  return nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }));
}

function maxDelta(before, after) {
  let max = 0;
  for (let i = 0; i < before.length; i++) {
    const dx = after[i].x - before[i].x;
    const dy = after[i].y - before[i].y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > max) max = d;
  }
  return max;
}

const { nodes, links } = buildTree(50);
const sim = makeSimulation();
sim.nodes(nodes);
sim.force('link').links(buildLinksFreshStrings(links));

// Warm up: let it fully settle.
sim.alpha(1).restart();
// Manually tick until alpha reaches min — d3 uses a timer, so we tick synchronously.
sim.stop();
for (let i = 0; i < 2000 && sim.alpha() > sim.alphaMin(); i++) sim.tick();
console.log(`After warmup: alpha=${sim.alpha().toFixed(5)} ticks done`);

const baseline = measurePositions(nodes);
let worstSingleCommitDelta = 0;
let worstTotalDrift = 0;

// Now simulate 200 non-structural commits: each reuses the same node instances
// with a fresh link array (as Visualization.tsx does), ticks a few frames to
// simulate passage of time, and measures drift.
for (let commit = 0; commit < 200; commit++) {
  const snapshotBefore = measurePositions(nodes);
  sim.nodes(nodes); // replaces nodes array; triggers initializeForce on all
  sim.force('link').links(buildLinksFreshStrings(links));
  // NO sim.alpha().restart() — mimicking commit 2044566's reheat guard.
  tickN(sim, 10); // ~10 frames of passage
  const snapshotAfter = measurePositions(nodes);
  const singleDelta = maxDelta(snapshotBefore, snapshotAfter);
  if (singleDelta > worstSingleCommitDelta) worstSingleCommitDelta = singleDelta;
  const totalDrift = maxDelta(baseline, snapshotAfter);
  if (totalDrift > worstTotalDrift) worstTotalDrift = totalDrift;
}

console.log(`Final alpha: ${sim.alpha().toFixed(6)}`);
console.log(`Post-settle — worst per-commit delta: ${worstSingleCommitDelta.toFixed(4)} px`);
console.log(`Post-settle — worst cumulative drift: ${worstTotalDrift.toFixed(4)} px`);

// Now compare: control run, WITHOUT calling sim.nodes()/forceLink.links() between commits.
// Do positions drift by the same amount purely from tick dynamics?
const { nodes: n2, links: l2 } = buildTree(50);
const sim2 = makeSimulation();
sim2.nodes(n2);
sim2.force('link').links(buildLinksFreshStrings(l2));
sim2.alpha(1).restart();
sim2.stop();
for (let i = 0; i < 2000 && sim2.alpha() > sim2.alphaMin(); i++) sim2.tick();
const baseline2 = measurePositions(n2);
let worstCtl = 0;
for (let commit = 0; commit < 200; commit++) {
  // NO sim.nodes() / forceLink.links() calls — just tick.
  tickN(sim2, 10);
  const d = maxDelta(baseline2, measurePositions(n2));
  if (d > worstCtl) worstCtl = d;
}
console.log(`Control (no nodes()/links() calls) — worst cumulative drift: ${worstCtl.toFixed(4)} px`);

// Third run: non-structural commits at elevated alpha (simulating a user who
// just structurally added a node and is now scrubbing during the warm tail).
const { nodes: n3, links: l3 } = buildTree(50);
const sim3 = makeSimulation();
sim3.nodes(n3);
sim3.force('link').links(buildLinksFreshStrings(l3));
sim3.alpha(1).restart();
sim3.stop();
for (let i = 0; i < 2000 && sim3.alpha() > sim3.alphaMin(); i++) sim3.tick();
// Reheat halfway (simulating a structural commit), then start measuring:
sim3.alpha(0.3);
const baseline3 = measurePositions(n3);
let worstWarm = 0;
for (let commit = 0; commit < 100; commit++) {
  const before = measurePositions(n3);
  sim3.nodes(n3);
  sim3.force('link').links(buildLinksFreshStrings(l3));
  tickN(sim3, 10);
  const d = maxDelta(before, measurePositions(n3));
  if (d > worstWarm) worstWarm = d;
}
console.log(`Warm-tail run — worst per-commit delta: ${worstWarm.toFixed(4)} px (final alpha ${sim3.alpha().toFixed(5)})`);

// Warm-tail CONTROL: alpha=0.3, tick same amount, but no sim.nodes()/links() calls.
const { nodes: n4, links: l4 } = buildTree(50);
const sim4 = makeSimulation();
sim4.nodes(n4);
sim4.force('link').links(buildLinksFreshStrings(l4));
sim4.alpha(1).restart();
sim4.stop();
for (let i = 0; i < 2000 && sim4.alpha() > sim4.alphaMin(); i++) sim4.tick();
sim4.alpha(0.3);
let worstWarmCtl = 0;
for (let commit = 0; commit < 100; commit++) {
  const before = measurePositions(n4);
  tickN(sim4, 10);
  const d = maxDelta(before, measurePositions(n4));
  if (d > worstWarmCtl) worstWarmCtl = d;
}
console.log(`Warm-tail CONTROL — worst per-commit delta: ${worstWarmCtl.toFixed(4)} px (final alpha ${sim4.alpha().toFixed(5)})`);

console.log(
  worstSingleCommitDelta < 0.5 && worstTotalDrift < 2
    ? '\nVERDICT: no visible oscillation — 1d96069 appears REDUNDANT (commit 2044566 alone suffices)'
    : '\nVERDICT: drift observed — 1d96069 may be LOAD-BEARING'
);
