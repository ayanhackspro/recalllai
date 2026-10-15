import { Pool, type PoolClient } from "pg";
import type {
  Attachment,
  ChatMessage,
  Conversation,
  MessageFeedback,
  StudyMemory,
} from "@recallai/shared-types";
import type { AttachmentPatch, NewAttachment, NewMemory, StoredMessage } from "../types.js";
import type { Repository } from "./repository.js";

/**
 * Postgres implementation. Works against Neon over the pooled connection
 * string, or a local Postgres.
 */
export class PgRepository implements Repository {
  readonly kind = "postgres" as const;
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      // Neon pooled endpoints recycle connections; keep the idle window short
      // so we never hold a dead socket.
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      max: 10,
      ssl: connectionString.includes("sslmode=disable") ? false : { rejectUnauthorized: false },
    });
  }

  /**
   * Identifies transient socket disconnects and serverless cold-start resets
   * typical of Neon compute auto-suspension.
   */
  private isTransientError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { code?: string; message?: string };
    const transientCodes = [
      "ECONNRESET",
      "ETIMEDOUT",
      "EPIPE",
      "57P01", // admin shutdown
      "08006", // connection failure
      "08001", // unable to establish connection
      "08004", // rejected connection
      "08007", // transaction unknown
    ];
    if (e.code && transientCodes.includes(e.code)) return true;
    if (typeof e.message === "string") {
      const msg = e.message.toLowerCase();
      return (
        msg.includes("connection terminated") ||
        msg.includes("connection closed") ||
        msg.includes("socket closed") ||
        msg.includes("timeout") ||
        msg.includes("econnreset")
      );
    }
    return false;
  }

  /**
   * Resilient query execution with exponential backoff and jitter for Neon serverless cold starts.
   */
  async queryWithRetry<R extends import("pg").QueryResultRow = any>(
    text: string,
    params?: unknown[],
    retries = 3,
    delayMs = 250,
  ): Promise<import("pg").QueryResult<R>> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await this.pool.query<R>(text, params);
      } catch (err) {
        lastError = err;
        if (attempt < retries && this.isTransientError(err)) {
          const backoff = delayMs * Math.pow(2, attempt - 1) + Math.random() * 50;
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  async init(): Promise<void> {
    await this.queryWithRetry("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /* ------------------------------------------------------------------ */
  /* Conversations                                                       */
  /* ------------------------------------------------------------------ */

  async listConversations(): Promise<Conversation[]> {
    const { rows } = await this.queryWithRetry<Conversation>(
      `SELECT id, title, preview, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM conversations
        ORDER BY updated_at DESC
        LIMIT 200`,
    );
    return rows;
  }

  async createConversation(title = "New conversation"): Promise<Conversation> {
    const { rows } = await this.queryWithRetry<Conversation>(
      `INSERT INTO conversations (title)
            VALUES ($1)
         RETURNING id, title, preview, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [title],
    );
    return rows[0]!;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const { rows } = await this.queryWithRetry<Conversation>(
      `SELECT id, title, preview, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM conversations WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async renameConversation(id: string, title: string): Promise<Conversation | null> {
    const { rows } = await this.queryWithRetry<Conversation>(
      `UPDATE conversations
          SET title = $2, updated_at = now()
        WHERE id = $1
      RETURNING id, title, preview, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [id, title],
    );
    return rows[0] ?? null;
  }

  async setConversationPreview(id: string, preview: string): Promise<void> {
    await this.queryWithRetry(
      `UPDATE conversations
          SET preview = $2, updated_at = now()
        WHERE id = $1`,
      [id, preview],
    );
  }

  async deleteConversation(id: string): Promise<boolean> {
    const res = await this.queryWithRetry(`DELETE FROM conversations WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  /* ------------------------------------------------------------------ */
  /* Messages                                                            */
  /* ------------------------------------------------------------------ */

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    const { rows } = await this.queryWithRetry<ChatMessageRow>(
      `SELECT id, role, content, status, error, created_at AS "createdAt"
         FROM messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC, id ASC`,
      [conversationId],
    );

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const [atts, mems] = await Promise.all([
      this.listAttachmentsByMessageIds(ids),
      this.memoriesForMessages(ids),
    ]);

    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      status: r.status,
      error: r.error ?? undefined,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      attachments: atts.get(r.id),
      studyContext: mems.get(r.id),
      contextNote: undefined,
    }));
  }

  async addMessage(message: StoredMessage): Promise<StoredMessage> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<ChatMessageRow>(
        `INSERT INTO messages (id, conversation_id, role, content, status, error)
              VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, role, content, status, error, created_at AS "createdAt"`,
        [
          message.id,
          message.conversationId,
          message.role,
          message.content,
          message.status ?? "complete",
          message.error ?? null,
        ],
      );
      const saved = rows[0]!;

      for (const a of message.attachments ?? []) {
        if (!a.id) continue;
        await client.query(
          `UPDATE attachments
              SET message_id = $2, conversation_id = $3
            WHERE id = $1`,
          [a.id, message.id, message.conversationId],
        );
      }

      if (message.studyContext?.length) {
        for (const mem of message.studyContext) {
          await client.query(
            `INSERT INTO message_memories (message_id, memory_id)
                  VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [message.id, mem.id],
          );
        }
      }

      await client.query("COMMIT");
      return {
        ...message,
        id: saved.id,
        status: saved.status,
        createdAt:
          saved.createdAt instanceof Date ? saved.createdAt.toISOString() : String(saved.createdAt),
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async updateMessage(
    id: string,
    value: Partial<Pick<ChatMessage, "content" | "status">> & { error?: string | null },
  ): Promise<void> {
    await this.queryWithRetry(
      `UPDATE messages
          SET content = COALESCE($2, content),
              status  = COALESCE($3, status),
              error   = $4
        WHERE id = $1`,
      [id, value.content ?? null, value.status ?? null, value.error ?? null],
    );
  }

  /* ------------------------------------------------------------------ */
  /* Attachments                                                         */
  /* ------------------------------------------------------------------ */

  async createAttachment(
    value: NewAttachment,
  ): Promise<Attachment> {
    const { rows } = await this.queryWithRetry<AttachmentRow>(
      `INSERT INTO attachments
         (conversation_id, name, mime_type, size, kind, status, storage_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        value.conversationId ?? null,
        value.name,
        value.mimeType,
        value.size,
        value.kind,
        value.status,
        value.storagePath ?? null,
      ],
    );
    return toAttachment(rows[0]!);
  }

  async updateAttachment(
    id: string,
    value: AttachmentPatch,
  ): Promise<void> {
    await this.queryWithRetry(
      `UPDATE attachments
          SET status          = COALESCE($2, status),
              error           = $3,
              extracted_text  = COALESCE($4, extracted_text),
              extracted_chars = COALESCE($5, extracted_chars),
              message_id      = COALESCE($6, message_id)
        WHERE id = $1`,
      [
        id,
        value.status ?? null,
        value.error ?? null,
        value.extractedText ?? null,
        value.extractedChars ?? null,
        value.messageId ?? null,
      ],
    );
  }

  async getAttachment(id: string) {
    const { rows } = await this.queryWithRetry<AttachmentRow & { storage_path: string | null; extracted_text: string | null }>(
      `SELECT * FROM attachments WHERE id = $1`,
      [id],
    );
    if (!rows[0]) return null;
    return {
      ...toAttachment(rows[0]),
      storagePath: rows[0].storage_path ?? undefined,
      extractedText: rows[0].extracted_text ?? undefined,
    };
  }

  async deleteAttachment(id: string): Promise<boolean> {
    const res = await this.queryWithRetry(`DELETE FROM attachments WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async listAttachments(conversationId: string): Promise<Attachment[]> {
    const { rows } = await this.queryWithRetry<AttachmentRow>(
      `SELECT * FROM attachments WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversationId],
    );
    return rows.map(toAttachment);
  }

  private async listAttachmentsByMessageIds(ids: string[]) {
    const { rows } = await this.queryWithRetry<AttachmentRow>(
      `SELECT * FROM attachments WHERE message_id = ANY($1::uuid[]) ORDER BY created_at ASC`,
      [ids],
    );
    const map = new Map<string, Attachment[]>();
    for (const row of rows) {
      const a = toAttachment(row);
      const list = map.get(row.message_id ?? "") ?? [];
      list.push(a);
      map.set(row.message_id ?? "", list);
    }
    return map;
  }

  /* ------------------------------------------------------------------ */
  /* Memories                                                            */
  /* ------------------------------------------------------------------ */

  async getMemory(id: string): Promise<StudyMemory | null> {
    const { rows } = await this.queryWithRetry<MemoryRow>(
      `SELECT * FROM memories WHERE id = $1`,
      [id],
    );
    return rows[0] ? toMemory(rows[0]) : null;
  }

  async listDueMemories(limit = 20): Promise<StudyMemory[]> {
    const { rows } = await this.queryWithRetry<MemoryRow>(
      `SELECT * FROM memories
        WHERE next_review_at IS NULL OR next_review_at <= now()
        ORDER BY next_review_at ASC NULLS FIRST, mastery_score ASC, updated_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map(toMemory);
  }

  async reviewMemory(id: string, rating: 1 | 2 | 3 | 4 | 5): Promise<StudyMemory | null> {
    const { rows: existingRows } = await this.queryWithRetry<MemoryRow>(
      `SELECT * FROM memories WHERE id = $1`,
      [id],
    );
    const existing = existingRows[0];
    if (!existing) return null;

    const repCount = existing.repetition_count != null ? Number(existing.repetition_count) : 0;
    const intervalDays = existing.interval_days != null ? Number(existing.interval_days) : 0;
    const easeFactor = existing.ease_factor != null ? Number(existing.ease_factor) : 2.5;
    const masteryScore = existing.mastery_score != null ? Number(existing.mastery_score) : 0;

    // SuperMemo-2 (SM-2) algorithm
    const newEaseFactor = Math.max(
      1.3,
      Number((easeFactor + (0.1 - (5 - rating) * (0.08 + (5 - rating) * 0.02))).toFixed(3)),
    );

    let newRepCount = repCount;
    let newIntervalDays = intervalDays;
    let newMasteryScore = masteryScore;

    if (rating < 3) {
      // Failed recall: reset repetitions and schedule review tomorrow
      newRepCount = 0;
      newIntervalDays = 1;
      newMasteryScore = Math.max(0, Math.round(masteryScore * 0.7 - (3 - rating) * 10));
    } else {
      // Successful recall: advance repetitions and scale interval
      if (repCount === 0) {
        newIntervalDays = 1;
      } else if (repCount === 1) {
        newIntervalDays = 3;
      } else {
        newIntervalDays = Math.max(1, Math.round(intervalDays * newEaseFactor));
      }
      newRepCount = repCount + 1;

      const masteryBonus = rating === 5 ? 25 : rating === 4 ? 15 : 8;
      newMasteryScore = Math.min(100, masteryScore + masteryBonus);
    }

    const nextReview = new Date(Date.now() + newIntervalDays * 86_400_000);

    const { rows: updatedRows } = await this.queryWithRetry<MemoryRow>(
      `UPDATE memories
          SET repetition_count = $2,
              interval_days    = $3,
              ease_factor      = $4,
              mastery_score    = $5,
              next_review_at   = $6,
              updated_at       = now()
        WHERE id = $1
      RETURNING *`,
      [id, newRepCount, newIntervalDays, newEaseFactor, newMasteryScore, nextReview.toISOString()],
    );

    return updatedRows[0] ? toMemory(updatedRows[0]) : null;
  }

  async listMemories(conversationId?: string): Promise<StudyMemory[]> {
    const { rows } = await this.queryWithRetry<MemoryRow>(
      conversationId
        ? `SELECT * FROM memories WHERE conversation_id = $1 ORDER BY updated_at DESC`
        : `SELECT * FROM memories ORDER BY updated_at DESC`,
      conversationId ? [conversationId] : [],
    );
    return rows.map(toMemory);
  }

  async upsertMemory(
    value: NewMemory,
  ): Promise<StudyMemory> {
    let existingQuery = `SELECT * FROM memories WHERE type = $1 AND summary = $2 LIMIT 1`;
    let existingParams: unknown[] = [value.type, value.summary];

    if (value.type === "study_session" && value.conversationId) {
      existingQuery = `SELECT * FROM memories WHERE type = 'study_session' AND conversation_id = $1 LIMIT 1`;
      existingParams = [value.conversationId];
    }

    const { rows: existing } = await this.queryWithRetry<MemoryRow>(existingQuery, existingParams);
    if (existing[0]) {
      const { rows } = await this.queryWithRetry<MemoryRow>(
        `UPDATE memories
            SET label = $2,
                summary = $3,
                keywords = $4::text[],
                updated_at = now(),
                conversation_id = COALESCE($5, conversation_id)
          WHERE id = $1
        RETURNING *`,
        [existing[0].id, value.label, value.summary, value.keywords, value.conversationId ?? null],
      );
      return toMemory(rows[0]!);
    }

    const { rows } = await this.queryWithRetry<MemoryRow>(
      `INSERT INTO memories (conversation_id, message_id, type, label, summary, source, keywords, mastery_score, repetition_count, interval_days, ease_factor)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0, 2.5)
         RETURNING *`,
      [
        value.conversationId ?? null,
        value.messageId ?? null,
        value.type,
        value.label,
        value.summary,
        value.source ?? "learned",
        value.keywords,
      ],
    );
    return toMemory(rows[0]!);
  }

  async deleteMemory(id: string): Promise<boolean> {
    const res = await this.queryWithRetry(`DELETE FROM memories WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async findMemoriesByKeywords(keywords: string[], limit: number): Promise<StudyMemory[]> {
    if (keywords.length === 0) return [];
    const { rows } = await this.queryWithRetry<MemoryRow>(
      `SELECT * FROM memories
        WHERE keywords && $1::text[]
        ORDER BY updated_at DESC
        LIMIT $2`,
      [keywords, limit],
    );
    return rows.map(toMemory);
  }

  async linkMemoriesToMessage(messageId: string, memoryIds: string[]): Promise<void> {
    if (memoryIds.length === 0) return;
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const id of memoryIds) {
        await client.query(
          `INSERT INTO message_memories (message_id, memory_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
          [messageId, id],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async memoriesForMessage(messageId: string): Promise<StudyMemory[]> {
    const { rows } = await this.queryWithRetry<MemoryRow>(
      `SELECT m.* FROM memories m
         JOIN message_memories mm ON mm.memory_id = m.id
        WHERE mm.message_id = $1`,
      [messageId],
    );
    return rows.map(toMemory);
  }

  async memoriesForMessages(ids: string[]) {
    const { rows } = await this.queryWithRetry<MemoryRow>(
      `SELECT m.*, mm.message_id AS linked_message
         FROM memories m
         JOIN message_memories mm ON mm.memory_id = m.id
        WHERE mm.message_id = ANY($1::uuid[])`,
      [ids],
    );
    const map = new Map<string, StudyMemory[]>();
    for (const row of rows) {
      const key = row.linked_message ?? "";
      const list = map.get(key) ?? [];
      list.push(toMemory(row));
      map.set(key, list);
    }
    return map;
  }

  /** The plain-language reason, stored alongside the answer. */
  async contextNoteForMessage(messageId: string): Promise<string | undefined> {
    const { rows } = await this.queryWithRetry<{ note: string | null }>(
      `SELECT note FROM message_context_notes WHERE message_id = $1`,
      [messageId],
    );
    return rows[0]?.note ?? undefined;
  }

  async setContextNote(messageId: string, note: string): Promise<void> {
    await this.queryWithRetry(
      `INSERT INTO message_context_notes (message_id, note)
            VALUES ($1, $2)
         ON CONFLICT (message_id) DO UPDATE SET note = EXCLUDED.note`,
      [messageId, note],
    );
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  async setFeedback(messageId: string, value: MessageFeedback): Promise<void> {
    await this.queryWithRetry(
      `INSERT INTO feedback (message_id, value) VALUES ($1, $2)
         ON CONFLICT (message_id) DO UPDATE SET value = EXCLUDED.value, created_at = now()`,
      [messageId, value],
    );
  }
}

/* ------------------------------------------------------------------ */
/* Row shapes and mappers                                              */
/* ------------------------------------------------------------------ */

interface ChatMessageRow {
  id: string;
  role: ChatMessage["role"];
  content: string;
  status: ChatMessage["status"];
  error: string | null;
  createdAt: Date | string;
}

interface AttachmentRow {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  name: string;
  mime_type: string;
  size: string | number;
  kind: Attachment["kind"];
  status: Attachment["status"];
  error: string | null;
}

interface MemoryRow {
  id: string;
  type: StudyMemory["type"];
  label: string;
  summary: string;
  source: StudyMemory["source"];
  mastery_score?: number | null;
  repetition_count?: number | null;
  next_review_at?: Date | string | null;
  interval_days?: number | null;
  ease_factor?: number | null;
  updated_at: Date | string;
  linked_message?: string;
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    size: Number(row.size),
    kind: row.kind,
    status: row.status,
    error: row.error ?? undefined,
    local: false,
  };
}

function toMemory(row: MemoryRow): StudyMemory {
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    summary: row.summary,
    source: row.source,
    masteryScore: row.mastery_score != null ? Number(row.mastery_score) : 0,
    repetitionCount: row.repetition_count != null ? Number(row.repetition_count) : 0,
    nextReviewAt: row.next_review_at
      ? row.next_review_at instanceof Date
        ? row.next_review_at.toISOString()
        : String(row.next_review_at)
      : undefined,
    intervalDays: row.interval_days != null ? Number(row.interval_days) : 0,
    easeFactor: row.ease_factor != null ? Number(row.ease_factor) : 2.5,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}