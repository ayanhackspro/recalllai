"use client";

import { Brain, Download, Menu, Pencil, Trash2 } from "lucide-react";
import { useApp } from "@/store/AppStore";

export function ConversationHeader() {
  const { state, toggleSidebar, toggleContext, renameConversation, deleteConversation } =
    useApp();

  const active = state.conversations.find((c) => c.id === state.activeId);
  const busy = state.generation === "streaming" || state.generation === "submitting";

  const status = busy
    ? { tone: "live", label: "Generating" }
    : state.generation === "error"
      ? { tone: "error", label: "Last answer failed" }
      : { tone: "idle", label: "Ready" };

  const exportNotes = () => {
    if (!active) return;
    const dateStr = new Date().toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const lines: string[] = [
      `# Revision Notes: ${active.title}`,
      `*Generated with RecallAI on ${dateStr}*`,
      ``,
    ];

    if (state.context.items.length > 0) {
      lines.push(`## Key Academic Context & Prerequisites`);
      for (const m of state.context.items) {
        lines.push(`- **[${m.label}]**: ${m.summary}`);
      }
      if (state.context.note) {
        lines.push(``, `> *${state.context.note}*`);
      }
      lines.push(``, `---`, ``);
    }

    lines.push(`## Study Dialogue`);
    for (const msg of state.messages) {
      if (msg.role === "user") {
        lines.push(`### Question`, msg.content, ``);
      } else if (msg.role === "assistant" && msg.content) {
        lines.push(`### RecallAI Explanation`, msg.content, ``, `---`, ``);
      }
    }

    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeTitle = active.title.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40) || "Study";
    a.href = url;
    a.download = `${safeTitle}_Revision_Notes.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <header className="conv-header">
      <button
        type="button"
        className="icon-btn menu-btn"
        data-quiet="true"
        onClick={() => toggleSidebar(true)}
        aria-label="Open conversations"
      >
        <Menu size={17} />
      </button>

      <h1>{active?.title ?? "New conversation"}</h1>

      <span className="status-pill">
        <span className="dot" data-tone={status.tone} />
        {status.label}
      </span>

      <button
        type="button"
        className="icon-btn"
        data-quiet="true"
        onClick={() => toggleContext(!state.contextOpen)}
        aria-label="Study context"
        aria-pressed={state.contextOpen}
        title="Study context"
      >
        <Brain size={17} />
      </button>

      {active && (
        <>
          <button
            type="button"
            className="icon-btn"
            data-quiet="true"
            aria-label="Export revision notes to Markdown"
            title="Export Revision Notes (.md)"
            onClick={exportNotes}
          >
            <Download size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            data-quiet="true"
            aria-label="Rename conversation"
            title="Rename"
            onClick={() => {
              const next = window.prompt("Rename conversation", active.title);
              if (next !== null) void renameConversation(active.id, next.trim());
            }}
          >
            <Pencil size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            data-quiet="true"
            aria-label="Delete conversation"
            title="Delete"
            onClick={() => {
              const ok = window.confirm(
                `Delete “${active.title}”? This cannot be undone.`,
              );
              if (ok) void deleteConversation(active.id);
            }}
          >
            <Trash2 size={16} />
          </button>
        </>
      )}
    </header>
  );
}