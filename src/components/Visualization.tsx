import { useEffect, useRef, useState, useCallback } from 'react';
import * as d3 from 'd3';
import type { FileNode, Author, Commit } from '../types';
import { flattenTree, getTreeLinks } from '../utils/fileTree';

interface VisualizationProps {
  fileTree: FileNode;
  authors: Map<string, Author>;
  currentCommit: Commit | null;
  modifiedFiles: FileNode[];
  isPlaying: boolean;
}

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'directory';
  color?: string;
  depth: number;
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
}: VisualizationProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  // Persistent refs for D3 elements
  const simulationRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<Map<string, SimNode>>(new Map());
  const gRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const initializedRef = useRef(false);

  // Cached selections for performance
  const nodeSelectionRef = useRef<d3.Selection<SVGGElement, SimNode, SVGGElement, unknown> | null>(null);
  const linkSelectionRef = useRef<d3.Selection<SVGLineElement, SimLink, SVGGElement, unknown> | null>(null);

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

    // Add zoom with passive event listeners
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

    // Create simulation with performance settings
    const simulation = d3.forceSimulation<SimNode>([])
      .force('link', d3.forceLink<SimNode, SimLink>([]).id(d => d.id).distance(30).strength(0.5))
      .force('charge', d3.forceManyBody<SimNode>().strength(d => d.type === 'directory' ? -80 : -15).distanceMax(200))
      .force('center', d3.forceCenter(0, 0).strength(0.02))
      .force('collision', d3.forceCollide<SimNode>().radius(d => d.type === 'directory' ? 15 : 6).iterations(1))
      .force('radial', d3.forceRadial<SimNode>(d => d.depth * 60, 0, 0).strength(0.2))
      .velocityDecay(0.4) // Faster settling
      .alphaDecay(0.05); // Faster cooling

    simulationRef.current = simulation;
    initializedRef.current = true;

    return () => {
      simulation.stop();
    };
  }, [dimensions]);

  // Memoized tick handler
  const tickHandler = useCallback(() => {
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

  // Update graph when fileTree changes
  useEffect(() => {
    if (!gRef.current || !simulationRef.current) return;

    const g = gRef.current;
    const simulation = simulationRef.current;
    const existingNodes = nodesRef.current;

    // Get current tree data
    const allNodes = flattenTree(fileTree);
    const links = getTreeLinks(fileTree);

    // Calculate depths efficiently
    const depthMap = new Map<string, number>();
    const calcDepth = (node: FileNode, depth: number) => {
      depthMap.set(node.id, depth);
      if (node.children) {
        for (const c of node.children) {
          calcDepth(c, depth + 1);
        }
      }
    };
    calcDepth(fileTree, 0);

    // Build new nodes, preserving positions from existing
    const newNodes: SimNode[] = allNodes.map(node => {
      const existing = existingNodes.get(node.id);
      if (existing) {
        // Update existing node properties but keep position
        existing.name = node.name;
        existing.path = node.path;
        existing.type = node.type;
        existing.color = node.color;
        existing.depth = depthMap.get(node.id) || 0;
        return existing;
      }
      return {
        id: node.id,
        name: node.name,
        path: node.path,
        type: node.type,
        color: node.color,
        depth: depthMap.get(node.id) || 0,
        x: (Math.random() - 0.5) * 50,
        y: (Math.random() - 0.5) * 50,
      };
    });

    // Update node map
    nodesRef.current = new Map(newNodes.map(n => [n.id, n]));

    // Build links
    const newLinks: SimLink[] = links.map(link => ({
      source: link.source.id,
      target: link.target.id,
    }));

    // Update simulation
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

    // Remove exiting nodes
    nodeSelection.exit().remove();

    // Enter new nodes
    const enter = nodeSelection.enter()
      .append('g')
      .attr('class', 'node')
      .attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`);

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

    enter.filter(d => d.type === 'file')
      .append('title')
      .text(d => d.path);

    // Cache selections for tick handler
    nodeSelectionRef.current = nodeGroup.selectAll<SVGGElement, SimNode>('g.node');
    linkSelectionRef.current = linkGroup.selectAll<SVGLineElement, SimLink>('line');

    // Set tick handler
    simulation.on('tick', tickHandler);

    // Reheat simulation gently
    simulation.alpha(0.2).restart();

  }, [fileTree, tickHandler]);

  // Handle file modifications (highlight animations)
  useEffect(() => {
    if (!gRef.current || modifiedFiles.length === 0) return;

    const g = gRef.current;
    const nodeMap = nodesRef.current;

    // Track modified positions for author placement
    const modifiedPositions: { x: number; y: number }[] = [];

    // Batch DOM operations
    const nodeGroup = g.select<SVGGElement>('g.nodes');

    modifiedFiles.forEach(file => {
      const simNode = nodeMap.get(file.id);
      if (!simNode || simNode.x === undefined || simNode.y === undefined) return;

      modifiedPositions.push({ x: simNode.x, y: simNode.y });

      // Find the DOM node efficiently
      const nodeEl = nodeGroup.selectAll<SVGGElement, SimNode>('g.node')
        .filter(d => d.id === file.id);

      if (nodeEl.empty()) return;

      const circle = nodeEl.select('circle');
      const originalR = parseFloat(circle.attr('r')) || 4;

      let pulseColor = '#22c55e';
      if (file.status === 'modified') pulseColor = '#eab308';
      if (file.status === 'removed') pulseColor = '#ef4444';

      // Simpler animation
      circle
        .attr('fill', pulseColor)
        .attr('r', originalR * 2)
        .transition().duration(300)
        .attr('r', originalR)
        .attr('fill', file.status === 'removed' ? '#ef4444' : (file.color || '#8da0cb'));
    });

    // Show ONE author badge per commit
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
      {currentCommit && (
        <div className="commit-info">
          <div className="commit-message">
            {currentCommit.message.split('\n')[0]}
          </div>
          <div className="commit-author">
            {currentCommit.author.name}
          </div>
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

  // Remove old badges first to prevent accumulation
  authorGroup.selectAll('.author-badge').filter(function() {
    const opacity = d3.select(this).style('opacity');
    return parseFloat(opacity) < 0.5;
  }).remove();

  const badge = authorGroup.append('g')
    .attr('class', 'author-badge')
    .attr('transform', `translate(${x + 25}, ${y - 25})`)
    .style('opacity', 0);

  badge.append('circle')
    .attr('r', 14)
    .attr('fill', author.color)
    .attr('stroke', '#fff')
    .attr('stroke-width', 2);

  badge.append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', 4)
    .attr('fill', '#fff')
    .attr('font-size', '11px')
    .attr('font-weight', 'bold')
    .text(author.name.charAt(0).toUpperCase());

  badge.transition().duration(150).style('opacity', 1);

  badge.transition().delay(800).duration(300)
    .style('opacity', 0)
    .remove();
}
