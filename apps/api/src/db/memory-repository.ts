import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
 * In-memory implementation used when DATABASE_URL is empty.
 * Persists to a local JSON file (apps/api/data/store.json) so conversations,
 * messages and local records survive restarts even without PostgreSQL.
 */

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, "../../data");
const storeFile = resolve(dataDir, "store.json");

interface StoredAttachment extends Attachment {
  conversationId?: string;
  messageId?: string;
  storagePath?: string;
  extractedText?: string;
}

interface StoredMemory extends StudyMemory {
  conversationId?: string;
  messageId?: string;
  keywords: string[];
}

const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

export class MemoryRepository implements Repository {
  readonly kind = "memory" as const;

  private conversations = new Map<string, Conversation>();
  private messages = new Map<string, StoredMessage[]>();
  private attachments = new Map<string, StoredAttachment>();
  private memories = new Map<string, StoredMemory>();
  private links = new Map<string, string[]>();
  private notes = new Map<string, string>();
  private feedback = new Map<string, MessageFeedback>();

  async init(): Promise<void> {
    try {
      if (existsSync(storeFile)) {
        const raw = readFileSync(storeFile, "utf8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.conversations)) {
          for (const c of data.conversations) this.conversations.set(c.id, c);
        }
        if (data.messages && typeof data.messages === "object") {
          for (const [k, v] of Object.entries(data.messages)) {
            if (Array.isArray(v)) this.messages.set(k, v as StoredMessage[]);
          }
        }
        if (Array.isArray(data.attachments)) {
          for (const a of data.attachments) this.attachments.set(a.id, a);
        }
        if (Array.isArray(data.memories)) {
          for (const m of data.memories) this.memories.set(m.id, m);
        }
        if (data.notes && typeof data.notes === "object") {
          for (const [k, v] of Object.entries(data.notes)) {
            if (typeof v === "string") this.notes.set(k, v);
          }
        }
      }
    } catch (err) {
      console.warn("[memory-repo] Error loading store.json:", err);
    }
  }

