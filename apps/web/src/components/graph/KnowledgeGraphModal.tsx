"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Network, RefreshCw, Search, X } from "lucide-react";
import type { KnowledgeGraphData, GraphNode } from "@recallai/shared-types";
import { api } from "@/lib/api";
import { useApp } from "@/store/AppStore";
import { KnowledgeGraphCanvas } from "./KnowledgeGraphCanvas";
import { ConceptInspectorDrawer } from "./ConceptInspectorDrawer";

export function KnowledgeGraphModal() {
  const { state, toggleGraph, launchTopicQuiz } = useApp();
  const [data, setData] = useState<KnowledgeGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters & Selection
  const [activeCategory, setActiveCategory] = useState<string>("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const selectedNodeIdRef = useRef<string | null>(null);
  selectedNodeIdRef.current = selectedNode?.id ?? null;

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (api.getKnowledgeGraph) {
        const res = await api.getKnowledgeGraph();
        setData(res);
        if (selectedNodeIdRef.current) {
          const fresh = res.nodes.find((n) => n.id === selectedNodeIdRef.current);
          if (fresh) setSelectedNode(fresh);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load knowledge graph.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (state.graphOpen) {
      void fetchGraph();
    }
  }, [state.graphOpen, fetchGraph]);

  // Keyboard shortcut: Escape closes inspector first, then modal
  useEffect(() => {
    if (!state.graphOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (selectedNode) {
          setSelectedNode(null);
        } else {
          toggleGraph(false);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state.graphOpen, selectedNode, toggleGraph]);

  const categories = useMemo(() => {
    return ["All", "Physics", "Chemistry", "Mathematics", "Computer Science"];
  }, []);

  const handleSelectTopicName = useCallback(
    (topicName: string) => {
      if (!data) return;
      const target = data.nodes.find((n) => n.id === topicName);
      if (target) {
        setSelectedNode(target);
      }
    },
    [data],
  );

  const handleLaunchQuiz = useCallback(
    (topicName: string) => {
      void launchTopicQuiz(topicName);
    },
    [launchTopicQuiz],
  );

  if (!state.graphOpen) return null;

  return (
    <div
      className="graph-modal-veil"
      role="dialog"
      aria-modal="true"
      aria-label="Academic Knowledge Graph & Mastery Heatmap"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          toggleGraph(false);
        }
      }}
    >
      <div className="graph-modal">
        {/* Header Bar */}
        <header className="graph-modal-header">
          <div className="graph-header-title-block">
            <div className="graph-header-icon-wrap">
              <Network size={20} className="graph-icon" />
            </div>
            <div>
              <div className="graph-title-row">
                <h2>Knowledge Graph &amp; Mastery Heatmap</h2>
                <span className="live-pulse-badge">
                  <span className="live-dot" />
                  Live SM-2 Synced
                </span>
              </div>
              <p className="graph-subtitle">
                Interactive academic concept ontology powered by FalkorDB graph reasoning
              </p>
            </div>
          </div>

          {/* Category Filter Pills */}
          <div className="graph-category-filters">
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                className="category-pill"
                data-active={activeCategory === cat}
                onClick={() => setActiveCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Search Input */}
          <div className="graph-search-bar">
            <Search size={14} className="s-icon" />
            <input
              type="text"
              placeholder="Search concepts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="s-clear"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* Action buttons */}
          <div className="graph-header-actions">
            <button
              type="button"
              className="icon-btn"
              data-quiet="true"
              onClick={() => void fetchGraph()}
              title="Refresh graph data"
              aria-label="Refresh graph data"
            >
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            </button>
            <button
              type="button"
              className="icon-btn close-graph-btn"
              data-quiet="true"
              onClick={() => toggleGraph(false)}
              title="Close graph (Esc)"
              aria-label="Close knowledge graph"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        {/* Live Mastery Stats Banner */}
        {data && (
          <div className="graph-stats-banner">
            <div className="stat-pill total">
              <span className="stat-label">Total Concepts</span>
              <span className="stat-val">{data.summary.totalTopics}</span>
            </div>
            <div className="stat-pill mastered">
              <span className="stat-dot mastered" />
              <span className="stat-label">Mastered (≥75%)</span>
              <span className="stat-val">{data.summary.mastered}</span>
            </div>
            <div className="stat-pill learning">
              <span className="stat-dot learning" />
              <span className="stat-label">Learning (40-74%)</span>
              <span className="stat-val">{data.summary.learning}</span>
            </div>
            <div className="stat-pill review-due">
              <span className="stat-dot review-due" />
              <span className="stat-label">Review Due</span>
              <span className="stat-val">{data.summary.reviewDue}</span>
            </div>
            <div className="stat-pill struggling">
              <span className="stat-dot struggling" />
              <span className="stat-label">Struggling / Mistake</span>
              <span className="stat-val">{data.summary.struggling}</span>
            </div>
            <div className="stat-pill unexplored">
              <span className="stat-dot unexplored" />
              <span className="stat-label">Unexplored</span>
              <span className="stat-val">{data.summary.unexplored}</span>
            </div>
            {data.summary.averageMastery > 0 && (
              <div className="stat-pill average">
                <span className="stat-label">Average Mastery</span>
                <span className="stat-val highlight">{data.summary.averageMastery}%</span>
              </div>
            )}
          </div>
        )}

        {/* Graph Body / Viewport */}
        <div className="graph-body">
          {loading && !data ? (
            <div className="graph-loading-overlay">
              <div className="spinner" />
              <p>Traversing academic concept ontology...</p>
            </div>
          ) : error ? (
            <div className="graph-error-overlay">
              <p>{error}</p>
              <button
                type="button"
                className="btn"
                data-variant="ghost"
                onClick={() => void fetchGraph()}
              >
                Retry
              </button>
            </div>
          ) : data ? (
            <>
              <KnowledgeGraphCanvas
                nodes={data.nodes}
                edges={data.edges}
                selectedNodeId={selectedNode?.id ?? null}
                onSelectNode={(node) => setSelectedNode(node)}
                activeCategory={activeCategory}
                searchFilter={searchQuery}
              />

              {/* Floating Legend */}
              <div className="graph-legend">
                <div className="legend-title">Mastery Heatmap &amp; Flow</div>
                <div className="legend-items">
                  <div className="legend-item">
                    <span className="legend-color mastered" />
                    <span>Mastered (≥75%)</span>
                  </div>
                  <div className="legend-item">
                    <span className="legend-color learning" />
                    <span>Learning (40-74%)</span>
                  </div>
                  <div className="legend-item">
                    <span className="legend-color review-due" />
                    <span>Review Due (SM-2)</span>
                  </div>
                  <div className="legend-item">
                    <span className="legend-color struggling" />
                    <span>Recurring Mistake</span>
                  </div>
                  <div className="legend-item">
                    <span className="legend-color unexplored" />
                    <span>Unexplored Prereq</span>
                  </div>
                  <div className="legend-divider" />
                  <div className="legend-item flow">
                    <span className="legend-particle-sample" />
                    <span>Prerequisite Arrow</span>
                  </div>
                </div>
              </div>

              {/* Inspector Drawer */}
              {selectedNode && (
                <ConceptInspectorDrawer
                  node={selectedNode}
                  onClose={() => setSelectedNode(null)}
                  onSelectTopic={handleSelectTopicName}
                  onLaunchQuiz={handleLaunchQuiz}
                />
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
