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
function jobKey(jobId: string): string {
  return `job:${jobId}`;
}

export async function getJobMessage(jobId: string): Promise<string | null> {
  const msg = await getRedis().hget(jobKey(jobId), "message");
  return msg;
}

export async function getJobTotals(jobId: string): Promise<{ total: number; sent: number; failed: number } | null> {
  const data = await getRedis().hmget(jobKey(jobId), "total", "sent", "failed");
  if (!data[0]) return null;
  return {
    total: parseInt(data[0] || "0", 10),
    sent: parseInt(data[1] || "0", 10),
    failed: parseInt(data[2] || "0", 10),
  };
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