  private save(): void {
    try {
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
      }
      const data = {
        conversations: [...this.conversations.values()],
        messages: Object.fromEntries(this.messages.entries()),
        attachments: [...this.attachments.values()],
        memories: [...this.memories.values()],
        notes: Object.fromEntries(this.notes.entries()),
      };
      writeFileSync(storeFile, JSON.stringify(data, null, 2), "utf8");
    } catch {
      // non-fatal in-memory fallback
    }
  }

  async close(): Promise<void> {
    this.save();
    this.conversations.clear();
    this.messages.clear();
    this.attachments.clear();
    this.memories.clear();
    this.links.clear();
    this.notes.clear();
  }

  /* ---------------------------- conversations --------------------------- */

  async listConversations(): Promise<Conversation[]> {
    return [...this.conversations.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 200);
  }

  async createConversation(title = "New conversation"): Promise<Conversation> {
    const conv: Conversation = { id: uuid(), title, updatedAt: nowIso() };
    this.conversations.set(conv.id, conv);
    this.messages.set(conv.id, []);
    this.save();
    return conv;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null;
  }

  async renameConversation(id: string, title: string): Promise<Conversation | null> {
    const conv = this.conversations.get(id);
    if (!conv) return null;
    conv.title = title;
    conv.updatedAt = nowIso();
    this.save();
    return conv;
  }

  async setConversationPreview(id: string, preview: string): Promise<void> {
    const conv = this.conversations.get(id);
    if (conv) {
      conv.preview = preview;
      conv.updatedAt = nowIso();
      this.save();
    }
  }

  async deleteConversation(id: string): Promise<boolean> {
    this.conversations.delete(id);
    this.messages.delete(id);
    for (const [attId, att] of this.attachments) {
      if (att.conversationId === id) this.attachments.delete(attId);
    }
    this.save();
    return true;
  }

  private touch(conversationId: string) {
    const conv = this.conversations.get(conversationId);
    if (conv) conv.updatedAt = nowIso();
  }

  /* ------------------------------ messages ----------------------------- */

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    const list = this.messages.get(conversationId) ?? [];
    return list.map(({ conversationId: _c, ...m }) => ({
      ...m,
      attachments: m.attachments?.length ? m.attachments : undefined,
      studyContext: this.links.get(m.id)?.length
        ? (this.links
            .get(m.id)!
            .map((id) => this.memories.get(id))
            .filter((x): x is StoredMemory => Boolean(x)) as StudyMemory[])
        : undefined,
      contextNote: this.notes.get(m.id),
    }));
  }

  async addMessage(message: StoredMessage): Promise<StoredMessage> {
    const list = this.messages.get(message.conversationId) ?? [];
    const saved: StoredMessage = {
      ...message,
      id: message.id || uuid(),
      createdAt: message.createdAt || nowIso(),
      status: message.status ?? "complete",
    };
    list.push(saved);
    this.messages.set(message.conversationId, list);
    this.touch(message.conversationId);

    for (const a of saved.attachments ?? []) {
      const stored = this.attachments.get(a.id ?? "");
      if (stored) {
        stored.messageId = saved.id;
        stored.conversationId = message.conversationId;
      }
    }

    if (saved.studyContext?.length) {
      this.links.set(
        saved.id,
        saved.studyContext.map((m) => m.id),
      );
    }

    return saved;
  }

  async updateMessage(
    id: string,
    value: Partial<Pick<ChatMessage, "content" | "status">> & { error?: string | null },
  ): Promise<void> {
    for (const list of this.messages.values()) {
      const i = list.findIndex((m) => m.id === id);
      if (i !== -1) {
        const current = list[i]!;
        list[i] = {
          ...current,
          ...value,
          // `null` clears; `undefined` leaves the existing value alone.
          error: value.error === null ? undefined : (value.error ?? current.error),
        };
        this.touch(current.conversationId);
        return;
      }
    }
  }

  /* ----------------------------- attachments --------------------------- */

  async createAttachment(
    value: NewAttachment,
  ): Promise<Attachment> {
    const record: StoredAttachment = {
      id: uuid(),
      name: value.name,
      mimeType: value.mimeType,
      size: value.size,
      kind: value.kind,
      status: value.status,
      error: value.error,
      local: false,
      conversationId: value.conversationId,
      storagePath: value.storagePath,
    };
    this.attachments.set(record.id!, record);
    return record;
  }

  async updateAttachment(
    id: string,
    value: AttachmentPatch,
  ): Promise<void> {
    const rec = this.attachments.get(id);
    if (!rec) return;
    if (value.status) rec.status = value.status;
    if (value.error !== undefined) rec.error = value.error ?? undefined;
    if (value.extractedText !== undefined) rec.extractedText = value.extractedText;
    if (value.messageId) rec.messageId = value.messageId;
  }

  async getAttachment(id: string) {
    const rec = this.attachments.get(id);
    if (!rec) return null;
    return { ...rec };
  }

  async deleteAttachment(id: string): Promise<boolean> {
    return this.attachments.delete(id);
  }

  async listAttachments(conversationId: string): Promise<Attachment[]> {
    return [...this.attachments.values()]
      .filter((a) => a.conversationId === conversationId)
      .map(({ conversationId: _c, messageId: _m, storagePath: _s, extractedText: _e, ...a }) => a);
  }

  /* ------------------------------- memories ---------------------------- */

  async listMemories(conversationId?: string): Promise<StudyMemory[]> {
    return [...this.memories.values()]
      .filter((m) => !conversationId || m.conversationId === conversationId)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  async upsertMemory(
    value: NewMemory,
  ): Promise<StudyMemory> {
    const existing = [...this.memories.values()].find((m) =>
      value.type === "study_session" && value.conversationId
        ? m.type === "study_session" && m.conversationId === value.conversationId
        : m.type === value.type && m.summary === value.summary,
    );
    if (existing) {
      existing.label = value.label;
      existing.summary = value.summary;
      existing.keywords = [...new Set([...existing.keywords, ...value.keywords])];
      existing.updatedAt = nowIso();
      existing.conversationId = value.conversationId ?? existing.conversationId;
      return existing;
    }

    const record: StoredMemory = {
      id: uuid(),
      type: value.type,
      label: value.label,
      summary: value.summary,
      source: value.source ?? "learned",
      updatedAt: nowIso(),
      conversationId: value.conversationId,
      messageId: value.messageId,
      keywords: value.keywords,
    };
    this.memories.set(record.id, record);
    return record;
  }

  async deleteMemory(id: string): Promise<boolean> {
    for (const [messageId, memIds] of this.links) {
      this.links.set(
        messageId,
        memIds.filter((m) => m !== id),
      );
    }
    return this.memories.delete(id);
  }

  async findMemoriesByKeywords(keywords: string[], limit: number): Promise<StudyMemory[]> {
    if (keywords.length === 0) return [];
    const set = new Set(keywords);
    return [...this.memories.values()]
      .filter((m) => m.keywords.some((k) => set.has(k)))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, limit);
  }

  async linkMemoriesToMessage(messageId: string, memoryIds: string[]): Promise<void> {
    const current = this.links.get(messageId) ?? [];
    this.links.set(messageId, [...new Set([...current, ...memoryIds])]);
  }

  async memoriesForMessage(messageId: string): Promise<StudyMemory[]> {
    return (this.links.get(messageId) ?? [])
      .map((id) => this.memories.get(id))
      .filter((m): m is StoredMemory => Boolean(m));
  }

  async contextNoteForMessage(messageId: string): Promise<string | undefined> {
    return this.notes.get(messageId);
  }

  async setContextNote(messageId: string, note: string): Promise<void> {
    this.notes.set(messageId, note);
  }

  /* ------------------------------- feedback ---------------------------- */

  async setFeedback(messageId: string, value: MessageFeedback): Promise<void> {
    this.feedback.set(messageId, value);
  }
}