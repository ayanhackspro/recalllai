import type { AnswerProvider, AnswerRequest } from "./answer.js";
import { LocalAnswerProvider } from "./answer.js";
import { config } from "../config.js";

interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaChatChunk {
  model?: string;
  created_at?: string;
  message?: {
    role?: string;
    content?: string;
  };
  done?: boolean;
}

/**
 * OllamaAnswerProvider
 *
 * Streams live local LLM responses from Ollama (e.g. Qwen 2.5 1.5B).
 * Incorporates FalkorDB graph-backed context, retrieved study memories,
 * extracted document text, and multi-turn conversation history.
 *
 * If Ollama is offline or not yet started, it gracefully falls back to
 * LocalAnswerProvider without crashing the request, and will automatically
 * pick up Ollama on the next request once Ollama is launched.
 */
export class OllamaAnswerProvider implements AnswerProvider {
  readonly name = "ollama";
  private readonly fallback = new LocalAnswerProvider();

  constructor(
    public readonly baseUrl = config.ollamaBaseUrl,
    public readonly model = config.ollamaModel,
    public readonly temperature = config.ollamaTemperature,
  ) {}

  /** Checks whether Ollama is reachable and whether the target model is installed. */
  async checkHealth(): Promise<{
    online: boolean;
    hasModel: boolean;
    models: string[];
    error?: string;
  }> {
    if (!config.ollamaEnabled) {
      return {
        online: false,
        hasModel: false,
        models: [],
        error: "Ollama disabled via OLLAMA_ENABLED=false",
      };
    }
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) {
        return {
          online: true,
          hasModel: false,
          models: [],
          error: `Ollama returned HTTP ${res.status}`,
        };
      }
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const modelList = (data.models ?? []).map((m) => m.name);
      const target = this.model.toLowerCase();
      const hasModel = modelList.some((m) => {
        const lower = m.toLowerCase();
        return (
          lower === target ||
          lower.startsWith(`${target}:`) ||
          target.startsWith(`${lower}:`) ||
          lower.includes(target)
        );
      });
      return { online: true, hasModel, models: modelList };
    } catch (err) {
      return {
        online: false,
        hasModel: false,
        models: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async *stream(req: AnswerRequest, signal: AbortSignal): AsyncGenerator<string, void, void> {
    if (!config.ollamaEnabled) {
      yield* this.fallback.stream(req, signal);
      return;
    }

    // Build the pedagogical prompt incorporating FalkorDB graph memory & attachments
    const messages = this.buildPrompt(req);

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          options: {
            temperature: this.temperature,
          },
        }),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        console.warn(
          `[api/ollama] Ollama responded with HTTP ${response.status} (${errorText || response.statusText}). Falling back to local provider.`,
        );
        yield* this.fallback.stream(req, signal);
        return;
      }

      if (!response.body) {
        throw new Error("No response body received from Ollama stream");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      try {
        while (true) {
          if (signal.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          // Keep the last potentially incomplete chunk
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const chunk = JSON.parse(trimmed) as OllamaChatChunk;
              const content = chunk.message?.content;
              if (content) {
                yield content;
              }
              if (chunk.done) {
                return;
              }
            } catch {
              // Ignore partial JSON parse errors
            }
          }
        }

        // Process any remaining tail in buffer
        if (buffer.trim()) {
          try {
            const chunk = JSON.parse(buffer.trim()) as OllamaChatChunk;
            if (chunk.message?.content) yield chunk.message.content;
          } catch {
            // End of stream
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (err: unknown) {
      if (signal.aborted) return;
      console.warn(
        `[api/ollama] Ollama stream failed (${err instanceof Error ? err.message : String(err)}). Falling back to local provider. (Run 'ollama run ${this.model}' to activate live local inference).`,
      );
      yield* this.fallback.stream(req, signal);
    }
  }

  private buildPrompt(req: AnswerRequest): OllamaChatMessage[] {
    const { content, responseMode, memories, readyAttachments, history } = req;

    // Detect academic subject domains from student question and durable memories
    const textPool = (content + " " + memories.map((m) => m.summary + " " + m.label).join(" ")).toLowerCase();
    const isPhysics = /\b(force|newton|gravity|friction|ramp|incline|momentum|torque|collision|quantum|photon|wave|energy|kinetic|potential|charge|electric|magnetic|field|voltage|resistor|capacit|thermodynamic|optics|lens|diffraction|interference|acceleration|velocity)\b/i.test(textPool);
    const isChemistry = /\b(equilibrium|gibbs|enthalpy|entropy|reaction|rate|acid|base|ph|buffer|nernst|galvanic|redox|titration|moles?|stoichiometr|nucleophil|electrophil|sn1|sn2|e1|e2|carbocation|orbital|hybridiz|isomer|stereochem|activation energy|le chatelier)\b/i.test(textPool);
    const isMath = /\b(matrix|matrices|eigen|determinant|derivative|integral|calculus|vector|linear algebra|limit|series|differential|polynomial|function|proof|domain|range|probability|geometry|trigonometr|algebra)\b/i.test(textPool);

    // Calculate student's current topic mastery score and mistake signals
    const avgMastery = memories.length > 0
      ? Math.round(memories.reduce((acc, m) => acc + (m.masteryScore ?? 50), 0) / memories.length)
      : 50;
    const hasStrugglingMistake = memories.some(
      (m) => m.type === "mistake" || (m.masteryScore != null && m.masteryScore < 40),
    );

    let systemPrompt = [
      `You are RecallAI, a world-class academic study companion and master tutor specialized in Physics, Chemistry, and Mathematics (PCM).`,
      `Your purpose is to build deep first-principles conceptual clarity, eradicate student misconceptions, and guide the learner to full mastery.`,
      ``,
      `### Mathematical & Formatting Guardrails (Strict KaTeX):`,
      `- Use clean GitHub-flavored Markdown.`,
      `- Mathematical Equations & Variables:`,
      `  * ALWAYS format inline variables, numbers with units, and formulas in single dollar signs: $F$, $m = 2.5\\text{ kg}$, $\\theta = 30^\\circ$, $\\lambda_i$, $[\\text{H}^+]$.`,
      `  * ALWAYS format key equations and multi-step derivations in block/display math on their own dedicated lines with double dollar signs:`,
      `    $$`,
      `    \\sum \\vec{F}_{\\text{net}} = m \\vec{a}`,
      `    $$`,
      `  * Ensure syntactically valid LaTeX macros (\\frac{a}{b}, \\sqrt{}, \\vec{v}, \\times, \\pm, \\Delta, \\int, \\sum, \\lim, \\rightleftharpoons).`,
      `  * NEVER use raw Unicode math symbols like "√", "×", "±", or "θ"—always use LaTeX macros.`,
      `  * Show every algebraic or stoichiometric step on a fresh line with clear commentary.`,
      `- Skip hollow conversational preamble (NEVER say "Sure! Here is an explanation of..."). Jump directly into the pedagogical breakdown.`,
      ``,
      `### Subject-Specific Pedagogical Protocols (PCM):`,
    ].join("\n");

    // 1. Physics Protocol
    if (isPhysics || (!isChemistry && !isMath)) {
      systemPrompt += `\n#### Physics Execution Standard:
- **Intuitive Mental Model First**: Describe the physical mechanism (Feynman technique) before introducing formulas.
- **Coordinate & Vector Decomposition**: For 2D problems (inclined planes, projectile motion, circular motion), explicitly define orthogonal axes (e.g. parallel $x_\\parallel$ and perpendicular $y_\\perp$ to the surface).
- **Free-Body Discipline**: Explicitly account for all external forces acting ON the body before writing $\\sum F = ma$.
- **Dimensional & Unit Check**: Verify that units balance across every term ($[M][L][T]^{-2}$ for force, $\\text{J} = \\text{N}\\cdot\\text{m}$ for work/energy).
- **Boundary Limit Test**: Test limiting cases (e.g. $\\theta \\to 0^\\circ, 90^\\circ$, $m \\to 0, \\infty$, friction $\\mu \\to 0$, velocity $v \\to c$) to verify intuition.\n`;
    }

    // 2. Chemistry Protocol
    if (isChemistry) {
      systemPrompt += `\n#### Chemistry Execution Standard:
- **Kinetics vs. Thermodynamics**: Strictly separate reaction spontaneity (thermodynamic $\\Delta G^\\circ, K_{\\text{eq}}$) from reaction speed (kinetic $E_a, k$). Emphasize that catalysts lower $E_a$ without shifting equilibrium position.
- **Chemical Reactions (KaTeX)**: Write balanced equations with physical state symbols:
  $$
  \\text{N}_2(\\text{g}) + 3\\text{H}_2(\\text{g}) \\rightleftharpoons 2\\text{NH}_3(\\text{g}), \\quad \\Delta H^\\circ = -92.2\\text{ kJ/mol}
  $$
- **Organic Mechanisms**: Detail curved electron-pushing logic, nucleophile/electrophile centers, reactive intermediate stabilities (tertiary vs secondary vs primary carbocations), and stereochemical consequences ($R/S$, inversion in $\\text{S}_\\text{N}2$, racemization in $\\text{S}_\\text{N}1$).
- **Equilibria & Electrochemistry**: Clearly define quotients $Q$ vs constants $K$, Nernst potential $E = E^\\circ - \\frac{RT}{nF}\\ln Q$, and buffer relations $\\text{pH} = \\text{p}K_a + \\log\\frac{[\\text{A}^-]}{[\\text{HA}]}$.\n`;
    }

    // 3. Mathematics Protocol
    if (isMath) {
      systemPrompt += `\n#### Mathematics Execution Standard:
- **Definition-Theorem-Step Architecture**: State definitions and theorems rigorously before applying them to problem sets.
- **Matrix & Linear Algebra**: Format matrices cleanly:
  $$
  A - \\lambda I = \\begin{bmatrix} a - \\lambda & b \\\\ c & d - \\lambda \\end{bmatrix}, \\quad \\det(A - \\lambda I) = 0
  $$
- **Calculus Integrity**: Check domain restrictions ($x \\neq 0$, radicands $\\ge 0$). Always include integration constants $+ C$ on indefinite integrals. Explain substitution steps ($u = g(x), du = g'(x)dx$) explicitly.
- **Step-by-Step Algebraic Logic**: State the mathematical justification on each line (e.g. "Factoring characteristic polynomial", "Applying integration by parts").\n`;
    }

    // Mastery-Adaptive Cognitive Load
    systemPrompt += `\n### Student Mastery & Cognitive Load Adaptation:`;
    if (hasStrugglingMistake || avgMastery < 40) {
      systemPrompt += `\n- **Target State: STRUGGLING / MISCONCEPTION DETECTED (Mastery: ${avgMastery}%)**: The student finds this topic challenging. Deconstruct concepts using tangible physical analogies before mathematical formalism. Decompose equations term-by-term. Highlight cognitive traps with an explicit callout.`;
    } else if (avgMastery >= 75) {
      systemPrompt += `\n- **Target State: MASTERED (Mastery: ${avgMastery}%)**: The student has demonstrated high retention (${avgMastery}%). Elevate mathematical rigor, explore boundary conditions, non-trivial edge cases, and cross-subject symmetries.`;
    } else {
      systemPrompt += `\n- **Target State: LEARNING (Mastery: ${avgMastery}%)**: The student is actively consolidating this topic (${avgMastery}%). Balance clear intuitive models with formal mathematical derivations.`;
    }

    // Response Mode Guidelines
    systemPrompt += `\n\n### Response Mode Directives:`;
    if (responseMode === "study") {
      systemPrompt += `\n- **Mode: STUDY**: Follow this pedagogical 4-stage flow:
  1. **Mental Model**: Physical / chemical / geometric intuition in 2-3 sentences.
  2. **Mathematical Formulation**: Governing equations formatted in display KaTeX ($$...$$) with every variable defined.
  3. **Cognitive Trap Callout**: An explicit cautionary box addressing common pitfalls:
     > ⚠️ **Common Trap:** [Describe the exact misconception and why it fails]
  4. **Active Recall Check**: Conclude with 1 quick conceptual question testing whether the student grasped the core intuition (do not give the answer away).`;
    } else if (responseMode === "deep-dive") {
      systemPrompt += `\n- **Mode: DEEP DIVE**: Provide an exhaustive, first-principles derivation:
  1. Axiomatic starting points and governing assumptions.
  2. Step-by-step mathematical or mechanistic proof with intermediate reasoning.
  3. Limiting behaviors and asymptotic edge cases.
  4. Theoretical unification connecting this topic to broader PCM concepts.`;
    } else if (responseMode === "quiz") {
      systemPrompt += `\n- **Mode: QUIZ**: Formulate targeted diagnostic questions:
  * If the student asks for a quiz or topic test, present Question 1 (Core Concept) and Question 2 (Applied Calculation) with clear problem statements and variables.
  * If the student provides their answers, evaluate their work with mathematical precision, diagnose any conceptual gaps, and provide the recommended SM-2 recall rating: [Again] (forgot/misconception), [Hard] (hesitant/partial), [Good] (accurate), or [Mastered] (effortless).`;
    }

    // Inject Knowledge Graph context with explicit prerequisite warnings
    if (memories && memories.length > 0) {
      systemPrompt += `\n\n### Student Context & Knowledge Graph (FalkorDB / Spaced Repetition):\n`;
      systemPrompt += `The student's durable study history contains the following concepts and recorded misconceptions:\n`;
      for (const m of memories) {
        const typeTag = m.type.toUpperCase();
        const scoreStr = m.masteryScore != null ? ` [Mastery: ${m.masteryScore}%]` : "";
        systemPrompt += `- [${typeTag}] "${m.label}"${scoreStr}: ${m.summary}\n`;
      }
      if (hasStrugglingMistake) {
        systemPrompt += `\nCRITICAL: The student has a recorded mistake above. Construct a clear cautionary callout box (> ⚠️ **Common Trap:** ...) directly resolving this misconception.\n`;
      }
    }

    // Inject uploaded notes / files
    if (readyAttachments && readyAttachments.length > 0) {
      systemPrompt += `\n\n### Student's Attached Notes / Material:\n`;
      systemPrompt += `The student provided the following study material. Ground your equations and terminology in their source notes:\n`;
      for (const att of readyAttachments) {
        const textSample = att.text.slice(0, 3000);
        systemPrompt += `--- [Attachment: ${att.attachment.name}] ---\n${textSample}\n---\n`;
      }
    }

    // Inject Cross-Chat Continuity
    if (req.previousSession) {
      systemPrompt += `\n\n### Prior Session Context (Cross-Chat Continuity):\n`;
      systemPrompt += `Previous session: "${req.previousSession.title}" (Working on: "${req.previousSession.lastTopicOrQuestion}").\n`;
      if (req.previousSession.lastAssistantSummary) {
        systemPrompt += `Summary: ${req.previousSession.lastAssistantSummary}\n`;
      }
      systemPrompt += `If the student asks "where was I", "continue", or asks to pick up, immediately orient them to this topic and recommend the natural next pedagogical step.\n`;
    }

    // End with distillation guideline
    systemPrompt += `\n\n### Memory Distillation:
At the conclusion of explanations, summarize the governing law or invariant in one concise block:
> **Core Principle:** [1 concise sentence capturing the physical law, chemical equilibrium, or mathematical formula]`;

    const messages: OllamaChatMessage[] = [
      { role: "system", content: systemPrompt },
    ];


    // Append prior conversational history if available
    if (history && history.length > 0) {
      for (const msg of history.slice(-8)) {
        if (msg.content.trim()) {
          messages.push({
            role: msg.role === "assistant" ? "assistant" : "user",
            content: msg.content,
          });
        }
      }
    }

    // Append current turn user prompt
    messages.push({
      role: "user",
      content: content.trim() || "Please explain this topic based on my attached notes and study context.",
    });

    return messages;
  }
}
