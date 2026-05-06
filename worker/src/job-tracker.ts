import { TableClient, TableEntity } from "@azure/data-tables";

export interface JobEntity extends TableEntity {
  partitionKey: string;
  rowKey: string;
  message: string;
  total: number;
  sent: number;
  failed: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  errors: string;
}

function getStorageConnection(): string {
  return process.env.STORAGE_CONNECTION || "";
}

function getJobsTable(): TableClient {
  return TableClient.fromConnectionString(getStorageConnection(), "jobs");
}

let tableCreated = false;
async function ensureTable(): Promise<void> {
  if (tableCreated) return;
  await getJobsTable().createTable().catch(() => {});
  tableCreated = true;
}

export async function incrementJobProgress(
  jobId: string,
  success: boolean,
  errorMsg?: string
): Promise<void> {
  await ensureTable();
  const table = getJobsTable();
  const MAX_RETRIES = 5;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const job = await table.getEntity<JobEntity>("jobs", jobId);
      const etag = job.etag || "*";

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

      // Optimistic concurrency: só grava se o ETag não mudou
      await table.updateEntity(job, "Replace", { etag });
      return;
    } catch (err: any) {
      // 412 = ETag mismatch (outra instância atualizou primeiro), retry
      if (err.statusCode === 412 && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 50 * attempt));
        continue;
      }
      console.error(`[JOB] Falha ao atualizar job ${jobId} (attempt ${attempt}):`, err.message || err);
    }
  }
}
