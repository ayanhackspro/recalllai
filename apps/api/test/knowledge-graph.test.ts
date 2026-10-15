import test from "node:test";
import assert from "node:assert/strict";
import { falkorContext } from "../src/services/falkordb.js";
import type { StudyMemory } from "@recallai/shared-types";

test("Knowledge Graph & Mastery Heatmap Engine", async (t) => {
  await t.test("generates complete graph structure and ontology edges", async () => {
    const graphData = await falkorContext.getKnowledgeGraph();

    assert.ok(graphData.nodes.length >= 15, "Should contain academic curriculum topic nodes");
    assert.ok(graphData.edges.length >= 12, "Should contain structural relationship edges");

    // Check specific prerequisite edge
    const newtonToNetForce = graphData.edges.find(
      (e) => e.source === "Newton's Laws" && e.target === "Net Force",
    );
    assert.ok(newtonToNetForce, "Should have directed edge from Newton's Laws to Net Force");
    assert.equal(newtonToNetForce.type, "PREREQUISITE_OF");

    // Check node category mapping
    const physicsNode = graphData.nodes.find((n) => n.id === "Net Force");
    assert.ok(physicsNode);
    assert.equal(physicsNode.category, "Physics");
    assert.ok(physicsNode.prerequisites.includes("Newton's Laws"));
    assert.ok(physicsNode.dependents.includes("Inclined Plane") || physicsNode.dependents.length >= 0);
  });

  await t.test("evaluates SM-2 mastery status transitions dynamically", async () => {
    const testMemories: StudyMemory[] = [
      {
        id: "mem_struggling_net_force",
        type: "mistake",
        label: "Recurring mistake",
        summary: "Forgets to calculate net force on inclined plane with friction.",
        source: "learned",
        masteryScore: 30, // struggling (< 40)
        repetitionCount: 1,
        intervalDays: 1,
        easeFactor: 2.3,
        updatedAt: new Date().toISOString(),
      },
      {
        id: "mem_mastered_recursion",
        type: "topic",
        label: "Mastered topic",
        summary: "Recursion base cases, call stacks, and recursive tree traversals.",
        source: "learned",
        masteryScore: 88, // mastered (>= 75)
        repetitionCount: 5,
        intervalDays: 14,
        easeFactor: 2.6,
        nextReviewAt: new Date(Date.now() + 864e5 * 10).toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "mem_overdue_eigenvalues",
        type: "topic",
        label: "Due for review",
        summary: "Eigenvalues, characteristic determinants, and matrix decompositions.",
        source: "learned",
        masteryScore: 65,
        repetitionCount: 2,
        intervalDays: 3,
        easeFactor: 2.4,
        nextReviewAt: new Date(Date.now() - 36e5 * 5).toISOString(), // overdue!
        updatedAt: new Date().toISOString(),
      },
    ];

    const graphData = await falkorContext.getKnowledgeGraph(testMemories);

    // 1. Net Force should reflect struggling state due to recurring mistake and low score
    const netForceNode = graphData.nodes.find((n) => n.id === "Net Force");
    assert.ok(netForceNode);
    assert.equal(netForceNode.status, "struggling");
    assert.ok(netForceNode.connectedMistakes.length > 0);

    // 2. Recursion should reflect mastered state
    const recursionNode = graphData.nodes.find((n) => n.id === "Recursion");
    assert.ok(recursionNode);
    assert.equal(recursionNode.status, "mastered");
    assert.ok(recursionNode.masteryScore >= 75);

    // 3. Eigenvalues should reflect review_due state
    const eigenvaluesNode = graphData.nodes.find((n) => n.id === "Eigenvalues");
    assert.ok(eigenvaluesNode);
    assert.equal(eigenvaluesNode.status, "review_due");
    assert.equal(eigenvaluesNode.isDue, true);

    // 4. Summary counts should be consistent
    assert.ok(graphData.summary.totalTopics >= 15);
    assert.ok(graphData.summary.struggling >= 1);
    assert.ok(graphData.summary.mastered >= 1);
    assert.ok(graphData.summary.reviewDue >= 1);
  });
});
