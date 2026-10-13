import type { StudyMemory } from "@recallai/shared-types";
import { keywordsOf, type Repository } from "../db/repository.js";
import { falkorContext, type FalkorContextService } from "./falkordb.js";

/**
 * Memory retrieval and recording.
 *
 * Backed by FalkorDB graph traversal when configured. Traverses concept
 * relationships (e.g. Inclined Plane -> Net Force -> Recurring Mistake) to
 * find deep semantic connections and explain them in plain language.
 *
 * If FalkorDB is not configured or offline, seamlessly falls back to keyword
 * overlap over the repository's `keywords text[]` column so the app remains
 * fully operational.
 *
 * What this module will never do is invent memory. It only returns items that
 * actually exist in the graph/store, and returns nothing rather than guessing.
 */

/** Stop words excluded before matching, kept small and shared with keywordsOf. */
const SIGNAL_PATTERNS: Array<{
  re: RegExp;
  type: StudyMemory["type"];
  label: string;
  note: string;
}> = [
  {
    re: /\b(exam|revision|revise|deadline|test|midterm|final|course)\b/i,
    type: "goal",
    label: "Current study goal",
    note: "Anchored in your recorded study goal.",
  },
  {
    re: /\b(net force|inclined|ramp|friction|momentum|torque)\b/i,
    type: "mistake",
    label: "Recurring mistake",
    note: "Used a recurring mistake you logged.",
  },
  {
    re: /\b(eigen|matrix|matrices|determinant|singular|svd|decomposition|linear algebra)\b/i,
    type: "topic",
    label: "Recently studied topic",
    note: "Built on the linear algebra you have been studying.",
  },
  {
    re: /\b(quantum|photon|interference|spectr|relativ)\b/i,
    type: "topic",
    label: "Recently studied topic",
    note: "Built on the quantum material you studied recently.",
  },
];

export async function retrieveMemories(
  repo: Repository,
  query: string,
  limit = 4,
  falkor: FalkorContextService = falkorContext,
): Promise<{ items: StudyMemory[]; note?: string }> {
  // 1. Primary: FalkorDB Graph traversal
  if (falkor.isConnected) {
    const graphResult = await falkor.retrieveContext(query, limit);
    if (graphResult.items.length > 0) {
      return { items: graphResult.items, note: graphResult.note };
    }
  }

  // 2. Secondary fallback: Repository keyword search
  const keywords = keywordsOf(query);
  if (keywords.length === 0) return { items: [] };

  const items = await repo.findMemoriesByKeywords(keywords, limit);
  if (items.length === 0) return { items: [] };

  // Explain the selection in plain language, never with node ids or Cypher.
  const notes: string[] = [];
  for (const pattern of SIGNAL_PATTERNS) {
    if (pattern.re.test(query)) notes.push(pattern.note);
  }
  if (notes.length === 0) {
    notes.push("Used notes from topics you have studied before.");
  }

  return { items, note: [...new Set(notes)].join(" ") };
}

/**
 * Records a learning signal from the user's own message. Called only when the
 * message contains something durable — a stated goal, an admitted recurring
 * error — so the store does not fill up with noise.
 */
export async function maybeRecordMemory(
  repo: Repository,
  input: { conversationId: string; messageId: string; text: string },
  falkor: FalkorContextService = falkorContext,
): Promise<StudyMemory | null> {
  const { text } = input;

  // "I keep getting X wrong" / "I always forget X" / "help me with X"
  const mistake = text.match(
    /\b(?:keep|always|repeatedly|constantly)\s+(?:getting|forgetting|mixing up|confusing)\b([^.,;!?]{3,80})/i,
  );
  if (mistake) {
    // Drop a leading demonstrative so "I keep getting this wrong" does not
    // store the useless subject "this wrong".
    const subject = mistake[1]!.replace(/^\s*(?:this|that|it|them)\s+/i, "").trim();
    if (subject) {
      const memory = await repo.upsertMemory({
        type: "mistake",
        label: "Recurring mistake",
        summary: `You reported repeatedly getting this wrong: ${subject}.`,
        source: "learned",
        conversationId: input.conversationId,
        messageId: input.messageId,
        keywords: keywordsOf(subject),
      });

      if (falkor.isConnected) {
        await falkor.upsertMemory(memory, {
          conversationId: input.conversationId,
          messageId: input.messageId,
          keywords: keywordsOf(subject),
        });
      }

      return memory;
    }
  }

  // "my exam is on X" / "I'm revising for X"
  const goal = text.match(
    /\b(?:exam|test|midterm|final|deadline)\b[^.,;!?]{0,60}|\b(?:revising|studying|prepping)\s+for\s+([^.,;!?]{3,60})/i,
  );
  if (goal) {
    const subject = (goal[1] ?? goal[0] ?? "").replace(/\b(my|the)\b/gi, "").trim();
    if (subject) {
      const memory = await repo.upsertMemory({
        type: "goal",
        label: "Current study goal",
        summary: `You said you are studying for ${subject}.`,
        source: "learned",
        conversationId: input.conversationId,
        messageId: input.messageId,
        keywords: keywordsOf(subject),
      });

      if (falkor.isConnected) {
        await falkor.upsertMemory(memory, {
          conversationId: input.conversationId,
          messageId: input.messageId,
          keywords: keywordsOf(subject),
        });
      }

      return memory;
    }
  }

  return null;
}