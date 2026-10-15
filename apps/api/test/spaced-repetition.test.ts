import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/db/memory-repository.js";
import { PgRepository } from "../src/db/pg-repository.js";
import { config } from "../src/config.js";

describe("Spaced Repetition Engine (SM-2) & Resilience Tests", () => {
  it("MemoryRepository calculates SM-2 reviews correctly", async () => {
    const repo = new MemoryRepository();
    await repo.init();

    // 1. Create a memory with a unique summary for isolated test
    const testSummary = `Calculating characteristic equations det(A - lambda*I) = 0 [${crypto.randomUUID()}]`;
    const mem = await repo.upsertMemory({
      type: "topic",
      label: "Eigenvalues & Decompositions",
      summary: testSummary,
      keywords: ["eigenvalues", "matrix", "decomposition"],
    });

    assert.equal(mem.masteryScore, 0);
    assert.equal(mem.repetitionCount, 0);

    // 2. Review with rating 5 (Mastered)
    const review1 = await repo.reviewMemory(mem.id, 5);
    assert.ok(review1);
    assert.equal(review1.repetitionCount, 1);
    assert.equal(review1.intervalDays, 1);
    assert.equal(review1.masteryScore, 25);
    assert.ok(review1.nextReviewAt);

    // 3. Second review with rating 4 (Easy/Good)
    const review2 = await repo.reviewMemory(mem.id, 4);
    assert.ok(review2);
    assert.equal(review2.repetitionCount, 2);
    assert.equal(review2.intervalDays, 3);
    assert.equal(review2.masteryScore, 40);

    // 4. Third review with rating 5
    const review3 = await repo.reviewMemory(mem.id, 5);
    assert.ok(review3);
    assert.equal(review3.repetitionCount, 3);
    assert.ok(review3.intervalDays >= 7);
    assert.equal(review3.masteryScore, 65);

    // 5. Test failure with rating 1 (Again) -> resets repetition count
    const reviewFail = await repo.reviewMemory(mem.id, 1);
    assert.ok(reviewFail);
    assert.equal(reviewFail.repetitionCount, 0);
    assert.equal(reviewFail.intervalDays, 1);
    assert.ok(reviewFail.masteryScore < 65);

    await repo.deleteMemory(mem.id);
  });

  it("lists due memories based on the forgetting curve threshold", async () => {
    const repo = new MemoryRepository();
    await repo.init();

    // Insert an item that is already due (no nextReviewAt)
    const m1 = await repo.upsertMemory({
      type: "mistake",
      label: "Inclined plane force balance",
      summary: "Forgetting friction component opposing motion",
      keywords: ["friction", "force"],
    });

    const dueList = await repo.listDueMemories(10);
    assert.ok(dueList.some((m) => m.id === m1.id));

    await repo.deleteMemory(m1.id);
  });

  if (Boolean(config.databaseUrl)) {
    it("PgRepository connects to Neon and executes SM-2 spaced repetition", async () => {
      const repo = new PgRepository(config.databaseUrl);
      await repo.init();

      // Test cold-start query retry
      const ping = await repo.queryWithRetry("SELECT 1 AS ok");
      assert.equal(ping.rows[0].ok, 1);

      // Create a fresh memory on Neon
      const uniqueSummary = `Testing SuperMemo-2 columns on live Neon Postgres [${crypto.randomUUID()}]`;
      const mem = await repo.upsertMemory({
        type: "mistake",
        label: "Neon SM-2 Test",
        summary: uniqueSummary,
        keywords: ["neon", "sm2", "test"],
      });

      assert.ok(mem.id);
      assert.equal(typeof mem.masteryScore, "number");

      // Review memory
      const reviewed = await repo.reviewMemory(mem.id, 4);
      assert.ok(reviewed);
      assert.equal(reviewed.repetitionCount, 1);
      assert.equal(reviewed.intervalDays, 1);
      assert.equal(reviewed.masteryScore, 15);
      assert.ok(reviewed.nextReviewAt);

      // List due
      const due = await repo.listDueMemories(10);
      assert.ok(Array.isArray(due));

      // Clean up
      await repo.deleteMemory(mem.id);
      await repo.close();
    });
  }
});
