"use client";

import {
  AlertTriangle,
  ArrowRight,
  Brain,
  CheckCircle2,
  Clock,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import type { GraphNode, GraphMasteryStatus } from "@recallai/shared-types";

interface ConceptInspectorDrawerProps {
  node: GraphNode;
  onClose: () => void;
  onSelectTopic: (topicName: string) => void;
  onLaunchQuiz: (topicName: string) => void;
}

const STATUS_CONFIG: Record<
  GraphMasteryStatus,
  { label: string; tone: string; icon: typeof Brain; desc: string }
> = {
  mastered: {
    label: "Mastered",
    tone: "mastered",
    icon: CheckCircle2,
    desc: "Retention threshold solidified. Long spacing intervals applied.",
  },
  learning: {
    label: "In Progress",
    tone: "learning",
    icon: Zap,
    desc: "Active recall developing. Routine spaced repetitions recommended.",
  },
  review_due: {
    label: "Review Due",
    tone: "review-due",
    icon: Clock,
    desc: "Approaching Ebbinghaus forgetting curve. Optimal time to reinforce.",
  },
  struggling: {
    label: "Struggling / Mistake",
    tone: "struggling",
    icon: AlertTriangle,
    desc: "Recurring misconception or low recall accuracy detected.",
  },
  unexplored: {
    label: "Unexplored",
    tone: "unexplored",
    icon: Sparkles,
    desc: "Concept identified in academic curriculum but not yet tested.",
  },
};

export function ConceptInspectorDrawer({
  node,
  onClose,
  onSelectTopic,
  onLaunchQuiz,
}: ConceptInspectorDrawerProps) {
  const statusCfg = STATUS_CONFIG[node.status] || STATUS_CONFIG.unexplored;
  const StatusIcon = statusCfg.icon;

  const formatReviewTime = () => {
    if (!node.nextReviewAt) return null;
    const diff = new Date(node.nextReviewAt).getTime() - Date.now();
    const hours = Math.round(diff / 36e5);
    if (hours <= 0) return "Review overdue now";
    if (hours < 24) return `Due in ${hours} hours`;
    const days = Math.round(hours / 24);
    return `Due in ${days} days`;
  };

  const reviewTimeStr = formatReviewTime();

  return (
    <aside className="concept-inspector">
      <div className="inspector-head">
        <div className="inspector-meta">
          <span className="badge category-badge">{node.category}</span>
          <span className="badge status-badge" data-status={statusCfg.tone}>
            <StatusIcon size={12} />
            {statusCfg.label}
          </span>
        </div>
        <button
          type="button"
          className="icon-btn"
          data-quiet="true"
          onClick={onClose}
          aria-label="Close inspector"
        >
          <X size={16} />
        </button>
      </div>

      <div className="inspector-body scroll">
        <h2 className="concept-title">{node.label}</h2>

        {/* Mastery Gauge & Retention Stats */}
        <div className="inspector-card mastery-card">
          <div className="mastery-header">
            <div>
              <span className="mastery-label">SM-2 Concept Mastery</span>
              <div className="mastery-score-display">
                <span className="score-num">{node.masteryScore}%</span>
                <span className="score-sub">{statusCfg.label}</span>
              </div>
            </div>
            <div className="mastery-meter-bar">
              <div
                className="mastery-meter-fill"
                data-status={statusCfg.tone}
                style={{ width: `${Math.max(node.masteryScore, 4)}%` }}
              />
            </div>
          </div>

          <p className="mastery-desc">{statusCfg.desc}</p>

          <div className="sm2-stats-grid">
            <div className="sm2-stat">
              <span className="stat-label">Repetitions</span>
              <span className="stat-value">{node.repetitionCount ?? 0}</span>
            </div>
            <div className="sm2-stat">
              <span className="stat-label">Interval</span>
              <span className="stat-value">
                {node.intervalDays ? `${node.intervalDays}d` : "None"}
              </span>
            </div>
            <div className="sm2-stat">
              <span className="stat-label">Next Review</span>
              <span className="stat-value highlight">{reviewTimeStr ?? "Unscheduled"}</span>
            </div>
          </div>
        </div>

        {/* Concept Definition / Overview */}
        <div className="inspector-section">
          <h3>Academic Overview</h3>
          <p className="concept-summary">{node.summary}</p>
        </div>

        {/* Recurring Mistake Callout */}
        {node.connectedMistakes.length > 0 && (
          <div className="inspector-card mistake-card">
            <div className="mistake-head">
              <AlertTriangle size={15} className="mistake-icon" />
              <h4>Recorded Misconception / Mistake</h4>
            </div>
            {node.connectedMistakes.map((m) => (
              <div key={m.id} className="mistake-item">
                <p className="mistake-text">{m.summary}</p>
                {m.masteryScore !== undefined && (
                  <span className="mistake-score">Accuracy: {m.masteryScore}%</span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Prerequisites Chain */}
        <div className="inspector-section">
          <h3>Prerequisites</h3>
          {node.prerequisites.length > 0 ? (
            <div className="concept-chips">
              {node.prerequisites.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="concept-chip prereq-chip"
                  onClick={() => onSelectTopic(p)}
                  title={`View prerequisite: ${p}`}
                >
                  <span>{p}</span>
                  <ArrowRight size={12} />
                </button>
              ))}
            </div>
          ) : (
            <p className="empty-sub">
              Foundational axiom — no prior academic prerequisites required.
            </p>
          )}
        </div>

        {/* Dependents / Unlocked Concepts */}
        <div className="inspector-section">
          <h3>Unlocks Concepts</h3>
          {node.dependents.length > 0 ? (
            <div className="concept-chips">
              {node.dependents.map((d) => (
                <button
                  key={d}
                  type="button"
                  className="concept-chip unlock-chip"
                  onClick={() => onSelectTopic(d)}
                  title={`View unlocked concept: ${d}`}
                >
                  <span>{d}</span>
                  <ArrowRight size={12} />
                </button>
              ))}
            </div>
          ) : (
            <p className="empty-sub">
              Terminal topic in this syllabus branch.
            </p>
          )}
        </div>
      </div>

      <div className="inspector-foot">
        <button
          type="button"
          className="btn btn-quiz-launch"
          onClick={() => onLaunchQuiz(node.label)}
        >
          <Sparkles size={16} />
          <span>Launch Quick Quiz on this Topic</span>
        </button>
      </div>
    </aside>
  );
}
