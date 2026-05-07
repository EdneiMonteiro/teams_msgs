// Copyright (c) 2026 Ednei Monteiro. Licensed under the MIT License.
// See LICENSE and DISCLAIMER.md in the project root for details.
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

const REFS_SET = "refs:active";
const RATE_BUCKET_KEY = process.env.RATE_LIMIT_KEY || "ratelimit:bot";

function jobKey(jobId: string): string {
  return `job:${jobId}`;
}

export type MessageType = "text" | "card";

export interface ResolvedMessage {
  type: MessageType;
  serialized: string;
}

export async function getJobMessage(jobId: string): Promise<ResolvedMessage | null> {
  const data = await getRedis().hmget(jobKey(jobId), "message", "messageType");
  if (!data[0]) return null;
  const type = (data[1] as MessageType) || "text";
  return { type, serialized: data[0] };
}

export async function incrementSent(jobId: string): Promise<void> {
  const redis = getRedis();
  const key = jobKey(jobId);
  const [sent, failed, totalStr] = await Promise.all([
    redis.hincrby(key, "sent", 1),
    redis.hget(key, "failed"),
    redis.hget(key, "total"),
  ]);
  const total = parseInt(totalStr || "0", 10);
  const totalProcessed = sent + parseInt(failed || "0", 10);
  const status = totalProcessed >= total ? "completed" : "processing";
  await redis.hset(key, "status", status, "updatedAt", new Date().toISOString());
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

export async function refsRemove(rowKey: string): Promise<void> {
  await getRedis().srem(REFS_SET, rowKey);
}

// --- Token Bucket (idêntico ao da API) ---

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
  if (!(redis as any).acquireBucketToken) {
    redis.defineCommand("acquireBucketToken", {
      numberOfKeys: 1,
      lua: TOKEN_BUCKET_LUA,
    });
  }
  bucketScriptLoaded = true;
}

export async function tryAcquireToken(): Promise<boolean> {
  await ensureBucketScript();
  const cap = parseInt(process.env.RATE_LIMIT_CAPACITY || "50", 10);
  const rate = parseInt(process.env.RATE_LIMIT_PER_SEC || "50", 10);
  const result = await (getRedis() as any).acquireBucketToken(
    RATE_BUCKET_KEY,
    cap,
    rate,
    Date.now()
  );
  return Number(result) === 1;
}

/**
 * Acquire 1 token, sleeping with backoff+jitter until granted.
 * Used by worker before each Bot Framework call.
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
