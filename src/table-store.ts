import { TableClient, TableEntity } from "@azure/data-tables";

function getStorageConnection(): string {
  return process.env.STORAGE_CONNECTION || "";
}

export interface ConversationRef extends TableEntity {
  partitionKey: string; // "refs"
  rowKey: string; // conversationId (base64-safe)
  refJson: string; // serialized ConversationReference
}

export interface JobEntity extends TableEntity {
  partitionKey: string; // "jobs"
  rowKey: string; // jobId
  message: string;
  total: number;
  sent: number;
  failed: number;
  status: string; // queued | processing | completed | failed
  createdAt: string;
  updatedAt: string;
  errors: string; // JSON array of first N errors
}

function getRefsTable(): TableClient {
  return TableClient.fromConnectionString(getStorageConnection(), "conversationrefs");
}

function getJobsTable(): TableClient {
  return TableClient.fromConnectionString(getStorageConnection(), "jobs");
}

// Ensure tables exist
let tablesCreated = false;
export async function ensureTables(): Promise<void> {
  if (tablesCreated) return;
  await getRefsTable().createTable().catch(() => {});
  await getJobsTable().createTable().catch(() => {});
  tablesCreated = true;
}

// --- Conversation References ---

function safeRowKey(id: string): string {
  return Buffer.from(id).toString("base64url");
}

export async function saveRef(conversationId: string, refJson: string): Promise<void> {
  await ensureTables();
  const entity: ConversationRef = {
    partitionKey: "refs",
    rowKey: safeRowKey(conversationId),
    refJson,
  };
  await getRefsTable().upsertEntity(entity, "Replace");
}

export async function removeRef(conversationId: string): Promise<void> {
  await ensureTables();
  try {
    await getRefsTable().deleteEntity("refs", safeRowKey(conversationId));
  } catch {}
}

export async function getAllRefs(): Promise<string[]> {
  await ensureTables();
  const refs: string[] = [];
  const iter = getRefsTable().listEntities<ConversationRef>({
    queryOptions: { filter: "PartitionKey eq 'refs'" },
  });
  for await (const entity of iter) {
    refs.push(entity.refJson);
  }
  return refs;
}

export async function countRefs(): Promise<number> {
  const refs = await getAllRefs();
  return refs.length;
}

// --- Jobs ---

export async function createJob(jobId: string, message: string, total: number): Promise<void> {
  await ensureTables();
  const entity: JobEntity = {
    partitionKey: "jobs",
    rowKey: jobId,
    message,
    total,
    sent: 0,
    failed: 0,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    errors: "[]",
  };
  await getJobsTable().upsertEntity(entity, "Replace");
}

export async function getJob(jobId: string): Promise<JobEntity | null> {
  await ensureTables();
  try {
    return await getJobsTable().getEntity<JobEntity>("jobs", jobId);
  } catch {
    return null;
  }
}

export async function incrementJobProgress(
  jobId: string,
  success: boolean,
  errorMsg?: string
): Promise<void> {
  await ensureTables();
  const job = await getJob(jobId);
  if (!job) return;

  if (success) {
    job.sent = (job.sent || 0) + 1;
  } else {
    job.failed = (job.failed || 0) + 1;
    const errors: string[] = JSON.parse(job.errors || "[]");
    if (errors.length < 50) {
      errors.push(errorMsg || "unknown");
      job.errors = JSON.stringify(errors);
    }
  }

  const totalProcessed = (job.sent || 0) + (job.failed || 0);
  if (totalProcessed >= job.total) {
    job.status = "completed";
  } else if (job.status === "queued") {
    job.status = "processing";
  }

  job.updatedAt = new Date().toISOString();
  await getJobsTable().upsertEntity(job, "Replace");
}
