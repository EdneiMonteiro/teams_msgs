import { CosmosClient, Container } from "@azure/cosmos";

function getCosmosConnection(): string {
  return process.env.COSMOS_CONNECTION || "";
}

const DB_NAME = "teamsmsgs";
let client: CosmosClient | null = null;

function getClient(): CosmosClient {
  if (!client) {
    client = new CosmosClient(getCosmosConnection());
  }
  return client;
}

function getRefsContainer(): Container {
  return getClient().database(DB_NAME).container("refs");
}

function getJobsContainer(): Container {
  return getClient().database(DB_NAME).container("jobs");
}

// --- Conversation References ---

export async function saveRef(conversationId: string, refJson: string): Promise<void> {
  const container = getRefsContainer();
  await container.items.upsert({
    id: Buffer.from(conversationId).toString("base64url"),
    pk: "refs",
    conversationId,
    refJson,
  });
}

export async function removeRef(conversationId: string): Promise<void> {
  const container = getRefsContainer();
  const id = Buffer.from(conversationId).toString("base64url");
  try {
    await container.item(id, "refs").delete();
  } catch {}
}

export async function getAllRefs(): Promise<string[]> {
  const container = getRefsContainer();
  const { resources } = await container.items
    .query({ query: "SELECT c.refJson FROM c WHERE c.pk = 'refs'" })
    .fetchAll();
  return resources.map((r: any) => r.refJson);
}

export async function countRefs(): Promise<number> {
  const container = getRefsContainer();
  const { resources } = await container.items
    .query({ query: "SELECT VALUE COUNT(1) FROM c WHERE c.pk = 'refs'" })
    .fetchAll();
  return resources[0] || 0;
}

// --- Jobs ---

export interface JobDoc {
  id: string;
  pk: string;
  message: string;
  total: number;
  sent: number;
  failed: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  errors: string[];
  _etag?: string;
}

export async function createJob(jobId: string, message: string, total: number): Promise<void> {
  const container = getJobsContainer();
  await container.items.upsert({
    id: jobId,
    pk: "jobs",
    message,
    total,
    sent: 0,
    failed: 0,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    errors: [],
  });
}

export async function getJob(jobId: string): Promise<JobDoc | null> {
  const container = getJobsContainer();
  try {
    const { resource } = await container.item(jobId, "jobs").read<JobDoc>();
    return resource || null;
  } catch {
    return null;
  }
}

export async function incrementJobProgress(
  jobId: string,
  success: boolean,
  errorMsg?: string
): Promise<void> {
  const container = getJobsContainer();
  const MAX_RETRIES = 5;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { resource: job, headers } = await container.item(jobId, "jobs").read<JobDoc>();
      if (!job) return;

      const etag = job._etag || "";

      if (success) {
        job.sent = (job.sent || 0) + 1;
      } else {
        job.failed = (job.failed || 0) + 1;
        if (job.errors.length < 50) {
          job.errors.push(errorMsg || "unknown");
        }
      }

      const totalProcessed = (job.sent || 0) + (job.failed || 0);
      if (totalProcessed >= job.total) {
        job.status = "completed";
      } else if (job.status === "queued") {
        job.status = "processing";
      }

      job.updatedAt = new Date().toISOString();

      await container.item(jobId, "jobs").replace(job, {
        accessCondition: { type: "IfMatch", condition: etag },
      });
      return;
    } catch (err: any) {
      // 412 = ETag mismatch, retry
      if (err.code === 412 && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 20 * attempt));
        continue;
      }
      console.error(`[JOB] Falha ao atualizar job ${jobId} (attempt ${attempt}):`, err.message || err);
    }
  }
}

// --- Seed fake refs for load testing ---

export async function seedFakeRefs(count: number, realRefs: string[]): Promise<number> {
  const container = getRefsContainer();
  let created = 0;

  // Keep real refs, add fake ones
  for (let i = 0; i < count; i++) {
    // Clone a real ref but change the conversation ID
    const baseRef = JSON.parse(realRefs[i % realRefs.length]);
    const fakeId = `fake-${i}-${Date.now()}`;
    baseRef.conversation = { ...baseRef.conversation, id: fakeId };

    await container.items.upsert({
      id: Buffer.from(fakeId).toString("base64url"),
      pk: "refs",
      conversationId: fakeId,
      refJson: JSON.stringify(baseRef),
    });
    created++;

    if (created % 1000 === 0) {
      console.log(`  Seeded ${created}/${count} fake refs...`);
    }
  }
  return created;
}

export async function clearFakeRefs(): Promise<number> {
  const container = getRefsContainer();
  const { resources } = await container.items
    .query({ query: "SELECT c.id, c.conversationId FROM c WHERE c.pk = 'refs' AND STARTSWITH(c.conversationId, 'fake-')" })
    .fetchAll();

  let deleted = 0;
  for (const r of resources) {
    await container.item(r.id, "refs").delete();
    deleted++;
  }
  return deleted;
}

// Ensure tables exist (no-op for Cosmos, kept for API compatibility)
export async function ensureTables(): Promise<void> {}
