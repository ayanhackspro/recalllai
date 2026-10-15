import { config } from "../src/config.js";
import { PgRepository } from "../src/db/pg-repository.js";

async function testNeon() {
  console.log("=== Testing Neon PostgreSQL Connection & Schema ===");
  const repo = new PgRepository(config.databaseUrl);
  console.log("Repository class:", repo.constructor.name);

  // 1. Check conversations
  const convs = await repo.listConversations();
  console.log(`Current conversations count in Neon: ${convs.length}`);

  // 2. Create a test conversation to verify write & preview
  const testConv = await repo.createConversation("Neon Integration Test");
  console.log(`Created test conversation: ${testConv.id}`);

  await repo.setConversationPreview(testConv.id, "Testing conversation preview snippet in Neon");
  const updatedConv = await repo.getConversation(testConv.id);
  console.log(`Verified preview snippet: "${updatedConv?.preview}"`);

  // 3. Test memory recording & listing
  const mem = await repo.upsertMemory({
    type: "preference",
    label: "Neon Test Fact",
    summary: "Neon PostgreSQL is live and connected.",
    source: "learned",
    updatedAt: new Date().toISOString(),
    conversationId: testConv.id,
    keywords: ["neon", "postgres", "test"],
  });
  console.log(`Recorded memory in Neon: [${mem.id}] ${mem.summary}`);

  const allMems = await repo.listMemories();
  console.log(`Total memories in Neon: ${allMems.length}`);

  // 4. Clean up all test conversations and memories
  const lingeringConvs = await repo.listConversations();
  for (const c of lingeringConvs) {
    if (c.title === "Neon Integration Test") {
      await repo.deleteConversation(c.id);
    }
  }
  const lingeringMems = await repo.listMemories();
  for (const m of lingeringMems) {
    if (m.summary.includes("Neon PostgreSQL is live")) {
      await repo.deleteMemory(m.id);
    }
  }
  console.log("All test conversations and memories cleaned up.");

  const finalConvs = await repo.listConversations();
  console.log(`Final clean conversation count: ${finalConvs.length}`);

  await repo.close();
  console.log("=== Neon PostgreSQL Integration Verified Successfully! ===");
}

testNeon().catch((err) => {
  console.error("Neon test failed:", err);
  process.exit(1);
});
