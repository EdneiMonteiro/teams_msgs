// Copyright (c) 2026 Ednei Monteiro. Licensed under the MIT License.
// See LICENSE and DISCLAIMER.md in the project root for details.
//
// Redis é usado para 3 coisas:
//   1. Job counters atômicos (HINCRBY) — sem race condition mesmo com 10
//      workers concorrentes incrementando o mesmo job.
//   2. Index ativo de refs (SADD/SREM/SCARD) — contagem O(1) em /api/status,
//      evitando scan da Table.
//   3. Cache do payload da mensagem (1 vez por job) — workers leem do Redis
//      em vez de duplicar a mensagem em cada item do Service Bus.

import Redis from "ioredis";

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    const connStr = process.env.REDIS_CONNECTION || "";
    // Formato Azure Cache for Redis:  <host>:<port>,password=<key>,ssl=True
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
    client.on("error", (err) => {
      console.error(`[REDIS] ${err.message}`);
    });
  }
  return client;
}

// --- Keys ---
const REFS_SET = "refs:active";
const JOB_TTL_SECONDS = 86400; // 24h
function jobKey(jobId: string): string {
  return `job:${jobId}`;
}

// --- Refs index (counter rápido + set de rowKeys ativos) ---

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

export async function createJob(jobId: string, message: string, total: number): Promise<void> {
  const redis = getRedis();
  const key = jobKey(jobId);
  const now = new Date().toISOString();
  await redis.hmset(key, {
    message,
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

export interface JobStatus {
  jobId: string;
  message: string;
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
