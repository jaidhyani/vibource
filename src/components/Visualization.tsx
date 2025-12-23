import { useEffect, useRef, useState, useCallback } from 'react';
import * as d3 from 'd3';
import type { FileNode, Author, Commit } from '../types';
import { flattenTree, getTreeLinks } from '../utils/fileTree';

interface VisualizationProps {
  fileTree: FileNode;
  authors: Map<string, Author>;
  currentCommit: Commit | null;
  modifiedFiles: FileNode[];
  onFileSelect?: (path: string) => void;
  selectedFile?: string | null;
}

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'directory';
  color?: string;
  depth: number;
  parentId?: string;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  source: SimNode | string;
  target: SimNode | string;
}

export default function Visualization({
  fileTree,
  authors,
  currentCommit,
  modifiedFiles,
  onFileSelect,
  selectedFile,
}: VisualizationProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

  // Persistent refs for D3 elements
  const simulationRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<Map<string, SimNode>>(new Map());
  const gRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const initializedRef = useRef(false);

  // Cached selections for performance
  const nodeSelectionRef = useRef<d3.Selection<SVGGElement, SimNode, SVGGElement, unknown> | null>(null);
  const linkSelectionRef = useRef<d3.Selection<SVGLineElement, SimLink, SVGGElement, unknown> | null>(null);

  // Throttle tick handler to ~30fps for performance
  const lastTickRef = useRef(0);
  const TICK_INTERVAL = 1000 / 30; // 30fps

  // Render function - updates DOM (throttled when called from simulation tick)
  const renderGraph = useCallback((forceRender = false) => {
    const now = performance.now();
    if (!forceRender && now - lastTickRef.current < TICK_INTERVAL) {
      return; // Skip this frame
    }
    lastTickRef.current = now;

    const nodeSelection = nodeSelectionRef.current;
    const linkSelection = linkSelectionRef.current;

    if (linkSelection) {
      linkSelection
        .attr('x1', d => (d.source as SimNode).x!)
        .attr('y1', d => (d.source as SimNode).y!)
        .attr('x2', d => (d.target as SimNode).x!)
        .attr('y2', d => (d.target as SimNode).y!);
    }

    if (nodeSelection) {
      nodeSelection.attr('transform', d => `translate(${d.x},${d.y})`);
    }
  }, []);

  // Handle visibility change - clean up when tab hidden, restore when visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Tab hidden - stop simulation
        simulationRef.current?.stop();
      } else {
        // Tab visible - clean up stale elements and restart simulation
        if (gRef.current) {
          // Remove all author badges (they may be in weird states)
          gRef.current.select('g.authors').selectAll('*').remove();
          // Restart simulation to let it settle
          if (simulationRef.current) {
            simulationRef.current.alpha(0.1).restart();
          }
          renderGraph(true);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [renderGraph]);

  // Handle resize with debounce
  useEffect(() => {
    let timeoutId: number;
    const updateDimensions = () => {
      clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        if (containerRef.current) {
          const { width, height } = containerRef.current.getBoundingClientRect();
          setDimensions({ width, height });
        }
      }, 100);
    };
    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => {
      window.removeEventListener('resize', updateDimensions);
      clearTimeout(timeoutId);
    };
  }, []);

  // Initialize SVG once
  useEffect(() => {
    if (!svgRef.current || initializedRef.current) return;

    const svg = d3.select(svgRef.current);
    const { width, height } = dimensions;

    // Create main group
    const g = svg.append('g').attr('class', 'main-group');
    gRef.current = g;

    // Add zoom
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });

    svg.call(zoom);
    svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(0.8));

    // Create layer groups
    g.append('g').attr('class', 'links');
    g.append('g').attr('class', 'nodes');
    g.append('g').attr('class', 'authors');

    // Create simulation with smooth settling - runs continuously until naturally stable
    const simulation = d3.forceSimulation<SimNode>([])
      .force('link', d3.forceLink<SimNode, SimLink>([]).id(d => d.id).distance(30).strength(0.4))
      .force('charge', d3.forceManyBody<SimNode>().strength(d => d.type === 'directory' ? -80 : -15).distanceMax(200))
      .force('center', d3.forceCenter(0, 0).strength(0.02))
      .force('collision', d3.forceCollide<SimNode>().radius(d => d.type === 'directory' ? 14 : 6).iterations(2))
      .force('radial', d3.forceRadial<SimNode>(d => d.depth * 60, 0, 0).strength(0.1))
      .velocityDecay(0.35) // Smooth motion - lower = more momentum
      .alphaDecay(0.02) // Slow cooling - allows full settling
      .alphaMin(0.001); // Stop when essentially stable

    // Set up tick handler once
    simulation.on('tick', renderGraph);

    simulationRef.current = simulation;
    initializedRef.current = true;

    return () => {
      simulation.stop();
    };
  }, [dimensions]);

  // Update graph when fileTree changes
  useEffect(() => {
    if (!gRef.current || !simulationRef.current) return;

    const g = gRef.current;
    const simulation = simulationRef.current;
    const existingNodes = nodesRef.current;

    // Get current tree data
    const allNodes = flattenTree(fileTree);
    const links = getTreeLinks(fileTree);

    // Build parent map for positioning new nodes
    const parentMap = new Map<string, string>();
    const calcParents = (node: FileNode, parentId?: string) => {
      if (parentId) parentMap.set(node.id, parentId);
      node.children?.forEach(c => calcParents(c, node.id));
    };
    calcParents(fileTree);

    // Calculate depths
    const depthMap = new Map<string, number>();
    const calcDepth = (node: FileNode, depth: number) => {
      depthMap.set(node.id, depth);
      node.children?.forEach(c => calcDepth(c, depth + 1));
    };
    calcDepth(fileTree, 0);

    // Build new nodes, positioning new nodes near their parent
    const newNodes: SimNode[] = allNodes.map(node => {
      const existing = existingNodes.get(node.id);
      if (existing) {
        existing.name = node.name;
        existing.path = node.path;
        existing.type = node.type;
        existing.color = node.color;
        existing.depth = depthMap.get(node.id) || 0;
        return existing;
      }

      // New node - position near parent
      const parentId = parentMap.get(node.id);
      const parent = parentId ? existingNodes.get(parentId) : null;
      const depth = depthMap.get(node.id) || 0;

      // Position based on parent or radial layout
      let x: number, y: number;
      if (parent && parent.x !== undefined && parent.y !== undefined) {
        // Position near parent with slight randomness
        const angle = Math.random() * Math.PI * 2;
        const dist = 20 + Math.random() * 15;
        x = parent.x + Math.cos(angle) * dist;
        y = parent.y + Math.sin(angle) * dist;
      } else {
        // Radial position based on depth
        const angle = Math.random() * Math.PI * 2;
        const radius = depth * 50;
        x = Math.cos(angle) * radius;
        y = Math.sin(angle) * radius;
      }

      return {
        id: node.id,
        name: node.name,
        path: node.path,
        type: node.type,
        color: node.color,
        depth,
        parentId,
        x,
        y,
        vx: 0,
        vy: 0,
      };
    });

    // Update node map
    nodesRef.current = new Map(newNodes.map(n => [n.id, n]));

    // Build links
    const newLinks: SimLink[] = links.map(link => ({
      source: link.source.id,
      target: link.target.id,
    }));

    // Update simulation data
    simulation.nodes(newNodes);
    (simulation.force('link') as d3.ForceLink<SimNode, SimLink>).links(newLinks);

    // Update DOM - Links
    const linkGroup = g.select<SVGGElement>('g.links');
    const linkSelection = linkGroup.selectAll<SVGLineElement, SimLink>('line')
      .data(newLinks, d => `${(d.source as SimNode).id || d.source}-${(d.target as SimNode).id || d.target}`);

    linkSelection.exit().remove();

    linkSelection.enter()
      .append('line')
      .attr('stroke', '#334155')
      .attr('stroke-opacity', 0.4)
      .attr('stroke-width', 1);

    // Update DOM - Nodes
    const nodeGroup = g.select<SVGGElement>('g.nodes');
    const nodeSelection = nodeGroup.selectAll<SVGGElement, SimNode>('g.node')
      .data(newNodes, d => d.id);

    nodeSelection.exit().remove();

    const enter = nodeSelection.enter()
      .append('g')
      .attr('class', 'node')
      .attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`)
      .style('cursor', d => d.type === 'file' ? 'pointer' : 'default');

    // Add click handler for files
    enter.filter(d => d.type === 'file')
      .on('click', (event, d) => {
        event.stopPropagation();
        onFileSelect?.(d.path);
      });

    // Add hover handlers for tooltip
    enter.on('mouseenter', function(event, d) {
      if (d.type === 'file') {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          setTooltip({
            x: event.clientX - rect.left,
            y: event.clientY - rect.top - 30,
            text: d.path,
          });
        }
      }
    })
    .on('mouseleave', () => {
      setTooltip(null);
    });

    enter.filter(d => d.type === 'directory')
      .append('circle')
      .attr('r', d => d.id === 'root' ? 12 : 8)
      .attr('fill', d => d.id === 'root' ? '#6366f1' : '#475569')
      .attr('stroke', '#94a3b8')
      .attr('stroke-width', 1);

    enter.filter(d => d.type === 'file')
      .append('circle')
      .attr('r', 4)
      .attr('fill', d => d.color || '#8da0cb')
      .attr('stroke', '#1e293b')
      .attr('stroke-width', 0.5);

    enter.filter(d => d.type === 'directory' && d.id !== 'root')
      .append('text')
      .attr('dx', 12)
      .attr('dy', 3)
      .attr('fill', '#94a3b8')
      .attr('font-size', '9px')
      .attr('font-family', 'monospace')
      .text(d => d.name.length > 12 ? d.name.slice(0, 10) + '..' : d.name);

    // Cache selections
    nodeSelectionRef.current = nodeGroup.selectAll<SVGGElement, SimNode>('g.node');
    linkSelectionRef.current = linkGroup.selectAll<SVGLineElement, SimLink>('line');

    // Render immediately with current positions
    renderGraph(true);

    // Determine how much to reheat the simulation based on changes
    // More new nodes = more energy needed to settle them
    const newNodeCount = newNodes.filter(n => !existingNodes.has(n.id)).length;
    const hasChanges = newNodeCount > 0 || newNodes.length !== existingNodes.size;

    if (hasChanges) {
      // Proportional reheat: more new nodes = higher alpha
      // Base alpha ensures some settling, scales up with more nodes
      const baseAlpha = 0.05;
      const perNodeAlpha = 0.01;
      const maxAlpha = 0.3;
      const targetAlpha = Math.min(maxAlpha, baseAlpha + newNodeCount * perNodeAlpha);

      // Only increase alpha, never decrease it if simulation is already running
      const currentAlpha = simulation.alpha();
      if (targetAlpha > currentAlpha) {
        simulation.alpha(targetAlpha);
      }
      simulation.restart();
    }

  }, [fileTree, renderGraph, onFileSelect]);

  // Update selected file highlighting
  useEffect(() => {
    if (!nodeSelectionRef.current) return;

    nodeSelectionRef.current
      .select('circle')
      .attr('stroke-width', d => d.path === selectedFile ? 2.5 : (d.type === 'directory' ? 1 : 0.5))
      .attr('stroke', d => d.path === selectedFile ? '#fff' : (d.type === 'directory' ? '#94a3b8' : '#1e293b'));
  }, [selectedFile]);

  // Handle file modifications (highlight animations) - simplified
  useEffect(() => {
    if (!gRef.current || modifiedFiles.length === 0) return;

    const g = gRef.current;
    const nodeMap = nodesRef.current;
    const nodeGroup = g.select<SVGGElement>('g.nodes');

    const modifiedPositions: { x: number; y: number }[] = [];

    modifiedFiles.forEach(file => {
      const simNode = nodeMap.get(file.id);
      if (!simNode || simNode.x === undefined || simNode.y === undefined) return;

      modifiedPositions.push({ x: simNode.x, y: simNode.y });

      const nodeEl = nodeGroup.selectAll<SVGGElement, SimNode>('g.node')
        .filter(d => d.id === file.id);

      if (nodeEl.empty()) return;

      const circle = nodeEl.select('circle');
      const originalR = parseFloat(circle.attr('r')) || 4;

      let pulseColor = '#22c55e';
      if (file.status === 'modified') pulseColor = '#eab308';
      if (file.status === 'removed') pulseColor = '#ef4444';

      // Immediate color change, quick size pulse
      circle
        .attr('fill', pulseColor)
        .attr('r', originalR * 1.8)
        .transition().duration(200)
        .attr('r', originalR)
        .attr('fill', file.status === 'removed' ? '#ef4444' : (file.color || '#8da0cb'));
    });

    // Show author badge
    if (currentCommit && modifiedPositions.length > 0) {
      const author = authors.get(currentCommit.author.email);
      if (author) {
        const avgX = modifiedPositions.reduce((sum, p) => sum + p.x, 0) / modifiedPositions.length;
        const avgY = modifiedPositions.reduce((sum, p) => sum + p.y, 0) / modifiedPositions.length;
        showAuthorBadge(g, author, avgX, avgY);
      }
    }
  }, [modifiedFiles, authors, currentCommit]);

  return (
    <div ref={containerRef} className="visualization-container">
      <svg
        ref={svgRef}
        width={dimensions.width}
        height={dimensions.height}
        style={{
          background: 'radial-gradient(ellipse at center, #1e293b 0%, #0f172a 100%)',
        }}
      />
      {tooltip && (
        <div
          className="node-tooltip"
          style={{
            left: tooltip.x,
            top: tooltip.y,
          }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}

function showAuthorBadge(
  g: d3.Selection<SVGGElement, unknown, null, undefined>,
  author: Author,
  x: number,
  y: number
) {
  const authorGroup = g.select<SVGGElement>('g.authors');

  // Limit badge count to prevent accumulation
  const badges = authorGroup.selectAll('.author-badge');
  if (badges.size() > 5) {
    badges.filter((_, i) => i < badges.size() - 5).remove();
  }

  const badge = authorGroup.append('g')
    .attr('class', 'author-badge')
    .attr('transform', `translate(${x + 20}, ${y - 20})`)
    .style('opacity', 0);

  badge.append('circle')
    .attr('r', 12)
    .attr('fill', author.color)
    .attr('stroke', '#fff')
    .attr('stroke-width', 1.5);

  badge.append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', 4)
    .attr('fill', '#fff')
    .attr('font-size', '10px')
    .attr('font-weight', 'bold')
    .text(author.name.charAt(0).toUpperCase());

  badge.transition().duration(100).style('opacity', 1);

  badge.transition().delay(600).duration(200)
    .style('opacity', 0)
    .remove();
}
