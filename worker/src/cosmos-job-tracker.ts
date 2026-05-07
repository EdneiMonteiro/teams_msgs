import { CosmosClient, Container } from "@azure/cosmos";

const DB_NAME = "teamsmsgs";
let client: CosmosClient | null = null;

function getClient(): CosmosClient {
  if (!client) {
    client = new CosmosClient(process.env.COSMOS_CONNECTION || "");
  }
  return client;
}

function getJobsContainer(): Container {
  return getClient().database(DB_NAME).container("jobs");
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
      const { resource: job } = await container.item(jobId, "jobs").read();
      if (!job) return;

      const etag = job._etag || "";

      if (success) {
        job.sent = (job.sent || 0) + 1;
      } else {
        job.failed = (job.failed || 0) + 1;
        if ((job.errors?.length || 0) < 50) {
          job.errors = job.errors || [];
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
      if (err.code === 412 && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 20 * attempt));
        continue;
      }
      console.error(`[JOB] Falha ao atualizar job ${jobId} (attempt ${attempt}):`, err.message || err);
    }
  }
}
