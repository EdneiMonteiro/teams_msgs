// Copyright (c) 2026 Ednei Monteiro. Licensed under the MIT License.
// See LICENSE and DISCLAIMER.md in the project root for details.
//
// Redis é usado para 4 coisas:
//   1. Job counters atômicos (HINCRBY).
//   2. Index ativo de refs (SADD/SREM/SCARD) — contagem O(1).
//   3. Cache do payload da mensagem (texto ou Adaptive Card).
//   4. Token bucket global (rate limit Lua) — limita a taxa total de
//      envios para o Bot Framework, independente do número de workers.

import Redis from "ioredis";

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    const connStr = process.env.REDIS_CONNECTION || "";
    const match = connStr.match(/^(.+):(\d+),password=([^,]+)/);
    if (match) {
      client = new Redis({
        host: match[1],
        port: parseInt(match[2], 10),
        password: match[3],
        tls: { servername: match[1] },
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
      });
    } else {
      client = new Redis(connStr || "redis://localhost:6379", {
        maxRetriesPerRequest: 3,
      });
    }
    client.on("error", (err) => console.error(`[REDIS] ${err.message}`));
  }
  return client;
}

// --- Keys ---
const REFS_SET = "refs:active";
const RATE_BUCKET_KEY = process.env.RATE_LIMIT_KEY || "ratelimit:bot";
const JOB_TTL_SECONDS = 86400; // 24h
function jobKey(jobId: string): string {
  return `job:${jobId}`;
}

// --- Refs index ---

export async function refsAdd(rowKey: string): Promise<void> {
  await getRedis().sadd(REFS_SET, rowKey);
}

export async function refsRemove(rowKey: string): Promise<void> {
  await getRedis().srem(REFS_SET, rowKey);
}

export async function refsCount(): Promise<number> {
  return await getRedis().scard(REFS_SET);
}

// --- Job lifecycle ---

export type MessageType = "text" | "card";

export async function createJob(
  jobId: string,
  message: string,
  total: number,
  messageType: MessageType = "text"
): Promise<void> {
  const redis = getRedis();
  const key = jobKey(jobId);
  const now = new Date().toISOString();
  await redis.hmset(key, {
    message,
    messageType,
    total: total.toString(),
    sent: "0",
    failed: "0",
    status: "queued",
    createdAt: now,
    updatedAt: now,
    errors: "[]",
  });
  await redis.expire(key, JOB_TTL_SECONDS);
}

export async function setJobStatus(jobId: string, status: string): Promise<void> {
  const redis = getRedis();
  await redis.hset(jobKey(jobId), "status", status, "updatedAt", new Date().toISOString());
}

export async function updateJobTotal(jobId: string, newTotal: number): Promise<void> {
  await getRedis().hset(jobKey(jobId), "total", String(newTotal), "updatedAt", new Date().toISOString());
}

export async function incrementFailed(jobId: string, errorMsg?: string): Promise<void> {
  const redis = getRedis();
  const key = jobKey(jobId);
  const [failed, sentStr, totalStr] = await Promise.all([
    redis.hincrby(key, "failed", 1),
    redis.hget(key, "sent"),
    redis.hget(key, "total"),
  ]);
  if (errorMsg) {
    const errorsJson = (await redis.hget(key, "errors")) || "[]";
    const errors: string[] = JSON.parse(errorsJson);
    if (errors.length < 50) {
      errors.push(errorMsg);
      await redis.hset(key, "errors", JSON.stringify(errors));
    }
  }
  const total = parseInt(totalStr || "0", 10);
  const totalProcessed = parseInt(sentStr || "0", 10) + failed;
  const status = totalProcessed >= total ? "completed" : "processing";
  await redis.hset(key, "status", status, "updatedAt", new Date().toISOString());
}

export interface JobStatus {
  jobId: string;
  message: string;
  messageType: MessageType;
  total: number;
  sent: number;
  failed: number;
  status: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
  errors: string[];
}

