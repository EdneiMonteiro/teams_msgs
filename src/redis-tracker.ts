import Redis from "ioredis";

let client: Redis | null = null;

function getRedis(): Redis {
  if (!client) {
    const connStr = process.env.REDIS_CONNECTION || "";
    // Azure Redis connection string: host:port,password=xxx,ssl=True
    // ioredis expects: rediss://:password@host:port
    const match = connStr.match(/^(.+):(\d+),password=([^,]+)/);
    if (match) {
      client = new Redis({
        host: match[1],
        port: parseInt(match[2]),
        password: match[3],
        tls: { servername: match[1] },
      });
    } else {
      // Fallback: direct redis:// URL or localhost
      client = new Redis(connStr || "redis://localhost:6379");
    }
  }
  return client;
}

// --- Job Tracking (atomic counters) ---

function jobKey(jobId: string): string {
  return `job:${jobId}`;
}

export async function createJob(jobId: string, message: string, total: number): Promise<void> {
  const redis = getRedis();
  const key = jobKey(jobId);
  await redis.hmset(key, {
    message,
    total: total.toString(),
    sent: "0",
    failed: "0",
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    errors: "[]",
  });
  // Auto-expire after 24h
  await redis.expire(key, 86400);
}

export async function incrementSent(jobId: string): Promise<void> {
  const redis = getRedis();
  const key = jobKey(jobId);
  const [sent, failed, totalStr] = await Promise.all([
    redis.hincrby(key, "sent", 1),
    redis.hget(key, "failed"),
    redis.hget(key, "total"),
  ]);
  const total = parseInt(totalStr || "0");
  const totalProcessed = sent + parseInt(failed || "0");

  if (totalProcessed >= total) {
    await redis.hset(key, "status", "completed", "updatedAt", new Date().toISOString());
  } else {
    await redis.hset(key, "status", "processing", "updatedAt", new Date().toISOString());
  }
}

export async function incrementFailed(jobId: string, errorMsg?: string): Promise<void> {
  const redis = getRedis();
  const key = jobKey(jobId);
  const [failed, sentStr, totalStr] = await Promise.all([
    redis.hincrby(key, "failed", 1),
    redis.hget(key, "sent"),
    redis.hget(key, "total"),
  ]);
  const total = parseInt(totalStr || "0");
  const totalProcessed = parseInt(sentStr || "0") + failed;

  // Track first 50 errors
  if (errorMsg) {
    const errorsJson = await redis.hget(key, "errors") || "[]";
    const errors: string[] = JSON.parse(errorsJson);
    if (errors.length < 50) {
      errors.push(errorMsg);
      await redis.hset(key, "errors", JSON.stringify(errors));
    }
  }

  if (totalProcessed >= total) {
    await redis.hset(key, "status", "completed", "updatedAt", new Date().toISOString());
  } else {
    await redis.hset(key, "status", "processing", "updatedAt", new Date().toISOString());
  }
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

  const total = parseInt(data.total);
  const sent = parseInt(data.sent || "0");
  const failed = parseInt(data.failed || "0");

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
