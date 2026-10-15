import { Router } from "express";
import { z } from "zod";
import type { Attachment, ChatMessage, SendMessageRequest, SendMessageResponse, StudyMemory } from "@recallai/shared-types";
import type { StoredMessage } from "../types.js";
import type { Repository } from "../db/repository.js";
import type { AnswerProvider } from "../services/answer.js";
import { maybeRecordMemory, retrieveMemories } from "../services/memory.js";
import { asyncRoute, HttpError, param } from "./helpers.js";

const sendSchema = z.object({
  content: z.string().max(20_000).default(""),
  attachmentIds: z.array(z.string()).max(12).default([]),
  responseMode: z.enum(["study", "deep-dive", "quiz"]).default("study"),
});

export function messagesRouter(repo: Repository, provider: AnswerProvider): Router {
  const r = Router();

  /** Shared turn logic. Returns the persisted user message. */
  async function beginTurn(conversationId: string, body: SendMessageRequest) {
    const conv = await repo.getConversation(conversationId);
    if (!conv) throw new HttpError(404, "not_found", "Conversation not found.");

    const attachments = (
      await Promise.all(body.attachmentIds.map((id) => repo.getAttachment(id)))
    ).filter((a): a is NonNullable<typeof a> => Boolean(a));

    // Only attachments the server actually finished reading are usable.
    const readyAttachments = await Promise.all(
      attachments.map(async (a) => {
        if (a.status !== "ready" || !a.extractedText) return null;
        return { attachment: a as never, text: a.extractedText };
      }),
    );

    const userMessage: StoredMessage = {
      id: crypto.randomUUID(),
      conversationId,
      role: "user",
      content: body.content,
      createdAt: new Date().toISOString(),
      status: "complete",
      attachments: attachments.length ? (attachments as never) : undefined,
    };
    await repo.addMessage(userMessage);

    // Record a durable signal from the user's own words, if there is one.
    await maybeRecordMemory(repo, {
      conversationId,
      messageId: userMessage.id,
      text: body.content,
    });

    // Derive a title from the first real question.
    const textSnippet = body.content.trim().slice(0, 80);
    if (textSnippet) {
      await repo.setConversationPreview(conversationId, textSnippet);
    }
    if (conv.title === "New conversation") {
      const t = body.content.trim();
      if (t) {
        await repo.renameConversation(
          conversationId,
          t.slice(0, 46) + (t.length > 46 ? "…" : ""),
        );
      }
    }

    const { items, note } = await retrieveMemories(repo, body.content);

    const isContinuityPrompt =
      /\b(?:where\s+(?:was\s+i|i\s+was|did\s+i\s+leave\s+off|did\s+we\s+stop|am\s+i|we\s+at)|what\s+(?:was\s+i\s+doing|were\s+we\s+(?:talking\s+about|discussing|working\s+on)|did\s+we\s+discuss|did\s+i\s+study\s+last|did\s+we\s+do)|catch\s+me\s+up|pick\s+up|continue\s+from\s+last|remind\s+me\s+what\s+(?:we|i))\b/i.test(
        body.content.trim(),
      );

    const allConvs = await repo.listConversations();
    const prevConv = allConvs.find(
      (c) => c.id !== conversationId && c.title !== "New conversation",
    );
    let previousSession: {
      conversationId: string;
      title: string;
      lastTopicOrQuestion: string;
      lastAssistantSummary?: string;
      updatedAt?: string;
    } | undefined;

    if (prevConv) {
      const prevMessages = await repo.listMessages(prevConv.id);
      const lastUserMsg = prevMessages.filter((m) => m.role === "user").pop();
      const lastAsstMsg = prevMessages
        .filter((m) => m.role === "assistant" && m.status === "complete")
        .pop();

      if (lastUserMsg || prevConv.preview) {
        previousSession = {
          conversationId: prevConv.id,
          title: prevConv.title,
          lastTopicOrQuestion: lastUserMsg?.content || prevConv.preview || prevConv.title,
          lastAssistantSummary: lastAsstMsg ? lastAsstMsg.content.slice(0, 300) : undefined,
          updatedAt: prevConv.updatedAt,
        };
      }
    }

    let finalNote = note;
    if (isContinuityPrompt && previousSession) {
      const exists = items.some(
        (m) =>
          m.type === "study_session" &&
          (m.summary.includes(previousSession!.title) ||
            m.summary.includes(previousSession!.lastTopicOrQuestion.slice(0, 20))),
      );
      if (!exists) {
        items.unshift({
          id: `prev-${previousSession.conversationId}`,
          type: "study_session",
          label: "Recent study session",
          summary: `In your previous session ("${previousSession.title}"), you were working on: ${previousSession.lastTopicOrQuestion.slice(0, 100)}`,
          source: "learned",
          updatedAt: previousSession.updatedAt,
        });
      }
      finalNote = `Picked up from where you left off in your previous session ("${previousSession.title}").`;
    }

    // In Quiz Mode, prioritize concepts due for spaced repetition review (Ebbinghaus forgetting curve)
    if (body.responseMode === "quiz") {
      const dueMemories = await repo.listDueMemories(3);
      if (dueMemories.length > 0) {
        for (const due of dueMemories) {
          if (!items.some((it) => it.id === due.id)) {
            items.unshift(due);
          }
        }
        finalNote = finalNote
          ? `${finalNote} Prioritized concepts due for spaced repetition review.`
          : `Prioritized concepts approaching the forgetting curve threshold for spaced repetition review.`;
      }
    }

    const allMessages = await repo.listMessages(conversationId);
    const history = allMessages
      .filter((m) => m.id !== userMessage.id && m.status === "complete")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    return {
      conv,
      userMessage,
      attachments,
      readyAttachments,
      memories: items,
      note: finalNote,
      history,
      previousSession,
    };
  }

  /* ------------------------------------------------------------------ */
  /* JSON fallback                                                       */
  /* ------------------------------------------------------------------ */

  r.post(
    "/:id/messages",
    asyncRoute(async (req, res) => {
      const body = sendSchema.parse(req.body) as SendMessageRequest;
      const turn = await beginTurn(param(req, "id"), body);

      const messageId = crypto.randomUUID();
      const assistant: StoredMessage = {
        id: messageId,
        conversationId: param(req, "id"),
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
        status: "streaming",
      };
      await repo.addMessage(assistant);

      let acc = "";
      try {
        for await (const piece of provider.stream(
          {
            content: body.content,
            responseMode: body.responseMode,
            attachments: turn.attachments as never,
            readyAttachments: turn.readyAttachments as never,
            memories: turn.memories,
            history: turn.history,
            previousSession: turn.previousSession,
          },
          new AbortController().signal,
        )) {
          acc += piece;
        }

        await repo.updateMessage(messageId, { content: acc, status: "complete" });
        await repo.linkMemoriesToMessage(messageId, turn.memories.map((m) => m.id));
        if (turn.note) await repo.setContextNote(messageId, turn.note);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "The answer could not be generated.";
        await repo.updateMessage(messageId, { status: "error", error: errMsg }).catch(() => {});
        throw err;
      }

      const response: SendMessageResponse = {
        conversationId: param(req, "id"),
        userMessage: turn.userMessage,
        assistantMessage: {
          ...assistant,
          content: acc,
          status: "complete",
          studyContext: turn.memories.length ? turn.memories : undefined,
          contextNote: turn.note,
        },
      };
      res.json(response);
    }),
  );

  /* ------------------------------------------------------------------ */
  /* SSE stream                                                          */
  /* ------------------------------------------------------------------ */

  r.post("/:id/messages/stream", async (req, res) => {
    // SSE needs no buffering and no compression.
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    const controller = new AbortController();
    // `res`, not `req`: a request emits "close" as soon as its body has been
    // read, which would abort the generation before it starts. The response
    // closing is what actually means "the client went away".
    res.on("close", () => controller.abort());

    const send = (event: unknown) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    let messageId: string | undefined;
    try {
      const body = sendSchema.parse(req.body) as SendMessageRequest;
      const turn = await beginTurn(param(req, "id"), body);

      messageId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      await repo.addMessage({
        id: messageId,
        conversationId: param(req, "id"),
        role: "assistant",
        content: "",
        createdAt,
        status: "streaming",
      });

      send({ type: "message_start", messageId, createdAt });

      // Context arrives before the text, matching the documented event order.
      if (turn.memories.length) {
        send({ type: "context", messageId, items: turn.memories, note: turn.note });
      }

      let acc = "";
      for await (const piece of provider.stream(
        {
          content: body.content,
          responseMode: body.responseMode,
          attachments: turn.attachments as never,
          readyAttachments: turn.readyAttachments as never,
          memories: turn.memories,
          history: turn.history,
          previousSession: turn.previousSession,
        },
        controller.signal,
      )) {
        acc += piece;
        send({ type: "delta", messageId, text: piece });
      }

      await repo.updateMessage(messageId, { content: acc, status: "complete" });
      await repo.linkMemoriesToMessage(messageId, turn.memories.map((m) => m.id));
      if (turn.note) await repo.setContextNote(messageId, turn.note);

      send({ type: "done", messageId });
    } catch (err) {
      if (controller.signal.aborted) {
        // Client went away mid-generation. Nothing to report.
        if (messageId) {
          await repo.updateMessage(messageId, { status: "complete" }).catch(() => {});
        }
      } else {
        const message =
          err instanceof Error ? err.message : "The answer could not be generated.";
        console.error("[api] stream error:", err);
        if (messageId) {
          await repo.updateMessage(messageId, { status: "error", error: message }).catch(() => {});
        }
        send({ type: "error", message });
      }
    } finally {
      res.end();
    }
  });

  return r;
}