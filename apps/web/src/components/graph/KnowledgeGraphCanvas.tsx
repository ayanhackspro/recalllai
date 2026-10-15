"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { GraphNode, GraphEdge, GraphMasteryStatus } from "@recallai/shared-types";

interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

interface Particle {
  edgeId: string;
  source: string;
  target: string;
  t: number; // 0 to 1
  speed: number;
}

interface KnowledgeGraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId: string | null;
  onSelectNode: (node: GraphNode | null) => void;
  activeCategory: string;
  searchFilter: string;
}

const STATUS_COLORS: Record<
  GraphMasteryStatus,
  { core: string; ring: string; glow: string; text: string }
> = {
  mastered: {
    core: "#10b981",
    ring: "rgba(16, 185, 129, 0.4)",
    glow: "rgba(16, 185, 129, 0.25)",
    text: "#6ee7b7",
  },
  learning: {
    core: "#f59e0b",
    ring: "rgba(245, 158, 11, 0.4)",
    glow: "rgba(245, 158, 11, 0.22)",
    text: "#fcd34d",
  },
  review_due: {
    core: "#f97316",
    ring: "rgba(249, 115, 22, 0.5)",
    glow: "rgba(249, 115, 22, 0.35)",
    text: "#fdba74",
  },
  struggling: {
    core: "#ef4444",
    ring: "rgba(239, 68, 68, 0.5)",
    glow: "rgba(239, 68, 68, 0.35)",
    text: "#fca5a5",
  },
  unexplored: {
    core: "#64748b",
    ring: "rgba(100, 116, 139, 0.3)",
    glow: "rgba(100, 116, 139, 0.12)",
    text: "#94a3b8",
  },
};

