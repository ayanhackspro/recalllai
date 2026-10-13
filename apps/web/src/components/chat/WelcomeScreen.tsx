"use client";

import { useState } from "react";
import {
  BrainCircuit,
  CalendarRange,
  HelpCircle,
  Lightbulb,
  Target,
} from "lucide-react";
import { useApp } from "@/store/AppStore";

const STARTERS = [
  {
    icon: HelpCircle,
    title: "Explain a concept step by step",
    sub: "Show the reasoning, then the abstraction",
    prompt: "Explain eigenvalues step by step, starting from what a matrix actually does to a vector.",
  },
  {
    icon: Lightbulb,
    title: "Help me understand a mistake",
    sub: "Bring a problem you keep getting wrong",
    prompt:
      "I keep applying F = ma without accounting for the net force and it breaks on ramps. Where exactly does my reasoning go wrong?",
  },
  {
    icon: Target,
    title: "Quiz me on a topic",
    sub: "Short questions, hardest last",
    prompt: "Quiz me on matrix decompositions — start with the basics and build up.",
  },
  {
    icon: CalendarRange,
    title: "Make a revision plan",
    sub: "Weighted to your weakest areas",
    prompt: "Make me a revision plan for a linear algebra exam in two weeks.",
  },
];

export function WelcomeScreen() {
  const { state, setDraft, setResponseMode, toggleContext, newConversation } = useApp();
  const [started, setStarted] = useState(false);

  /**
   * A starter fills the composer and focuses it. It never sends silently —
   * the user keeps control of when the message goes.
   */
  const applyPrompt = (prompt: string) => {
    setDraft(prompt);
    setResponseMode(prompt.toLowerCase().startsWith("quiz") ? "quiz" : "study");
    setStarted(true);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLTextAreaElement>(".composer-textarea");
      el?.focus();
    });
  };

  const hasGoal = state.context.items.some((m) => m.type === "goal");

  return (
    <div className="welcome">
      <div className="welcome-inner rise">
        <h2>A study companion that remembers.</h2>
        <p>
          Ask a question, attach your notes or a photo of a problem. Useful goals,
          topics and recurring mistakes get recorded, and shape later answers —
          with the reason shown in plain language.
        </p>

        {hasGoal && !started && (
          <button
            type="button"
            className="starter"
            style={{ gridColumn: "1 / -1", justifyContent: "center" }}
            onClick={() => applyPrompt("Where should I pick up next?")}
          >
            <BrainCircuit size={16} />
            <span className="starter-text">
              <span className="starter-title">Continue studying</span>
              <span className="starter-sub">
                Based on your recorded goal and what you last got wrong
              </span>
            </span>
          </button>
        )}

        <div className="starters">
          {STARTERS.map((s) => (
            <button
              key={s.title}
              type="button"
              className="starter"
              onClick={() => applyPrompt(s.prompt)}
            >
              <s.icon size={17} />
              <span className="starter-text">
                <span className="starter-title">{s.title}</span>
                <span className="starter-sub">{s.sub}</span>
              </span>
            </button>
          ))}
        </div>

        <p className="demo-note">
          <strong>Running on sample data.</strong> Seeded conversations and the{" "}
          <span className="badge-demo">demo</span> memory record are fixtures for
          previewing the interface — connect the backend to see your own.
          {!state.activeId && (
            <>
              {" "}
              <button
                type="button"
                onClick={() => void newConversation()}
                style={{ textDecoration: "underline", cursor: "pointer" }}
              >
                Start a conversation
              </button>
            </>
          )}
        </p>

        <button
          type="button"
          className="btn"
          data-variant="ghost"
          onClick={() => toggleContext(true)}
        >
          <BrainCircuit size={14} style={{ marginRight: 7 }} />
          What RecallAI remembers
        </button>
      </div>
    </div>
  );
}