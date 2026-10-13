import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal .env loader. Real env vars always win, so a container or CI can
 * override anything in the file without editing it.
 */
const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "../.env");

if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: (process.env.DATABASE_URL ?? "").trim(),
  corsOrigins: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean)
    : null,
  uploadDir: resolve(here, "..", process.env.UPLOAD_DIR ?? "./uploads"),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 20 * 1024 * 1024),
  allowOversize: bool("ALLOW_OVERSIZE", false),
  logRequests: bool("LOG_REQUESTS", true),
  /**
   * Pause between streamed chunks. Raise it when demoing so the typing
   * effect is visible; 0 streams as fast as the socket allows.
   */
  streamChunkDelayMs: Number(process.env.STREAM_CHUNK_DELAY_MS ?? 28),
  /** True when there is no Postgres connection, so the in-memory store is used. */
  get usingMemoryStore() {
    return this.databaseUrl.length === 0;
  },
} as const;

export type Config = typeof config;