export function KnowledgeGraphCanvas({
  nodes,
  edges,
  selectedNodeId,
  onSelectNode,
  activeCategory,
  searchFilter,
}: KnowledgeGraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Simulation state
  const simNodesRef = useRef<SimNode[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const animFrameRef = useRef<number | null>(null);
  const simAlphaRef = useRef<number>(1.0);

  // Transform / viewport state (Pan & Zoom)
  const [transform, setTransform] = useState({ x: 0, y: 0, zoom: 1 });
  const transformRef = useRef(transform);
  transformRef.current = transform;

  // Interaction tracking
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const hoveredNodeRef = useRef<string | null>(null);
  hoveredNodeRef.current = hoveredNodeId;

  const isDraggingRef = useRef(false);
  const draggedNodeRef = useRef<SimNode | null>(null);
  const panStartRef = useRef<{ x: number; y: number } | null>(null);
  const hasMovedRef = useRef(false);

  // Initialize or update simulation nodes when prop nodes change
  useEffect(() => {
    if (!containerRef.current || nodes.length === 0) return;
    const { clientWidth: width, clientHeight: height } = containerRef.current;
    const cx = width / 2;
    const cy = height / 2;

    const existingMap = new Map<string, SimNode>(
      simNodesRef.current.map((n) => [n.id, n]),
    );

    const newSimNodes: SimNode[] = nodes.map((n, i) => {
      const existing = existingMap.get(n.id);
      if (existing) {
        return {
          ...n,
          x: existing.x,
          y: existing.y,
          vx: existing.vx,
          vy: existing.vy,
          radius: n.id === selectedNodeId ? 28 : 22,
        };
      }

      // Initial placement in categorical clusters or spiral
      const categoryAngle =
        n.category === "Physics"
          ? 0
          : n.category === "Chemistry"
            ? Math.PI / 2
            : n.category === "Mathematics"
              ? Math.PI
              : (3 * Math.PI) / 2;
      const angle = categoryAngle + (i % 6) * 0.45;
      const dist = 160 + (i % 4) * 55;

      return {
        ...n,
        x: cx + Math.cos(angle) * dist + (Math.random() - 0.5) * 40,
        y: cy + Math.sin(angle) * dist + (Math.random() - 0.5) * 40,
        vx: 0,
        vy: 0,
        radius: n.id === selectedNodeId ? 28 : 22,
      };
    });

    simNodesRef.current = newSimNodes;
    simAlphaRef.current = 1.0;

    // Initialize edge particles for directed prerequisite arrows
    const newParticles: Particle[] = [];
    for (const e of edges) {
      if (e.type === "PREREQUISITE_OF") {
        newParticles.push({
          edgeId: e.id,
          source: e.source,
          target: e.target,
          t: Math.random(),
          speed: 0.004 + Math.random() * 0.003,
        });
        newParticles.push({
          edgeId: e.id,
          source: e.source,
          target: e.target,
          t: (Math.random() + 0.5) % 1.0,
          speed: 0.004 + Math.random() * 0.003,
        });
      }
    }
    particlesRef.current = newParticles;
  }, [nodes, edges, selectedNodeId]);

  // Handle focus snap when selectedNodeId or searchFilter changes
  useEffect(() => {
    if (!selectedNodeId || !containerRef.current) return;
    const target = simNodesRef.current.find((n) => n.id === selectedNodeId);
    if (target) {
      const { clientWidth: w, clientHeight: h } = containerRef.current;
      setTransform((prev) => ({
        x: w / 2 - target.x * prev.zoom,
        y: h / 2 - target.y * prev.zoom,
        zoom: Math.max(prev.zoom, 1.1),
      }));
    }
  }, [selectedNodeId]);

  // Main simulation and render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let running = true;

    const render = () => {
      if (!running) return;

      const container = containerRef.current;
      if (container) {
        const dpr = window.devicePixelRatio || 1;
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
          canvas.width = w * dpr;
          canvas.height = h * dpr;
          canvas.style.width = `${w}px`;
          canvas.style.height = `${h}px`;
        }
      }

      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      const cx = w / 2;
      const cy = h / 2;

      // 1. Force Simulation Step
      const simNodes = simNodesRef.current;
      const alpha = simAlphaRef.current;

      if (alpha > 0.005) {
        // Node repulsion
        for (let i = 0; i < simNodes.length; i++) {
          const n1 = simNodes[i];
          for (let j = i + 1; j < simNodes.length; j++) {
            const n2 = simNodes[j];
            const dx = n2.x - n1.x;
            const dy = n2.y - n1.y;
            const distSq = dx * dx + dy * dy || 1;
            const dist = Math.sqrt(distSq);

            const minDist = (n1.radius + n2.radius) * 2.8;
            if (dist < minDist) {
              const force = ((minDist - dist) / dist) * 0.12 * alpha;
              const fx = dx * force;
              const fy = dy * force;
              if (draggedNodeRef.current !== n1) {
                n1.vx -= fx;
                n1.vy -= fy;
              }
              if (draggedNodeRef.current !== n2) {
                n2.vx += fx;
                n2.vy += fy;
              }
            } else {
              // Standard Coulomb repulsion
              const repulse = (2800 / distSq) * alpha;
              const fx = (dx / dist) * repulse;
              const fy = (dy / dist) * repulse;
              if (draggedNodeRef.current !== n1) {
                n1.vx -= fx;
                n1.vy -= fy;
              }
              if (draggedNodeRef.current !== n2) {
                n2.vx += fx;
                n2.vy += fy;
              }
            }
          }
        }

        // Edge attraction (Hooke's Spring)
        const nodeMap = new Map(simNodes.map((n) => [n.id, n]));
        for (const edge of edges) {
          const s = nodeMap.get(edge.source);
          const t = nodeMap.get(edge.target);
          if (!s || !t) continue;

          const dx = t.x - s.x;
          const dy = t.y - s.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const targetDist = edge.type === "PREREQUISITE_OF" ? 140 : 180;
          const spring = (dist - targetDist) * 0.015 * alpha;

          const fx = (dx / dist) * spring;
          const fy = (dy / dist) * spring;

          if (draggedNodeRef.current !== s) {
            s.vx += fx;
            s.vy += fy;
          }
          if (draggedNodeRef.current !== t) {
            t.vx -= fx;
            t.vy -= fy;
          }
        }

        // Center gravity
        for (const n of simNodes) {
          if (draggedNodeRef.current === n) continue;
          const dx = cx - n.x;
          const dy = cy - n.y;
          n.vx += dx * 0.003 * alpha;
          n.vy += dy * 0.003 * alpha;

          // Apply velocity with damping
          n.vx *= 0.88;
          n.vy *= 0.88;
          n.x += n.vx;
          n.y += n.vy;
        }

        simAlphaRef.current *= 0.985;
      }

      // 2. Clear canvas
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      // Apply Pan & Zoom Viewport
      const { x: panX, y: panY, zoom } = transformRef.current;
      ctx.translate(panX, panY);
      ctx.scale(zoom, zoom);

      // Determine active / highlighted sets based on hover or selection
      const activeId = hoveredNodeRef.current || selectedNodeId;
      const activeNode = activeId ? simNodes.find((n) => n.id === activeId) : null;
      const highlightIds = new Set<string>();
      if (activeNode) {
        highlightIds.add(activeNode.id);
        activeNode.prerequisites.forEach((p) => highlightIds.add(p));
        activeNode.dependents.forEach((d) => highlightIds.add(d));
      }

      const nodeMap = new Map(simNodes.map((n) => [n.id, n]));

      // 3. Render Edges
      for (const edge of edges) {
        const s = nodeMap.get(edge.source);
        const t = nodeMap.get(edge.target);
        if (!s || !t) continue;

        const isPrereq = edge.type === "PREREQUISITE_OF";
        const isHighlight =
          highlightIds.size > 0 &&
          highlightIds.has(edge.source) &&
          highlightIds.has(edge.target);

        const isDim =
          highlightIds.size > 0 &&
          !(highlightIds.has(edge.source) && highlightIds.has(edge.target));

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);

        if (isHighlight) {
          ctx.strokeStyle = isPrereq ? "rgba(56, 189, 248, 0.85)" : "rgba(245, 158, 11, 0.75)";
          ctx.lineWidth = 2.4;
        } else if (isDim) {
          ctx.strokeStyle = "rgba(148, 163, 184, 0.08)";
          ctx.lineWidth = 1;
        } else {
          ctx.strokeStyle = isPrereq ? "rgba(56, 189, 248, 0.35)" : "rgba(148, 163, 184, 0.18)";
          ctx.lineWidth = isPrereq ? 1.6 : 1.2;
          if (!isPrereq) {
            ctx.setLineDash([4, 4]);
          }
        }
        ctx.stroke();

        // Draw arrow marker for directed PREREQUISITE_OF edges
        if (isPrereq) {
          const dx = t.x - s.x;
          const dy = t.y - s.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 0) {
            const arrowDist = t.radius + 6;
            const arrowX = t.x - (dx / dist) * arrowDist;
            const arrowY = t.y - (dy / dist) * arrowDist;
            const angle = Math.atan2(dy, dx);
            const headlen = 7;

            ctx.fillStyle = isHighlight ? "rgba(56, 189, 248, 0.95)" : "rgba(56, 189, 248, 0.55)";
            ctx.beginPath();
            ctx.moveTo(arrowX, arrowY);
            ctx.lineTo(
              arrowX - headlen * Math.cos(angle - Math.PI / 6),
              arrowY - headlen * Math.sin(angle - Math.PI / 6),
            );
            ctx.lineTo(
              arrowX - headlen * Math.cos(angle + Math.PI / 6),
              arrowY - headlen * Math.sin(angle + Math.PI / 6),
            );
            ctx.closePath();
            ctx.fill();
          }
        }
        ctx.restore();
      }

      // 4. Render Flowing Animated Particles along prerequisite paths
      const now = performance.now();
      for (const p of particlesRef.current) {
        const s = nodeMap.get(p.source);
        const t = nodeMap.get(p.target);
        if (!s || !t) continue;

        p.t = (p.t + p.speed) % 1.0;
        const px = s.x + (t.x - s.x) * p.t;
        const py = s.y + (t.y - s.y) * p.t;

        const isHighlight =
          highlightIds.has(p.source) && highlightIds.has(p.target);

        ctx.save();
        ctx.beginPath();
        ctx.arc(px, py, isHighlight ? 3.0 : 2.0, 0, Math.PI * 2);
        ctx.fillStyle = isHighlight ? "#38bdf8" : "rgba(56, 189, 248, 0.75)";
        ctx.shadowColor = "#38bdf8";
        ctx.shadowBlur = isHighlight ? 8 : 4;
        ctx.fill();
        ctx.restore();
      }

      // 5. Render Nodes (Mastery Heatmap & Glowing Halos)
      for (const node of simNodes) {
        const isSelected = node.id === selectedNodeId;
        const isHovered = node.id === hoveredNodeRef.current;
        const isDim =
          highlightIds.size > 0 && !highlightIds.has(node.id);
        const isCategoryMatch =
          activeCategory === "All" || node.category === activeCategory;
        const isSearchMatch =
          !searchFilter.trim() ||
          node.label.toLowerCase().includes(searchFilter.trim().toLowerCase());

        const effectiveDim = isDim || !isCategoryMatch || !isSearchMatch;
        const palette = STATUS_COLORS[node.status] || STATUS_COLORS.unexplored;

        ctx.save();
        ctx.globalAlpha = effectiveDim ? 0.22 : 1.0;

        // Radial Halo Glow
        const pulse =
          node.status === "review_due"
            ? Math.sin(now * 0.005) * 4 + 4
            : node.status === "struggling"
              ? Math.sin(now * 0.004) * 3 + 3
              : 0;

        const haloRadius = node.radius + (isSelected ? 18 : 12) + pulse;
        const gradient = ctx.createRadialGradient(
          node.x,
          node.y,
          node.radius * 0.6,
          node.x,
          node.y,
          haloRadius,
        );
        gradient.addColorStop(0, palette.glow);
        gradient.addColorStop(1, "rgba(0, 0, 0, 0)");

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(node.x, node.y, haloRadius, 0, Math.PI * 2);
        ctx.fill();

        // Node Outer Ring
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + (isSelected ? 3 : 1), 0, Math.PI * 2);
        ctx.strokeStyle = isSelected
          ? "#ffffff"
          : isHovered
            ? palette.core
            : palette.ring;
        ctx.lineWidth = isSelected ? 2.5 : isHovered ? 2.0 : 1.2;
        if (node.status === "unexplored") {
          ctx.setLineDash([3, 3]);
        }
        ctx.stroke();

        // Node Core Body
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = isSelected
          ? "rgba(15, 23, 42, 0.95)"
          : "rgba(10, 14, 20, 0.92)";
        ctx.fill();

        // Status Center Pip / Indicator
        ctx.beginPath();
        ctx.arc(node.x, node.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = palette.core;
        ctx.shadowColor = palette.core;
        ctx.shadowBlur = 6;
        ctx.fill();
        ctx.shadowBlur = 0;

        // Recurring Mistake Badge Icon
        if (node.connectedMistakes.length > 0) {
          ctx.beginPath();
          ctx.arc(node.x + node.radius - 4, node.y - node.radius + 4, 6, 0, Math.PI * 2);
          ctx.fillStyle = "#ef4444";
          ctx.fill();
          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 9px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("!", node.x + node.radius - 4, node.y - node.radius + 4);
        }

        // Mastery Score Percentage Pill under Node
        if (node.status !== "unexplored" && node.masteryScore > 0) {
          const scoreText = `${node.masteryScore}%`;
          ctx.font = "600 10.5px sans-serif";
          const tw = ctx.measureText(scoreText).width;

          ctx.fillStyle = "rgba(15, 23, 42, 0.88)";
          ctx.strokeStyle = palette.ring;
          ctx.lineWidth = 1;
          const px = node.x - tw / 2 - 5;
          const py = node.y + node.radius + 5;
          ctx.beginPath();
          ctx.roundRect(px, py, tw + 10, 15, 4);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = palette.text;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(scoreText, node.x, py + 7.5);
        }

        // Node Title Label
        ctx.font = isSelected
          ? "600 13px 'Instrument Serif', Georgia, serif"
          : "500 12px sans-serif";
        ctx.fillStyle = isSelected
          ? "#f8fafc"
          : isHovered
            ? "#ffffff"
            : effectiveDim
              ? "rgba(226, 232, 240, 0.3)"
              : "rgba(226, 232, 240, 0.88)";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(
          node.label,
          node.x,
          node.status !== "unexplored" && node.masteryScore > 0
            ? node.y + node.radius + 24
            : node.y + node.radius + 6,
        );

        ctx.restore();
      }

      ctx.restore();
      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      running = false;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [edges, selectedNodeId, activeCategory, searchFilter]);

  // Coordinate Conversion (Screen -> Graph World)
  const screenToWorld = useCallback(
    (clientX: number, clientY: number) => {
      if (!canvasRef.current) return { x: 0, y: 0 };
      const rect = canvasRef.current.getBoundingClientRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      const { x: panX, y: panY, zoom } = transformRef.current;
      return {
        x: (sx - panX) / zoom,
        y: (sy - panY) / zoom,
      };
    },
    [],
  );

  // Mouse / Touch Event Handlers for Dragging, Panning, and Zooming
  const getNodeAt = useCallback(
    (worldX: number, worldY: number): SimNode | null => {
      const nodes = simNodesRef.current;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const dx = worldX - n.x;
        const dy = worldY - n.y;
        if (dx * dx + dy * dy <= (n.radius + 6) * (n.radius + 6)) {
          return n;
        }
      }
      return null;
    },
    [],
  );

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const world = screenToWorld(e.clientX, e.clientY);
    const hit = getNodeAt(world.x, world.y);

    hasMovedRef.current = false;

    if (hit) {
      draggedNodeRef.current = hit;
      isDraggingRef.current = true;
      simAlphaRef.current = Math.max(simAlphaRef.current, 0.4);
    } else {
      panStartRef.current = {
        x: e.clientX - transformRef.current.x,
        y: e.clientY - transformRef.current.y,
      };
      isDraggingRef.current = true;
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const world = screenToWorld(e.clientX, e.clientY);

    // Hover detection
    if (!draggedNodeRef.current && !panStartRef.current) {
      const hit = getNodeAt(world.x, world.y);
      setHoveredNodeId(hit ? hit.id : null);
    }

    if (!isDraggingRef.current) return;
    hasMovedRef.current = true;

    if (draggedNodeRef.current) {
      draggedNodeRef.current.x = world.x;
      draggedNodeRef.current.y = world.y;
      draggedNodeRef.current.vx = 0;
      draggedNodeRef.current.vy = 0;
      simAlphaRef.current = Math.max(simAlphaRef.current, 0.3);
    } else if (panStartRef.current) {
      setTransform((prev) => ({
        ...prev,
        x: e.clientX - panStartRef.current!.x,
        y: e.clientY - panStartRef.current!.y,
      }));
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!hasMovedRef.current && e.button === 0) {
      const world = screenToWorld(e.clientX, e.clientY);
      const hit = getNodeAt(world.x, world.y);
      onSelectNode(hit);
    }

    draggedNodeRef.current = null;
    panStartRef.current = null;
    isDraggingRef.current = false;
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY < 0 ? 1.12 : 0.88;
    setTransform((prev) => {
      const nextZoom = Math.min(Math.max(prev.zoom * zoomFactor, 0.35), 2.8);
      const worldX = (mouseX - prev.x) / prev.zoom;
      const worldY = (mouseY - prev.y) / prev.zoom;
      return {
        zoom: nextZoom,
        x: mouseX - worldX * nextZoom,
        y: mouseY - worldY * nextZoom,
      };
    });
  };

  return (
    <div ref={containerRef} className="graph-canvas-container">
      <canvas
        ref={canvasRef}
        className="graph-canvas"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
      />
    </div>
  );
}
