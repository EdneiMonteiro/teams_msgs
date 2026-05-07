import Redis from "ioredis";

let client: Redis | null = null;

function getRedis(): Redis {
  if (!client) {
    const connStr = process.env.REDIS_CONNECTION || "";
    const match = connStr.match(/^(.+):(\d+),password=([^,]+)/);
    if (match) {
      client = new Redis({
        host: match[1],
        port: parseInt(match[2]),
        password: match[3],
        tls: { servername: match[1] },
      });
    } else {
      client = new Redis(connStr || "redis://localhost:6379");
    }
  }
  return client;
}

function jobKey(jobId: string): string {
  return `job:${jobId}`;
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
  if (sent + parseInt(failed || "0") >= total) {
    await redis.hset(key, "status", "completed", "updatedAt", new Date().toISOString());
  } else {
    await redis.hset(key, "status", "processing");
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
  if (parseInt(sentStr || "0") + failed >= total) {
    await redis.hset(key, "status", "completed", "updatedAt", new Date().toISOString());
  } else {
    await redis.hset(key, "status", "processing");
  }

  if (errorMsg) {
    const errorsJson = await redis.hget(key, "errors") || "[]";
    const errors: string[] = JSON.parse(errorsJson);
    if (errors.length < 50) {
      errors.push(errorMsg);
      await redis.hset(key, "errors", JSON.stringify(errors));
    }
  }
}
