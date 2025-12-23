import { useEffect, useRef, useState, useCallback } from 'react';
import * as d3 from 'd3';
import type { FileNode, Author, Commit } from '../types';
import { flattenTree, getTreeLinks } from '../utils/fileTree';

interface VisualizationProps {
  fileTree: FileNode;
  authors: Map<string, Author>;
  currentCommit: Commit | null;
  currentCommitIndex?: number;
  modifiedFiles: FileNode[];
  onFileSelect?: (path: string) => void;
  selectedFile?: string | null;
}

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'directory' | 'author';
  color?: string;
  depth: number;
  parentId?: string;
  // Author-specific properties
  email?: string;
  lastActiveIndex?: number;
  targetX?: number;
  targetY?: number;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  source: SimNode | string;
  target: SimNode | string;
  isAuthorLink?: boolean;
  changeSize?: number; // For author links: additions + deletions
}

// Number of commits of inactivity before removing an author
const AUTHOR_INACTIVITY_THRESHOLD = 15;

export default function Visualization({
  fileTree,
  authors,
  currentCommit,
  currentCommitIndex = 0,
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
  const authorNodesRef = useRef<Map<string, SimNode>>(new Map());
  const gRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const initializedRef = useRef(false);

  // Cached selections for performance
  const nodeSelectionRef = useRef<d3.Selection<SVGGElement, SimNode, SVGGElement, unknown> | null>(null);
  const linkSelectionRef = useRef<d3.Selection<SVGLineElement, SimLink, SVGGElement, unknown> | null>(null);
  const authorSelectionRef = useRef<d3.Selection<SVGGElement, SimNode, SVGGElement, unknown> | null>(null);
  const authorLinkSelectionRef = useRef<d3.Selection<SVGLineElement, SimLink, SVGGElement, unknown> | null>(null);

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
    const authorSelection = authorSelectionRef.current;
    const authorLinkSelection = authorLinkSelectionRef.current;

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

    if (authorSelection) {
      authorSelection.attr('transform', d => `translate(${d.x},${d.y})`);
    }

    if (authorLinkSelection) {
      const nodeMap = nodesRef.current;
      const authorNodeMap = authorNodesRef.current;
      authorLinkSelection.each(function(d) {
        const sourceId = typeof d.source === 'string' ? d.source : (d.source as SimNode).id;
        const targetId = typeof d.target === 'string' ? d.target : (d.target as SimNode).id;
        const sourceNode = authorNodeMap.get(sourceId) || nodeMap.get(sourceId);
        const targetNode = nodeMap.get(targetId) || authorNodeMap.get(targetId);

        const line = d3.select(this);

        // Hide link if either endpoint is missing
        if (!sourceNode || !targetNode ||
            sourceNode.x === undefined || sourceNode.y === undefined ||
            targetNode.x === undefined || targetNode.y === undefined) {
          line.attr('visibility', 'hidden');
          return;
        }

        line
          .attr('visibility', 'visible')
          .attr('x1', sourceNode.x)
          .attr('y1', sourceNode.y)
          .attr('x2', targetNode.x)
          .attr('y2', targetNode.y);
      });
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
          // Remove transient author links (they may be in weird states)
          gRef.current.select('g.author-links').selectAll('*').remove();
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

    zoomRef.current = zoom;
    svg.call(zoom);

    // Center the view - translate so (0,0) is at center of viewport
    svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(0.8));

    // Create layer groups (order matters: bottom to top)
    g.append('g').attr('class', 'links');           // File/directory tree links
    g.append('g').attr('class', 'author-links');    // Transient author-to-file links
    g.append('g').attr('class', 'nodes');           // File and directory nodes
    g.append('g').attr('class', 'authors');         // Author nodes (on top)

    // Custom force for author positioning - gently attracts to target with damping
    const authorPositionForce = () => {
      let nodes: SimNode[] = [];

      const force = (alpha: number) => {
        for (const node of nodes) {
          if (node.type === 'author' && node.targetX !== undefined && node.targetY !== undefined) {
            // Very gentle attraction to target position
            const dx = node.targetX - (node.x || 0);
            const dy = node.targetY - (node.y || 0);
            const strength = 0.02 * alpha; // Gentle pull
            node.vx = (node.vx || 0) + dx * strength;
            node.vy = (node.vy || 0) + dy * strength;
            // Apply extra damping to author velocity for smooth motion
            node.vx! *= 0.85;
            node.vy! *= 0.85;
          }
        }
      };

      force.initialize = (n: SimNode[]) => { nodes = n; };
      return force;
    };

    // Create simulation with smooth settling - runs continuously until naturally stable
    const simulation = d3.forceSimulation<SimNode>([])
      .force('link', d3.forceLink<SimNode, SimLink>([]).id(d => d.id).distance(30).strength(0.4))
      .force('charge', d3.forceManyBody<SimNode>().strength(d => {
        if (d.type === 'author') return -30; // Authors repel less
        if (d.type === 'directory') return -80;
        return -15;
      }).distanceMax(200))
      .force('center', d3.forceCenter(0, 0).strength(0.02))
      .force('collision', d3.forceCollide<SimNode>().radius(d => {
        if (d.type === 'author') return 18; // Author collision radius (slightly smaller to yield)
        if (d.type === 'directory') return 14;
        return 6;
      }).iterations(2).strength(0.7)) // Moderate collision strength
      .force('radial', d3.forceRadial<SimNode>(d => {
        if (d.type === 'author') return 0; // Authors don't follow radial
        return d.depth * 60;
      }, 0, 0).strength(d => d.type === 'author' ? 0 : 0.1))
      .force('authorPosition', authorPositionForce())
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

  // Recenter view when dimensions change (but only after initial setup)
  useEffect(() => {
    if (!svgRef.current || !zoomRef.current || !initializedRef.current) return;

    const svg = d3.select(svgRef.current);
    const { width, height } = dimensions;

    // Recenter the view
    svg.call(zoomRef.current.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(0.8));
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

    // Add hover handlers for tooltip and node enlargement
    enter.on('mouseenter', function(event, d) {
      // Show tooltip for files
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

      // Enlarge node on hover
      const node = d3.select(this);
      const circle = node.select('circle');
      // Use fixed base radius to prevent compounding growth when animations overlap
      const baseR = d.type === 'directory' ? (d.id === 'root' ? 12 : 8) : 4;
      const enlargedR = baseR * 1.8;

      circle.transition()
        .duration(100)
        .attr('r', enlargedR)
        .attr('stroke-width', d.type === 'directory' ? 2 : 1.5);
    })
    .on('mouseleave', function(_, d) {
      setTooltip(null);

      // Restore original node size
      const node = d3.select(this);
      const circle = node.select('circle');
      const originalR = d.type === 'directory' ? (d.id === 'root' ? 12 : 8) : 4;

      circle.transition()
        .duration(100)
        .attr('r', originalR)
        .attr('stroke-width', d.type === 'directory' ? 1 : 0.5);
    });

    // Directory nodes
    enter.filter(d => d.type === 'directory')
      .append('circle')
      .attr('r', d => d.id === 'root' ? 12 : 8)
      .attr('fill', d => d.id === 'root' ? '#6366f1' : '#475569')
      .attr('stroke', '#94a3b8')
      .attr('stroke-width', 1);

    // File nodes
    enter.filter(d => d.type === 'file')
      .append('circle')
      .attr('r', 4)
      .attr('fill', d => d.color || '#8da0cb')
      .attr('stroke', '#1e293b')
      .attr('stroke-width', 0.5);

    // Directory labels - improved readability
    const dirLabels = enter.filter(d => d.type === 'directory' && d.id !== 'root');

    // Add background rect for better contrast
    dirLabels.append('rect')
      .attr('class', 'label-bg')
      .attr('x', 10)
      .attr('y', -7)
      .attr('rx', 3)
      .attr('ry', 3)
      .attr('fill', 'rgba(15, 23, 42, 0.85)')
      .attr('stroke', 'rgba(148, 163, 184, 0.3)')
      .attr('stroke-width', 0.5);

    dirLabels.append('text')
      .attr('dx', 14)
      .attr('dy', 4)
      .attr('fill', '#e2e8f0')
      .attr('font-size', '11px')
      .attr('font-family', "'SF Mono', Monaco, monospace")
      .attr('font-weight', '500')
      .text(d => d.name.length > 15 ? d.name.slice(0, 13) + '..' : d.name)
      .each(function() {
        // Size the background rect to fit the text
        const parentEl = d3.select(this.parentNode as Element);
        const bbox = (this as SVGTextElement).getBBox();
        parentEl.select('.label-bg')
          .attr('width', bbox.width + 8)
          .attr('height', bbox.height + 4);
      });

    // Cache selections
    nodeSelectionRef.current = nodeGroup.selectAll<SVGGElement, SimNode>('g.node');
    linkSelectionRef.current = linkGroup.selectAll<SVGLineElement, SimLink>('line');

    // Render immediately with current positions
    renderGraph(true);

    // Determine how much to reheat the simulation based on changes
    const newNodeCount = newNodes.filter(n => !existingNodes.has(n.id)).length;
    const removedNodeCount = existingNodes.size - (newNodes.length - newNodeCount);
    const totalChanges = newNodeCount + Math.max(0, removedNodeCount);

    // Always restart simulation when tree changes to ensure graph updates
    // Scale alpha based on magnitude of changes
    const baseAlpha = 0.1; // Minimum alpha to ensure visible settling
    const perChangeAlpha = 0.005;
    const maxAlpha = 0.5;
    const targetAlpha = Math.min(maxAlpha, baseAlpha + totalChanges * perChangeAlpha);

    // Force restart with calculated alpha - don't skip even if "no changes"
    // because the tree structure might have changed in ways we didn't detect
    simulation.alpha(targetAlpha).restart();

  }, [fileTree, renderGraph, onFileSelect]);

  // Update selected file highlighting
  useEffect(() => {
    if (!nodeSelectionRef.current) return;

    nodeSelectionRef.current
      .select('circle')
      .attr('stroke-width', d => d.path === selectedFile ? 2.5 : (d.type === 'directory' ? 1 : 0.5))
      .attr('stroke', d => d.path === selectedFile ? '#fff' : (d.type === 'directory' ? '#94a3b8' : '#1e293b'));
  }, [selectedFile]);

  // Handle file modifications and author nodes
  useEffect(() => {
    if (!gRef.current || !simulationRef.current) return;

    const g = gRef.current;
    const nodeMap = nodesRef.current;
    const authorNodes = authorNodesRef.current;
    const simulation = simulationRef.current;
    const nodeGroup = g.select<SVGGElement>('g.nodes');
    const authorGroup = g.select<SVGGElement>('g.authors');
    const authorLinkGroup = g.select<SVGGElement>('g.author-links');

    // Clear previous author links when processing new modifications
    authorLinkGroup.selectAll('*').remove();

    // Build a map of file path -> change size from current commit
    const fileSizeMap = new Map<string, number>();
    if (currentCommit) {
      currentCommit.files.forEach(f => {
        fileSizeMap.set(f.filename, (f.additions || 0) + (f.deletions || 0));
      });
    }

    // Collect modified file positions for author targeting
    const modifiedPositions: { x: number; y: number; id: string; changeSize: number }[] = [];

    // Animate file modifications
    modifiedFiles.forEach(file => {
      const simNode = nodeMap.get(file.id);
      if (!simNode || simNode.x === undefined || simNode.y === undefined) return;

      const changeSize = fileSizeMap.get(file.path) || 1;
      modifiedPositions.push({ x: simNode.x, y: simNode.y, id: simNode.id, changeSize });

      const nodeEl = nodeGroup.selectAll<SVGGElement, SimNode>('g.node')
        .filter(d => d.id === file.id);

      if (nodeEl.empty()) return;

      const circle = nodeEl.select('circle');
      // Use fixed base radius to prevent compounding growth when animations overlap at high speeds
      const originalR = 4; // Files always have radius 4

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

    // Handle author node for current commit
    if (currentCommit && modifiedPositions.length > 0) {
      const authorData = authors.get(currentCommit.author.email);
      if (authorData) {
        const authorId = `author-${currentCommit.author.email}`;
        let authorNode = authorNodes.get(authorId);

        // Calculate center of gravity of modified files
        const avgX = modifiedPositions.reduce((sum, p) => sum + p.x, 0) / modifiedPositions.length;
        const avgY = modifiedPositions.reduce((sum, p) => sum + p.y, 0) / modifiedPositions.length;

        if (!authorNode) {
          // Create new author node - start near the modified files
          authorNode = {
            id: authorId,
            name: authorData.name,
            path: authorData.email,
            type: 'author',
            color: authorData.color,
            depth: 0,
            email: authorData.email,
            lastActiveIndex: currentCommitIndex,
            targetX: avgX,
            targetY: avgY,
            x: avgX + (Math.random() - 0.5) * 50,
            y: avgY + (Math.random() - 0.5) * 50,
            vx: 0,
            vy: 0,
          };
          authorNodes.set(authorId, authorNode);
        } else {
          // Update existing author
          authorNode.lastActiveIndex = currentCommitIndex;
          authorNode.targetX = avgX;
          authorNode.targetY = avgY;
          authorNode.color = authorData.color;
        }

        // Remove inactive authors
        const toRemove: string[] = [];
        authorNodes.forEach((node, id) => {
          const inactiveFor = currentCommitIndex - (node.lastActiveIndex || 0);
          if (inactiveFor > AUTHOR_INACTIVITY_THRESHOLD) {
            toRemove.push(id);
          }
        });
        toRemove.forEach(id => authorNodes.delete(id));

        // Get all file/dir nodes and active author nodes
        const fileNodes = Array.from(nodeMap.values());
        const activeAuthorNodes = Array.from(authorNodes.values());
        const allNodes = [...fileNodes, ...activeAuthorNodes];

        // Update simulation with all nodes (including authors)
        simulation.nodes(allNodes);

        // Update DOM - Author nodes
        const authorSelection = authorGroup.selectAll<SVGGElement, SimNode>('g.author-node')
          .data(activeAuthorNodes, d => d.id);

        // Remove old authors with fade
        authorSelection.exit()
          .transition().duration(300)
          .style('opacity', 0)
          .remove();

        // Add new authors
        const enterAuthors = authorSelection.enter()
          .append('g')
          .attr('class', 'author-node')
          .attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`)
          .style('opacity', 0);

        // Author circle
        enterAuthors.append('circle')
          .attr('r', 16)
          .attr('fill', d => d.color || '#6366f1')
          .attr('stroke', '#fff')
          .attr('stroke-width', 2)
          .style('filter', 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))');

        // Author initial letter
        enterAuthors.append('text')
          .attr('text-anchor', 'middle')
          .attr('dy', 5)
          .attr('fill', '#fff')
          .attr('font-size', '11px')
          .attr('font-weight', 'bold')
          .attr('pointer-events', 'none')
          .text(d => d.name.charAt(0).toUpperCase());

        // Author name label below
        enterAuthors.append('text')
          .attr('class', 'author-label')
          .attr('text-anchor', 'middle')
          .attr('dy', 30)
          .attr('fill', '#94a3b8')
          .attr('font-size', '9px')
          .attr('pointer-events', 'none')
          .text(d => d.name.length > 12 ? d.name.slice(0, 10) + '..' : d.name);

        // Fade in
        enterAuthors.transition().duration(300).style('opacity', 1);

        // Update existing author colors
        authorSelection
          .select('circle')
          .attr('fill', d => d.color || '#6366f1');

        // Cache author selection
        authorSelectionRef.current = authorGroup.selectAll<SVGGElement, SimNode>('g.author-node');

        // Calculate max change size for scaling
        const maxChangeSize = Math.max(...modifiedPositions.map(p => p.changeSize), 1);

        // Draw persistent glowing edges from author to modified files
        const authorLinks: SimLink[] = modifiedPositions.map(pos => ({
          source: authorId,
          target: pos.id,
          isAuthorLink: true,
          changeSize: pos.changeSize,
        }));

        // Subtle purple color for author links
        const linkColor = '#a78bfa'; // Soft purple

        // Calculate stroke width based on change size (thinner: 0.5-2px)
        const getStrokeWidth = (changeSize: number) => {
          const normalized = Math.log(changeSize + 1) / Math.log(maxChangeSize + 1);
          return 0.5 + normalized * 1.5; // 0.5-2 range
        };

        // Calculate glow intensity based on change size
        const getGlowFilter = (changeSize: number) => {
          const normalized = Math.log(changeSize + 1) / Math.log(maxChangeSize + 1);
          const blur = 3 + normalized * 5; // 3-8px blur for nice glow
          return `drop-shadow(0 0 ${blur}px ${linkColor})`;
        };

        const linkSelection = authorLinkGroup.selectAll<SVGLineElement, SimLink>('line.author-link')
          .data(authorLinks, d => `${d.source}-${d.target}`);

        linkSelection.exit().remove();

        // Create the links with subtle purple glow
        const enterLinks = linkSelection.enter()
          .append('line')
          .attr('class', 'author-link')
          .attr('stroke', linkColor)
          .attr('stroke-opacity', 0.35)
          .attr('stroke-width', d => getStrokeWidth(d.changeSize || 1))
          .attr('stroke-linecap', 'round')
          .style('filter', d => getGlowFilter(d.changeSize || 1))
          .attr('x1', authorNode.x || 0)
          .attr('y1', authorNode.y || 0)
          .attr('x2', d => {
            const target = nodeMap.get(d.target as string);
            return target?.x || 0;
          })
          .attr('y2', d => {
            const target = nodeMap.get(d.target as string);
            return target?.y || 0;
          });

        // Fade in smoothly
        enterLinks
          .attr('stroke-opacity', 0)
          .transition().duration(200)
          .attr('stroke-opacity', 0.35);

        // Cache author link selection for tick updates (persists until next commit)
        authorLinkSelectionRef.current = authorLinkGroup.selectAll<SVGLineElement, SimLink>('line.author-link');

        // Reheat simulation gently
        simulation.alpha(0.15).restart();
      }
    }
  }, [modifiedFiles, authors, currentCommit, currentCommitIndex]);

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