export async function getJob(jobId: string): Promise<JobStatus | null> {
  const redis = getRedis();
  const data = await redis.hgetall(jobKey(jobId));
  if (!data || !data.total) return null;
  const total = parseInt(data.total, 10);
  const sent = parseInt(data.sent || "0", 10);
  const failed = parseInt(data.failed || "0", 10);
  return {
    jobId,
    message: data.message || "",
    messageType: (data.messageType as MessageType) || "text",
    total,
    sent,
    failed,
    status: data.status || "unknown",
    progress: total > 0 ? Math.round(((sent + failed) / total) * 100) : 0,
    createdAt: data.createdAt || "",
    updatedAt: data.updatedAt || "",
    errors: JSON.parse(data.errors || "[]"),
  };
}

export async function pingRedis(): Promise<boolean> {
  try {
    const pong = await getRedis().ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

// --- Token Bucket (Redis-backed, Lua atomic) ---
//
// Algoritmo: bucket com `capacity` tokens; refill a `rate` tokens/segundo.
// Cada chamada bem-sucedida consome 1 token. Sob disputa, múltiplos
// workers competem pela MESMA chave, então o limite é GLOBAL — não
// por réplica.

export const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])
local now_ms   = tonumber(ARGV[3])

local data = redis.call("HMGET", KEYS[1], "tokens", "ts")
local tokens = tonumber(data[1])
local last   = tonumber(data[2])

if tokens == nil then tokens = capacity end
if last   == nil then last   = now_ms end

local elapsed = math.max(0, now_ms - last) / 1000.0
tokens = math.min(capacity, tokens + elapsed * rate)

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call("HSET", KEYS[1], "tokens", tokens, "ts", now_ms)
redis.call("EXPIRE", KEYS[1], 60)
return allowed
`;

let bucketScriptLoaded = false;
async function ensureBucketScript(): Promise<void> {
  if (bucketScriptLoaded) return;
  const redis = getRedis();
  // ioredis: defineCommand caches the script on the client.
  if (!(redis as any).acquireBucketToken) {
    redis.defineCommand("acquireBucketToken", {
      numberOfKeys: 1,
      lua: TOKEN_BUCKET_LUA,
    });
  }
  bucketScriptLoaded = true;
}

/**
 * Try to acquire 1 token from the global bucket. Returns true if granted.
 *
 * @param capacity max burst (default RATE_LIMIT_CAPACITY env or 50)
 * @param ratePerSec sustained rate (default RATE_LIMIT_PER_SEC env or 50)
 */
export async function tryAcquireToken(
  capacity?: number,
  ratePerSec?: number
): Promise<boolean> {
  await ensureBucketScript();
  const cap = capacity ?? parseInt(process.env.RATE_LIMIT_CAPACITY || "50", 10);
  const rate = ratePerSec ?? parseInt(process.env.RATE_LIMIT_PER_SEC || "50", 10);
  const result = await (getRedis() as any).acquireBucketToken(
    RATE_BUCKET_KEY,
    cap,
    rate,
    Date.now()
  );
  return Number(result) === 1;
}

/**
 * Block until a token is granted (with capped exponential backoff +
 * jitter). Designed for the worker hot path.
 */
export async function acquireToken(): Promise<void> {
  let attempt = 0;
  while (true) {
    if (await tryAcquireToken()) return;
    attempt++;
    const base = Math.min(20 + attempt * 5, 250);
    const jitter = Math.floor(Math.random() * 50);
    await new Promise((r) => setTimeout(r, base + jitter));
  }
}

// --- Pure-function token bucket (for unit tests w/o Redis) ---

export interface BucketState {
  tokens: number;
  ts: number;
}

export function bucketStep(
  state: BucketState,
  capacity: number,
  ratePerSec: number,
  nowMs: number
): { state: BucketState; allowed: boolean } {
  const elapsed = Math.max(0, nowMs - state.ts) / 1000;
  let tokens = Math.min(capacity, state.tokens + elapsed * ratePerSec);
  let allowed = false;
  if (tokens >= 1) {
    tokens -= 1;
    allowed = true;
  }
  return { state: { tokens, ts: nowMs }, allowed };
}
