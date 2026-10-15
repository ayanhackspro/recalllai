import assert from "node:assert/strict";
import "../src/config.js";
import { MemoryRepository } from "../src/db/memory-repository.js";
import { LocalAnswerProvider } from "../src/services/answer.js";
import { messagesRouter } from "../src/routes/messages.js";
import express from "express";

async function run() {
  console.log("=== Testing Cross-Chat Continuity ('where i was') ===");

  const repo = new MemoryRepository();
  await repo.init();
  const provider = new LocalAnswerProvider();

  // Step 1: User chats in Conversation 1
  const conv1 = await repo.createConversation("New conversation");
  console.log("Created Conversation 1:", conv1.id);

  // User asks a physics question
  const turn1User = "Explain how electromagnetic induction and Faraday's law work";
  const userMsg1 = await repo.addMessage({
    id: crypto.randomUUID(),
    conversationId: conv1.id,
    role: "user",
    content: turn1User,
    createdAt: new Date().toISOString(),
    status: "complete",
  });

  // Assistant responds in Conversation 1
  const asstMsg1 = await repo.addMessage({
    id: crypto.randomUUID(),
    conversationId: conv1.id,
    role: "assistant",
    content: "Faraday's law states that a changing magnetic flux induces an electromotive force (EMF) in a conductor.",
    createdAt: new Date().toISOString(),
    status: "complete",
  });

  await repo.renameConversation(conv1.id, "Electromagnetic Induction & Faraday's Law");
  await repo.setConversationPreview(conv1.id, turn1User.slice(0, 80));

  // Also simulate auto-recording study_session for conv1
  await repo.upsertMemory({
    type: "study_session",
    label: "Recent study session",
    summary: `Studied Induction: "${turn1User}"`,
    source: "learned",
    conversationId: conv1.id,
    keywords: ["induction", "faraday", "electromagnetic"],
  });

  console.log("Conversation 1 finished. Title:", (await repo.getConversation(conv1.id))?.title);

  // Step 2: User opens Conversation 2 (New chat)
  const conv2 = await repo.createConversation("New conversation");
  console.log("Created Conversation 2 (New chat):", conv2.id);

  // Step 3: In Conversation 2, user asks: "where i was"
  const app = express();
  app.use(express.json());
  app.use("/api/conversations", messagesRouter(repo, provider));

  // Let's test the stream or direct handler by simulating the turn
  const allConvs = await repo.listConversations();
  const prevConv = allConvs.find((c) => c.id !== conv2.id && c.title !== "New conversation");
  assert.ok(prevConv, "Should find previous conversation");
  assert.equal(prevConv.title, "Electromagnetic Induction & Faraday's Law");

  const prevMessages = await repo.listMessages(prevConv.id);
  const lastUserMsg = prevMessages.filter((m) => m.role === "user").pop();
  assert.ok(lastUserMsg, "Should find last user message from previous conversation");
  assert.equal(lastUserMsg.content, turn1User);

  // Test provider.stream with continuity request
  const chunks: string[] = [];
  for await (const piece of provider.stream(
    {
      content: "where i was",
      responseMode: "study",
      attachments: [],
      readyAttachments: [],
      memories: [],
      previousSession: {
        conversationId: prevConv.id,
        title: prevConv.title,
        lastTopicOrQuestion: lastUserMsg.content,
        lastAssistantSummary: asstMsg1.content,
      },
    },
    new AbortController().signal,
  )) {
    chunks.push(piece);
  }

  const responseText = chunks.join("");
  console.log("\nResponse to 'where i was':\n", responseText);

  assert.ok(responseText.includes("Electromagnetic Induction"), "Response must mention previous topic");
  // Step 4: Verify via actual HTTP request through Express router
  const server = app.listen(0);
  const port = (server.address() as any).port;
  console.log(`Ephemeral test server listening on :${port}`);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations/${conv2.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "where i was",
        responseMode: "study",
        attachmentIds: [],
      }),
    });

    assert.equal(res.status, 200, "HTTP response should be 200 OK");
    const json: any = await res.json();
    console.log("\nFull HTTP Response to 'where i was':");
    console.log("Assistant content:\n", json.assistantMessage?.content);
    console.log("Context note:", json.assistantMessage?.contextNote);
    console.log("Study context items count:", json.assistantMessage?.studyContext?.length);

    assert.ok(json.assistantMessage?.content.includes("Electromagnetic Induction"), "HTTP content must reference previous topic");
    assert.ok(json.assistantMessage?.contextNote?.includes("Electromagnetic Induction"), "Context note must reference previous session");
    assert.ok(json.assistantMessage?.studyContext?.length > 0, "Must have study context items");
  } finally {
    server.close();
  }

  console.log("\n Cross-chat continuity ('where i was') passed successfully!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
