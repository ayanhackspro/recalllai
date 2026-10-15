-- ---------------------------------------------------------------------------
-- RecallAI schema
--
-- Applied by `npm run migrate -w @recallai/api`. Safe to re-run.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text        NOT NULL DEFAULT 'New conversation',
  preview     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS preview text;

CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid        NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role            text        NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         text        NOT NULL DEFAULT '',
  status          text        NOT NULL DEFAULT 'complete'
                  CHECK (status IN ('sending', 'streaming', 'complete', 'error', 'interrupted')),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx
  ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations (id) ON DELETE CASCADE,
  message_id      uuid REFERENCES messages (id)     ON DELETE CASCADE,
  name            text        NOT NULL,
  mime_type       text        NOT NULL,
  size            bigint      NOT NULL DEFAULT 0,
  kind            text        NOT NULL CHECK (kind IN ('document', 'image')),
  status          text        NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'uploading', 'processing', 'ready', 'failed')),
  storage_path    text,
  extracted_text  text,
  extracted_chars integer,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attachments_conversation_idx
  ON attachments (conversation_id);

-- Learning signals. `keywords` drives retrieval; `source` keeps demo and
-- AI-suggested items distinguishable from things the user actually did.
CREATE TABLE IF NOT EXISTS memories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations (id) ON DELETE CASCADE,
  message_id      uuid REFERENCES messages (id)     ON DELETE SET NULL,
  type            text        NOT NULL
                  CHECK (type IN ('goal', 'topic', 'mistake', 'preference', 'study_session')),
  label           text        NOT NULL,
  summary         text        NOT NULL,
  source          text        NOT NULL DEFAULT 'learned'
                  CHECK (source IN ('learned', 'suggested', 'demo')),
  keywords        text[]      NOT NULL DEFAULT '{}',
  mastery_score   integer     NOT NULL DEFAULT 50,
  repetition_count integer    NOT NULL DEFAULT 0,
  next_review_at  timestamptz NOT NULL DEFAULT now(),
  interval_days   integer     NOT NULL DEFAULT 1,
  ease_factor     double precision NOT NULL DEFAULT 2.5,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE memories ADD COLUMN IF NOT EXISTS mastery_score integer NOT NULL DEFAULT 50;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS repetition_count integer NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS next_review_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE memories ADD COLUMN IF NOT EXISTS interval_days integer NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS ease_factor double precision NOT NULL DEFAULT 2.5;

CREATE INDEX IF NOT EXISTS memories_conversation_idx
  ON memories (conversation_id);
CREATE INDEX IF NOT EXISTS memories_keywords_idx
  ON memories USING gin (keywords);
CREATE INDEX IF NOT EXISTS memories_next_review_idx
  ON memories (next_review_at);

-- Which memories actually informed which answer.
CREATE TABLE IF NOT EXISTS message_memories (
  message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  memory_id  uuid NOT NULL REFERENCES memories (id)  ON DELETE CASCADE,
  PRIMARY KEY (message_id, memory_id)
);

-- Which memories actually informed which answer, and why in plain language.
CREATE TABLE IF NOT EXISTS message_context_notes (
  message_id uuid PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
  note       text NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  message_id uuid PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
  value      text        NOT NULL CHECK (value IN ('helpful', 'not_helpful')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Keep conversations.updated_at honest without trusting the client clock.
CREATE OR REPLACE FUNCTION touch_conversation() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_touch_conversation ON messages;
CREATE TRIGGER messages_touch_conversation
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION touch_conversation();