import { useEffect, useRef, useState } from 'react';
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

  // Handle resize
  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        setDimensions({ width, height });
      }
    };
    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
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

    // Create simulation
    const simulation = d3.forceSimulation<SimNode>([])
      .force('link', d3.forceLink<SimNode, SimLink>([]).id(d => d.id).distance(40).strength(0.8))
      .force('charge', d3.forceManyBody<SimNode>().strength(d => d.type === 'directory' ? -150 : -30))
      .force('center', d3.forceCenter(0, 0).strength(0.05))
      .force('collision', d3.forceCollide<SimNode>().radius(d => d.type === 'directory' ? 20 : 8))
      .force('radial', d3.forceRadial<SimNode>(d => d.depth * 80, 0, 0).strength(0.3));

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

    // Calculate depths
    const depthMap = new Map<string, number>();
    function calcDepth(node: FileNode, depth: number) {
      depthMap.set(node.id, depth);
      node.children?.forEach(c => calcDepth(c, depth + 1));
    }
    calcDepth(fileTree, 0);

    // Build new nodes, preserving positions from existing
    const newNodes: SimNode[] = allNodes.map(node => {
      const existing = existingNodes.get(node.id);
      return {
        id: node.id,
        name: node.name,
        path: node.path,
        type: node.type,
        color: node.color,
        depth: depthMap.get(node.id) || 0,
        // Preserve position if exists, otherwise start near parent or random
        x: existing?.x ?? (Math.random() - 0.5) * 100,
        y: existing?.y ?? (Math.random() - 0.5) * 100,
        vx: existing?.vx ?? 0,
        vy: existing?.vy ?? 0,
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
    linkGroup.selectAll<SVGLineElement, SimLink>('line')
      .data(newLinks, d => `${(d.source as SimNode).id || d.source}-${(d.target as SimNode).id || d.target}`)
      .join(
        enter => enter.append('line')
          .attr('stroke', '#334155')
          .attr('stroke-opacity', 0.4)
          .attr('stroke-width', 1),
        update => update,
        exit => exit.transition().duration(300).attr('stroke-opacity', 0).remove()
      );

    // Update DOM - Nodes
    const nodeGroup = g.select<SVGGElement>('g.nodes');
    const nodeSelection = nodeGroup.selectAll<SVGGElement, SimNode>('g.node')
      .data(newNodes, d => d.id);

    // Enter new nodes
    const enter = nodeSelection.enter()
      .append('g')
      .attr('class', 'node')
      .attr('transform', d => `translate(${d.x},${d.y})`)
      .style('opacity', 0);

    enter.filter(d => d.type === 'directory')
      .append('circle')
      .attr('r', d => d.id === 'root' ? 15 : 10)
      .attr('fill', d => d.id === 'root' ? '#6366f1' : '#475569')
      .attr('stroke', '#94a3b8')
      .attr('stroke-width', 1);

    enter.filter(d => d.type === 'file')
      .append('circle')
      .attr('r', 5)
      .attr('fill', d => d.color || '#8da0cb')
      .attr('stroke', '#1e293b')
      .attr('stroke-width', 0.5);

    enter.filter(d => d.type === 'directory' && d.id !== 'root')
      .append('text')
      .attr('dx', 15)
      .attr('dy', 4)
      .attr('fill', '#94a3b8')
      .attr('font-size', '10px')
      .attr('font-family', 'monospace')
      .text(d => d.name.length > 15 ? d.name.slice(0, 12) + '...' : d.name);

    enter.filter(d => d.type === 'file')
      .append('title')
      .text(d => d.path);

    enter.transition().duration(300).style('opacity', 1);

    // Exit old nodes
    nodeSelection.exit()
      .transition().duration(300)
      .style('opacity', 0)
      .remove();

    // Merged selection for tick
    const allNodeSelection = nodeGroup.selectAll<SVGGElement, SimNode>('g.node');
    const allLinkSelection = linkGroup.selectAll<SVGLineElement, SimLink>('line');

    // Tick handler
    simulation.on('tick', () => {
      allLinkSelection
        .attr('x1', d => (d.source as SimNode).x!)
        .attr('y1', d => (d.source as SimNode).y!)
        .attr('x2', d => (d.target as SimNode).x!)
        .attr('y2', d => (d.target as SimNode).y!);

      allNodeSelection.attr('transform', d => `translate(${d.x},${d.y})`);
    });

    // Reheat simulation gently
    simulation.alpha(0.3).restart();

  }, [fileTree]);

  // Handle file modifications (highlight animations)
  useEffect(() => {
    if (!gRef.current || modifiedFiles.length === 0) return;

    const g = gRef.current;
    const nodeMap = nodesRef.current;

    modifiedFiles.forEach(file => {
      const simNode = nodeMap.get(file.id);
      if (!simNode) return;

      // Find the DOM node
      const nodeEl = g.selectAll<SVGGElement, SimNode>('g.node')
        .filter(d => d.id === file.id);

      if (nodeEl.empty()) return;

      const circle = nodeEl.select('circle');
      const originalFill = circle.attr('fill');
      const originalR = parseFloat(circle.attr('r')) || 5;

      let pulseColor = '#22c55e';
      if (file.status === 'modified') pulseColor = '#eab308';
      if (file.status === 'removed') pulseColor = '#ef4444';

      circle
        .transition().duration(150)
        .attr('fill', pulseColor)
        .attr('r', originalR * 2.5)
        .transition().duration(200)
        .attr('r', originalR * 1.5)
        .transition().duration(400)
        .attr('fill', file.status === 'removed' ? '#ef4444' : originalFill)
        .attr('r', originalR);

      // Show author near file
      const authorKey = file.lastAuthor;
      if (authorKey && simNode.x !== undefined && simNode.y !== undefined) {
        const author = authors.get(authorKey);
        if (author) {
          showAuthorBadge(g, author, simNode.x, simNode.y);
        }
      }
    });
  }, [modifiedFiles, authors]);

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

  const badge = authorGroup.append('g')
    .attr('class', 'author-badge')
    .attr('transform', `translate(${x + 30}, ${y - 30})`)
    .style('opacity', 0);

  badge.append('circle')
    .attr('r', 16)
    .attr('fill', author.color)
    .attr('stroke', '#fff')
    .attr('stroke-width', 2);

  badge.append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', 5)
    .attr('fill', '#fff')
    .attr('font-size', '12px')
    .attr('font-weight', 'bold')
    .text(author.name.charAt(0).toUpperCase());

  badge.transition().duration(200).style('opacity', 1);

  badge.transition().delay(1500).duration(500)
    .style('opacity', 0)
    .remove();
}
