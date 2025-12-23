import { useEffect, useRef, useCallback, useState } from 'react';
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
  children?: FileNode[];
  parent?: FileNode;
  status?: string;
  color?: string;
  lastAuthor?: string;
  depth: number;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  source: SimNode;
  target: SimNode;
}

interface ActiveAuthor {
  author: Author;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  opacity: number;
}

export default function Visualization({
  fileTree,
  authors,
  currentCommit,
  modifiedFiles,
}: VisualizationProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simulationRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const activeAuthorsRef = useRef<Map<string, ActiveAuthor>>(new Map());
  const animationFrameRef = useRef<number>(0);

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

  // Calculate node depth
  const getNodeDepth = useCallback((node: FileNode, depth = 0): number => {
    if (!node.parent) return depth;
    return depth;
  }, []);

  // Main visualization update
  useEffect(() => {
    if (!svgRef.current || dimensions.width === 0) return;

    const svg = d3.select(svgRef.current);
    const { width, height } = dimensions;
    const centerX = width / 2;
    const centerY = height / 2;

    // Clear previous content
    svg.selectAll('*').remove();

    // Create gradient definitions
    const defs = svg.append('defs');

    // Radial gradient for glow effects
    const glowGradient = defs.append('radialGradient')
      .attr('id', 'nodeGlow')
      .attr('cx', '50%')
      .attr('cy', '50%')
      .attr('r', '50%');

    glowGradient.append('stop')
      .attr('offset', '0%')
      .attr('stop-color', '#ffffff')
      .attr('stop-opacity', 0.8);

    glowGradient.append('stop')
      .attr('offset', '100%')
      .attr('stop-color', '#ffffff')
      .attr('stop-opacity', 0);

    // Create main group with zoom
    const g = svg.append('g').attr('class', 'main-group');

    // Add zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });

    svg.call(zoom);

    // Initial zoom to center
    svg.call(zoom.transform, d3.zoomIdentity.translate(centerX, centerY).scale(0.8));

    // Prepare data
    const allNodes = flattenTree(fileTree);
    const links = getTreeLinks(fileTree);

    // Calculate depths
    const nodeDepthMap = new Map<string, number>();
    function calculateDepths(node: FileNode, depth: number) {
      nodeDepthMap.set(node.id, depth);
      node.children?.forEach(child => calculateDepths(child, depth + 1));
    }
    calculateDepths(fileTree, 0);

    const nodes: SimNode[] = allNodes.map(node => ({
      ...node,
      depth: nodeDepthMap.get(node.id) || 0,
    }));

    const simLinks: SimLink[] = links.map(link => ({
      source: nodes.find(n => n.id === link.source.id)!,
      target: nodes.find(n => n.id === link.target.id)!,
    })).filter(link => link.source && link.target);

    // Create force simulation
    const simulation = d3.forceSimulation<SimNode>(nodes)
      .force('link', d3.forceLink<SimNode, SimLink>(simLinks)
        .id(d => d.id)
        .distance(d => {
          const sourceDepth = d.source.depth;
          return 30 + sourceDepth * 10;
        })
        .strength(0.8))
      .force('charge', d3.forceManyBody<SimNode>()
        .strength(d => d.type === 'directory' ? -150 : -30))
      .force('center', d3.forceCenter(0, 0).strength(0.05))
      .force('collision', d3.forceCollide<SimNode>()
        .radius(d => d.type === 'directory' ? 20 : 8))
      .force('radial', d3.forceRadial<SimNode>(
        d => d.depth * 80,
        0, 0
      ).strength(0.3));

    simulationRef.current = simulation;

    // Create links
    const linkGroup = g.append('g').attr('class', 'links');
    const link = linkGroup.selectAll<SVGLineElement, SimLink>('line')
      .data(simLinks)
      .join('line')
      .attr('stroke', '#334155')
      .attr('stroke-opacity', 0.4)
      .attr('stroke-width', 1);

    // Create nodes
    const nodeGroup = g.append('g').attr('class', 'nodes');
    const node = nodeGroup.selectAll<SVGGElement, SimNode>('g')
      .data(nodes)
      .join('g')
      .attr('class', 'node')
      .call(d3.drag<SVGGElement, SimNode>()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended));

    // Directory nodes (circles)
    node.filter(d => d.type === 'directory')
      .append('circle')
      .attr('r', d => d.id === 'root' ? 15 : 10)
      .attr('fill', d => d.id === 'root' ? '#6366f1' : '#475569')
      .attr('stroke', '#94a3b8')
      .attr('stroke-width', 1);

    // File nodes (small circles with color based on file type)
    node.filter(d => d.type === 'file')
      .append('circle')
      .attr('r', 5)
      .attr('fill', d => d.color || '#8da0cb')
      .attr('stroke', '#1e293b')
      .attr('stroke-width', 0.5);

    // Labels for directories
    node.filter(d => d.type === 'directory' && d.id !== 'root')
      .append('text')
      .attr('dx', 15)
      .attr('dy', 4)
      .attr('fill', '#94a3b8')
      .attr('font-size', '10px')
      .attr('font-family', 'monospace')
      .text(d => d.name.length > 15 ? d.name.slice(0, 12) + '...' : d.name);

    // Tooltip for file names
    node.filter(d => d.type === 'file')
      .append('title')
      .text(d => d.path);

    // Author avatars group
    const authorGroup = g.append('g').attr('class', 'authors');

    function dragstarted(event: d3.D3DragEvent<SVGGElement, SimNode, SimNode>) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      event.subject.fx = event.subject.x;
      event.subject.fy = event.subject.y;
    }

    function dragged(event: d3.D3DragEvent<SVGGElement, SimNode, SimNode>) {
      event.subject.fx = event.x;
      event.subject.fy = event.y;
    }

    function dragended(event: d3.D3DragEvent<SVGGElement, SimNode, SimNode>) {
      if (!event.active) simulation.alphaTarget(0);
      event.subject.fx = null;
      event.subject.fy = null;
    }

    // Animation loop for authors
    function animateAuthors() {
      const authorData = Array.from(activeAuthorsRef.current.values());

      const avatars = authorGroup.selectAll<SVGGElement, ActiveAuthor>('g.author')
        .data(authorData, d => d.author.email);

      // Enter
      const enter = avatars.enter()
        .append('g')
        .attr('class', 'author')
        .attr('transform', d => `translate(${d.x}, ${d.y})`);

      // Add glow effect
      enter.append('circle')
        .attr('r', 25)
        .attr('fill', d => d.author.color)
        .attr('opacity', 0.2)
        .attr('filter', 'blur(8px)');

      // Add avatar circle background
      enter.append('circle')
        .attr('r', 18)
        .attr('fill', d => d.author.color)
        .attr('stroke', '#fff')
        .attr('stroke-width', 2);

      // Add avatar image or initial
      enter.each(function(d) {
        const g = d3.select(this);
        if (d.author.avatarUrl) {
          // Clip path for circular avatar
          const clipId = `clip-${d.author.email.replace(/[^a-zA-Z0-9]/g, '')}`;
          defs.append('clipPath')
            .attr('id', clipId)
            .append('circle')
            .attr('r', 16);

          g.append('image')
            .attr('xlink:href', d.author.avatarUrl)
            .attr('x', -16)
            .attr('y', -16)
            .attr('width', 32)
            .attr('height', 32)
            .attr('clip-path', `url(#${clipId})`);
        } else {
          g.append('text')
            .attr('text-anchor', 'middle')
            .attr('dy', 6)
            .attr('fill', '#fff')
            .attr('font-size', '14px')
            .attr('font-weight', 'bold')
            .text(d.author.name.charAt(0).toUpperCase());
        }
      });

      // Add name label
      enter.append('text')
        .attr('y', 30)
        .attr('text-anchor', 'middle')
        .attr('fill', '#e2e8f0')
        .attr('font-size', '11px')
        .attr('font-family', 'system-ui')
        .text(d => d.author.name.split(' ')[0]);

      // Update positions
      avatars.merge(enter)
        .transition()
        .duration(300)
        .attr('transform', d => `translate(${d.x}, ${d.y})`)
        .attr('opacity', d => d.opacity);

      // Exit
      avatars.exit()
        .transition()
        .duration(500)
        .attr('opacity', 0)
        .remove();

      animationFrameRef.current = requestAnimationFrame(animateAuthors);
    }

    animateAuthors();

    // Simulation tick
    simulation.on('tick', () => {
      link
        .attr('x1', d => d.source.x!)
        .attr('y1', d => d.source.y!)
        .attr('x2', d => d.target.x!)
        .attr('y2', d => d.target.y!);

      node.attr('transform', d => `translate(${d.x}, ${d.y})`);

      // Update active authors positions towards their targets
      activeAuthorsRef.current.forEach((author) => {
        author.x += (author.targetX - author.x) * 0.1;
        author.y += (author.targetY - author.y) * 0.1;
      });
    });

    return () => {
      simulation.stop();
      cancelAnimationFrame(animationFrameRef.current);
    };
  }, [fileTree, dimensions, getNodeDepth]);

  // Handle file modifications (animate changes)
  useEffect(() => {
    if (!svgRef.current || !simulationRef.current || modifiedFiles.length === 0) return;

    const svg = d3.select(svgRef.current);
    const simulation = simulationRef.current;

    // Find modified nodes and highlight them
    modifiedFiles.forEach(file => {
      const simNode = simulation.nodes().find(n => n.id === file.id);
      if (!simNode) return;

      // Get author for this file
      const authorKey = file.lastAuthor;
      if (authorKey) {
        const author = authors.get(authorKey);
        if (author && simNode.x !== undefined && simNode.y !== undefined) {
          // Position author near the modified file
          activeAuthorsRef.current.set(authorKey, {
            author,
            x: simNode.x + (Math.random() - 0.5) * 50,
            y: simNode.y + (Math.random() - 0.5) * 50,
            targetX: simNode.x + 40,
            targetY: simNode.y - 40,
            opacity: 1,
          });

          // Fade out author after delay
          setTimeout(() => {
            const activeAuthor = activeAuthorsRef.current.get(authorKey);
            if (activeAuthor) {
              activeAuthor.opacity = 0;
              setTimeout(() => {
                activeAuthorsRef.current.delete(authorKey);
              }, 500);
            }
          }, 2000);
        }
      }

      // Animate the node
      const nodeEl = svg.selectAll<SVGGElement, SimNode>('g.node')
        .filter(d => d.id === file.id);

      const circle = nodeEl.select('circle');
      const originalFill = circle.attr('fill');
      const originalR = parseFloat(circle.attr('r'));

      // Pulse animation based on status
      let pulseColor = '#22c55e'; // green for added
      if (file.status === 'modified') pulseColor = '#eab308'; // yellow
      if (file.status === 'removed') pulseColor = '#ef4444'; // red

      circle
        .transition()
        .duration(200)
        .attr('fill', pulseColor)
        .attr('r', originalR * 2)
        .transition()
        .duration(300)
        .attr('r', originalR * 1.5)
        .transition()
        .duration(500)
        .attr('fill', file.status === 'removed' ? '#ef4444' : originalFill)
        .attr('r', originalR);

      // If removed, fade out and remove
      if (file.status === 'removed') {
        nodeEl
          .transition()
          .delay(800)
          .duration(500)
          .style('opacity', 0)
          .remove();
      }
    });

    // Reheat simulation slightly
    simulation.alpha(0.1).restart();
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
