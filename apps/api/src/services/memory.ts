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
  if (keywords.length > 0) {
    const items = await repo.findMemoriesByKeywords(keywords, limit);
    if (items.length > 0) {
      const notes: string[] = [];
      for (const pattern of SIGNAL_PATTERNS) {
        if (pattern.re.test(query)) notes.push(pattern.note);
      }
      if (notes.length === 0) {
        notes.push("Used notes from topics you have studied before.");
      }
      return { items, note: [...new Set(notes)].join(" ") };
    }
  }

  // 3. Fallback for broad/continuity queries (e.g. "Where should I pick up next?", "What are my goals?")
  const isBroadOrContinuity =
    query.trim().length === 0 ||
    /^(where|what|how|quiz|continue|start|revise|study|pick|review|remember|who|can you|help)\b/i.test(query.trim());

  if (isBroadOrContinuity) {
    const globalItems = await repo.listMemories();
    if (globalItems.length > 0) {
      const sorted = [...globalItems].sort((a, b) => {
        const weight = (t: string) =>
          t === "study_session" ? 1 : t === "topic" ? 2 : t === "goal" ? 3 : t === "mistake" ? 4 : 5;
        const diff = weight(a.type) - weight(b.type);
        if (diff !== 0) return diff;
        return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
      });
      return {
        items: sorted.slice(0, limit),
        note: "Anchored in your ongoing study goals and recent sessions.",
      };
    }
  }

  return { items: [] };
}

/**
 * Records a learning signal from the user's own message.
 * Captures recurring mistakes, study goals, difficulties, preferences, and personal facts.
 */
export async function maybeRecordMemory(
  repo: Repository,
  input: { conversationId: string; messageId: string; text: string },
  falkor: FalkorContextService = falkorContext,
): Promise<StudyMemory | null> {
  const { text } = input;

  // 1. Personal fact / preference / explicit remember request
  // "remember that my study code is X" / "my study code is X" / "remember that I prefer Y"
  const factMatch =
    text.match(/\b(?:remember\s+(?:that)?|keep\s+in\s+mind\s+(?:that)?|please\s+note\s+(?:that)?)\s+([^.,;!?\n]{3,120})/i) ||
    text.match(/\b(?:my\s+(?:study\s+code|code|student\s+id|name|major|subject|level))\s+is\s+([^.,;!?\n]{2,80})/i) ||
    text.match(/\b(?:i\s+prefer\s+([^.,;!?\n]{3,100}))/i);

  if (factMatch) {
    const raw = factMatch[1] ?? factMatch[0];
    const subject = raw.replace(/^\s*(?:that|me\s+to|to|my\s+(?:study\s+code|code|student\s+id|name)\s+is)\s+/i, "").trim();
    if (subject) {
      const memory = await repo.upsertMemory({
        type: "preference",
        label: "Saved study fact",
        summary: text.toLowerCase().includes("study code")
          ? `Your study code is ${subject}.`
          : `You noted: ${subject}.`,
        source: "learned",
        conversationId: input.conversationId,
        messageId: input.messageId,
        keywords: keywordsOf(subject + " " + text),
      });

      if (falkor.isConnected) {
        await falkor.upsertMemory(memory, {
          conversationId: input.conversationId,
          messageId: input.messageId,
          keywords: keywordsOf(subject + " " + text),
        });
      }

      return memory;
    }
  }

  // 2. Mistakes / Difficulties / Struggles
  // "I keep getting X wrong" / "I struggle with Y" / "I find Z difficult"
  const mistakeMatch =
    text.match(/\b(?:keep|always|repeatedly|constantly)\s+(?:getting|forgetting|mixing up|confusing|messing up|failing)\b([^.,;!?\n]{3,80})/i) ||
    text.match(/\b(?:struggle|struggling|trouble|difficulty|hard\s+time|confused|stuck)\s+(?:with|on|about|understanding)\b([^.,;!?\n]{3,80})/i) ||
    text.match(/\b(?:find|finding)\s+([^.,;!?\n]{3,60})\s+(?:difficult|confusing|hard|tricky)\b/i) ||
    text.match(/\b(?:i\s+can(?:'|no)?t\s+(?:understand|grasp|figure out))\s+([^.,;!?\n]{3,80})/i) ||
    text.match(/\b(?:i\s+make\s+mistakes?\s+(?:on|in|with))\s+([^.,;!?\n]{3,80})/i);

  if (mistakeMatch) {
    const raw = mistakeMatch[1] ?? mistakeMatch[0];
    const subject = raw.replace(/^\s*(?:this|that|it|them|my|the)\s+/i, "").trim();
    if (subject) {
      const memory = await repo.upsertMemory({
        type: "mistake",
        label: "Recurring mistake",
        summary: `You reported difficulty or getting this wrong: ${subject}.`,
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

  // 3. Study goals / Revision targets
  // "my exam is on X" / "I'm revising for Y" / "my goal is to learn Z"
  const goalMatch =
    text.match(/\b(?:my\s+goal\s+is|aiming\s+to|target\s+is|want\s+to\s+learn|want\s+to\s+master|planning\s+to\s+revise)\s+([^.,;!?\n]{3,80})/i) ||
    text.match(/\b(?:exam|test|midterm|final|deadline)\b[^.,;!?\n]{0,60}|\b(?:revising|studying|prepping|preparing)\s+(?:for\s+)?([^.,;!?\n]{3,60})/i) ||
    text.match(/\b(?:i(?:'m| am)\s+(?:preparing|studying|focusing|working)\s+(?:on|for))\s+([^.,;!?\n]{3,80})/i);

  if (goalMatch) {
    const raw = goalMatch[1] ?? goalMatch[0] ?? "";
    const subject = raw.replace(/\b(my|the|for|on)\b/gi, "").trim();
    if (subject) {
      const memory = await repo.upsertMemory({
        type: "goal",
        label: "Current study goal",
        summary: `You said you are studying or preparing for: ${subject}.`,
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

  // 4. Automatic Study Session & Topic tracking for regular queries
  // When a student asks questions or studies a concept, record/update the session topic
  const isMetaOrGreeting =
    /^(hi|hello|hey|where\s+(?:was|am|i)|what\s+(?:was|did|is\s+my|are\s+my)|ok|okay|thanks|thank\s+you|bye|clear|test)\b/i.test(
      text.trim(),
    );

  if (!isMetaOrGreeting && text.trim().length >= 8) {
    const extracted = falkor.extractTopics(text);
    let topicName = extracted.topics[0];
    const cleanKeywords = keywordsOf(text);

    if (!topicName && cleanKeywords.length > 0) {
      topicName = cleanKeywords
        .slice(0, 3)
        .map((k) => k.charAt(0).toUpperCase() + k.slice(1))
        .join(" ");
    }

    if (topicName) {
      const snippet = text.trim().slice(0, 85).replace(/\s+/g, " ");
      const memory = await repo.upsertMemory({
        type: "study_session",
        label: "Recent study session",
        summary: `Studied ${topicName}: "${snippet}${text.trim().length > 85 ? "…" : ""}"`,
        source: "learned",
        conversationId: input.conversationId,
        messageId: input.messageId,
        keywords: [...new Set([topicName.toLowerCase(), ...cleanKeywords])],
      });

      if (falkor.isConnected) {
        await falkor.upsertMemory(memory, {
          conversationId: input.conversationId,
          messageId: input.messageId,
          topics: [topicName],
          keywords: cleanKeywords,
        });
      }

      return memory;
    }
  }

  return null;
}