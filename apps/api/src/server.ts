import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { PgRepository } from "./db/pg-repository.js";
import { MemoryRepository } from "./db/memory-repository.js";
import type { Repository } from "./db/repository.js";
import { LocalAnswerProvider } from "./services/answer.js";
import { conversationsRouter } from "./routes/conversations.js";
import { messagesRouter } from "./routes/messages.js";
import { uploadsRouter } from "./routes/uploads.js";
import { contextRouter, feedbackRouter, memoriesRouter } from "./routes/context.js";
import { errorHandler, notFound } from "./routes/helpers.js";
import { ensureDir } from "./services/files.js";

function buildRepo(): Repository {
  return config.usingMemoryStore
    ? new MemoryRepository()
    : new PgRepository(config.databaseUrl);
}

export async function createApp() {
  const repo = buildRepo();
  await repo.init();
  await ensureDir(config.uploadDir);

  // Swap this for a model-backed provider. It must stay server-side.
  const provider = new LocalAnswerProvider();

  const app = express();

  app.disable("x-powered-by");
  /*
   * CORS: with CORS_ORIGIN unset, local development reflects any localhost
   * origin so the web app works on whatever port it picked. In production the
   * origin list is required — no credentials are sent either way unless the
   * list is explicit.
   */
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && !config.corsOrigins) {
    throw new Error("CORS_ORIGIN must be set in production.");
  }

  app.use(
    cors({
      origin: config.corsOrigins ?? /^https?:\/\/localhost(:\d+)?$/,
      credentials: Boolean(config.corsOrigins),
    }),
  );

  // Uploads use multipart and set their own limits; JSON gets a generous but
  // finite cap so a runaway body cannot exhaust memory.
  app.use(express.json({ limit: "2mb" }));

  if (config.logRequests) {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on("finish", () => {
        console.log(`[api] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
      });
      next();
    });
  }

  app.get("/health", async (_req, res) => {
    res.json({
      ok: true,
      store: repo.kind,
      answerProvider: provider.name,
      persistence: repo.kind === "postgres" ? "postgres" : "in-memory (set DATABASE_URL to persist)",
    });
  });

  app.use("/api/conversations", conversationsRouter(repo));
  app.use("/api/conversations", messagesRouter(repo, provider));
  app.use("/api/conversations", contextRouter(repo));
  app.use("/api/uploads", uploadsRouter(repo));
  app.use("/api/memories", memoriesRouter(repo));
  app.use("/api/messages", feedbackRouter(repo));

  app.use(notFound);
  app.use(errorHandler);

  return { app, repo };
}

const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");

if (isMain) {
  createApp()
    .then(({ app, repo }) => {
      app.listen(config.port, () => {
        console.log(`[api] RecallAI listening on http://localhost:${config.port}`);
        console.log(`[api] store: ${repo.kind}`);
        if (repo.kind === "memory") {
          console.log("[api] DATABASE_URL is empty — history will not survive a restart.");
        }
      });
    })
    .catch((err) => {
      console.error("[api] failed to start:", err);
      process.exit(1);
    });
}