import { Router } from "express";
import { z } from "zod";
import type { StudyContext, StudyMemory } from "@recallai/shared-types";
import type { Repository } from "../db/repository.js";
import { asyncRoute, HttpError, param } from "./helpers.js";
import { falkorContext } from "../services/falkordb.js";

/**
 * Study context.
 *
 * Returns the memories relevant to the most recent answer in the conversation,
 * plus the plain-language reason. If no answer has context yet (e.g. in a new chat),
 * it returns the student's active durable study context so cross-chat continuity is preserved.
 */
export function contextRouter(repo: Repository): Router {
  const r = Router();

  r.get(
    "/:id/context",
    asyncRoute(async (req, res) => {
      const conv = await repo.getConversation(param(req, "id"));
      if (!conv) throw new HttpError(404, "not_found", "Conversation not found.");

      const messages = await repo.listMessages(conv.id);

      // Walk back to the latest answer that actually used memory.
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i]!;
        if (m.role === "assistant" && m.studyContext?.length) {
          const payload: StudyContext & { items: StudyContext["items"] } = {
            items: m.studyContext,
            note: m.contextNote,
            sourceMessageId: m.id,
            loading: false,
          };
          res.json(payload);
          return;
        }
      }

      // If no answer in this conversation has context yet (e.g. in a new chat),
      // surface active study context from FalkorDB or repository so new chats remember context.
      let globalMemories: StudyMemory[] = [];
      if (falkorContext.isConnected) {
        globalMemories = await falkorContext.listMemories();
      }
      if (!globalMemories.length) {
        globalMemories = await repo.listMemories();
      }

      // Check if there is a previous active conversation to inject as recent study session
      const allConvs = await repo.listConversations();
      const prevConv = allConvs.find(
        (c) => c.id !== conv.id && c.title !== "New conversation",
      );
      if (prevConv) {
        const prevMessages = await repo.listMessages(prevConv.id);
        const lastUser = prevMessages.filter((m) => m.role === "user").pop();
        const topicOrQuestion = lastUser?.content || prevConv.preview || prevConv.title;
        const exists = globalMemories.some(
          (m) =>
            m.type === "study_session" &&
            (m.summary.includes(prevConv.title) || m.summary.includes(topicOrQuestion.slice(0, 20))),
        );
        if (!exists) {
          globalMemories.unshift({
            id: `prev-${prevConv.id}`,
            type: "study_session",
            label: "Recent study session",
            summary: `In your previous session ("${prevConv.title}"), you were working on: ${topicOrQuestion.slice(0, 100)}`,
            source: "learned",
            updatedAt: prevConv.updatedAt,
          });
        }
      }

      // Sort with study_session and topic first
      globalMemories.sort((a, b) => {
        const weight = (t: string) =>
          t === "study_session" ? 1 : t === "topic" ? 2 : t === "goal" ? 3 : t === "mistake" ? 4 : 5;
        const diff = weight(a.type) - weight(b.type);
        if (diff !== 0) return diff;
        return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
      });

      if (globalMemories.length > 0) {
        res.json({
          items: globalMemories.slice(0, 4),
          note: prevConv
            ? `Picked up from your previous session on "${prevConv.title}".`
            : "Active study context remembered across your sessions.",
          loading: false,
        } satisfies StudyContext);
        return;
      }

      res.json({ items: [], loading: false } satisfies StudyContext);
    }),
  );

  /* Full memory list for the panel when no answer has context yet. */
  r.get(
    "/:id/memories",
    asyncRoute(async (req, res) => {
      const conv = await repo.getConversation(param(req, "id"));
      if (!conv) throw new HttpError(404, "not_found", "Conversation not found.");
      if (falkorContext.isConnected) {
        const mems = await falkorContext.listMemories(conv.id);
        if (mems.length > 0) {
          res.json(mems);
          return;
        }
      }
      res.json(await repo.listMemories(conv.id));
    }),
  );

  return r;
}

const reviewSchema = z.object({
  rating: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
  ]),
});

/**
 * Mounted at /api/memories, which is where the frontend looks. A memory is
 * addressable on its own, not only through a conversation.
 */
export function memoriesRouter(repo: Repository): Router {
  const r = Router();

  r.get(
    "/due",
    asyncRoute(async (req, res) => {
      const limit = req.query.limit ? Math.min(100, Math.max(1, Number(req.query.limit))) : 20;
      const due = await repo.listDueMemories(limit);
      res.json(due);
    }),
  );

  r.get(
    "/graph",
    asyncRoute(async (_req, res) => {
      const repoMemories = await repo.listMemories();
      const graphData = await falkorContext.getKnowledgeGraph(repoMemories);
      res.json(graphData);
    }),
  );

  r.get(
    "/",
    asyncRoute(async (_req, res) => {
      if (falkorContext.isConnected) {
        const falkorMems = await falkorContext.listMemories();
        if (falkorMems.length > 0) {
          res.json(falkorMems);
          return;
        }
      }
      res.json(await repo.listMemories());
    }),
  );

  r.get(
    "/:id",
    asyncRoute(async (req, res) => {
      const memoryId = param(req, "id");
      const mem = await repo.getMemory(memoryId);
      if (!mem) throw new HttpError(404, "not_found", "Memory not found.");
      res.json(mem);
    }),
  );

  r.post(
    "/:id/review",
    asyncRoute(async (req, res) => {
      const memoryId = param(req, "id");
      const body = reviewSchema.parse(req.body);
      const updated = await repo.reviewMemory(memoryId, body.rating);
      if (!updated) throw new HttpError(404, "not_found", "Memory not found.");

      if (falkorContext.isConnected) {
        await falkorContext.upsertMemory(updated);
      }

      res.json({
        memory: updated,
        rating: body.rating,
        nextReviewAt: updated.nextReviewAt,
        intervalDays: updated.intervalDays,
        masteryScore: updated.masteryScore,
      });
    }),
  );

  r.delete(
    "/:id",
    asyncRoute(async (req, res) => {
      const memoryId = param(req, "id");
      const ok = await repo.deleteMemory(memoryId);
      if (falkorContext.isConnected) {
        await falkorContext.deleteMemory(memoryId);
      }
      if (!ok) throw new HttpError(404, "not_found", "Memory not found.");
      res.status(204).end();
    }),
  );

  return r;
}

const feedbackSchema = z.object({
  feedback: z.enum(["helpful", "not_helpful"]),
});

export function feedbackRouter(repo: Repository): Router {
  const r = Router();

  r.post(
    "/:id/feedback",
    asyncRoute(async (req, res) => {
      const body = feedbackSchema.parse(req.body);
      await repo.setFeedback(param(req, "id"), body.feedback);
      res.status(204).end();
    }),
  );

  return r;
}