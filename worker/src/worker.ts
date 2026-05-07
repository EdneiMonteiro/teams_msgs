// Copyright (c) 2026 Ednei Monteiro. Licensed under the MIT License.
// See LICENSE and DISCLAIMER.md in the project root for details.
import { ServiceBusClient, ServiceBusReceivedMessage, ProcessErrorArgs } from "@azure/service-bus";
import { BotFrameworkAdapter, ConversationReference, TurnContext } from "botbuilder";
import { incrementSent, incrementFailed } from "./redis-tracker";

interface QueueMessage {
  jobId: string;
  refJson: string;
  message: string;
}

const SB_CONNECTION = process.env.SERVICE_BUS_CONNECTION || "";
const QUEUE_NAME = process.env.QUEUE_NAME || "send-messages";
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "10");

// Bot Framework adapter (singleton, reutiliza token)
const adapter = new BotFrameworkAdapter({
  appId: process.env.MICROSOFT_APP_ID || "",
  appPassword: process.env.MICROSOFT_APP_PASSWORD || "",
  channelAuthTenant: process.env.MICROSOFT_APP_TENANT_ID || "",
});

adapter.onTurnError = async (_context, error) => {
  console.error(`[BOT ERRO] ${error.message}`);
};

let processedCount = 0;
let errorCount = 0;
const startTime = Date.now();

function logStats(): void {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  const rate = processedCount > 0 ? (processedCount / ((Date.now() - startTime) / 60000)).toFixed(1) : "0";
  console.log(`📊 [${elapsed}s] Processados: ${processedCount} | Erros: ${errorCount} | Rate: ${rate} msg/min`);
}

async function sendWithRetry(
  ref: ConversationReference,
  message: string,
  retries = 3
): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await adapter.continueConversation(ref, async (context: TurnContext) => {
        await context.sendActivity(message);
      });
      return;
    } catch (err: any) {
      const status = err.statusCode || 0;

      if (status === 429 && attempt < retries) {
        const retryAfter = err.headers?.["retry-after"]
          ? parseInt(err.headers["retry-after"]) * 1000
          : 1000 * Math.pow(2, attempt);
        console.warn(`⏳ Throttled, retry #${attempt} em ${retryAfter}ms`);
        await sleep(retryAfter);
        continue;
      }

      if (status >= 500 && attempt < retries) {
        const backoff = 500 * Math.pow(2, attempt);
        console.warn(`⚠️ Server ${status}, retry #${attempt} em ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      throw err;
    }
  }
}

async function processMessage(msg: ServiceBusReceivedMessage): Promise<void> {
  const body = msg.body as QueueMessage;
  const { jobId, refJson, message } = body;

  try {
    const ref = JSON.parse(refJson) as ConversationReference;
    await sendWithRetry(ref, message);
    await incrementSent(jobId);
    processedCount++;
  } catch (err: any) {
    errorCount++;
    const errorMsg = err.statusCode === 403
      ? "Usuário bloqueou/desinstalou o bot"
      : err.message || String(err);
    await incrementFailed(jobId, errorMsg);
    console.error(`❌ ${errorMsg}`);

    // 403 = não faz retry, completar a mensagem
    if (err.statusCode === 403) return;

    // Outros erros: throw para Service Bus fazer retry/dead-letter
    throw err;
  }
}

async function processError(args: ProcessErrorArgs): Promise<void> {
  console.error(`[SERVICE BUS ERRO] ${args.error.message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function startWorker(): Promise<void> {
  if (!SB_CONNECTION) {
    console.error("❌ SERVICE_BUS_CONNECTION não configurada");
    process.exit(1);
  }

  console.log("=".repeat(50));
  console.log("  TEAMS MESSAGING WORKER");
  console.log("=".repeat(50));
  console.log(`  Queue:        ${QUEUE_NAME}`);
  console.log(`  Concurrency:  ${MAX_CONCURRENT}`);
  console.log(`  Bot App ID:   ${process.env.MICROSOFT_APP_ID?.substring(0, 8)}...`);
  console.log("=".repeat(50));

  const sbClient = new ServiceBusClient(SB_CONNECTION);
  const receiver = sbClient.createReceiver(QUEUE_NAME, {
    maxAutoLockRenewalDurationInMs: 300000, // 5 min
  });

  receiver.subscribe(
    {
      processMessage: async (msg) => {
        await processMessage(msg);
      },
      processError,
    },
    {
      maxConcurrentCalls: MAX_CONCURRENT,
      autoCompleteMessages: true,
    }
  );

  // Log stats a cada 30s
  setInterval(logStats, 30000);

  console.log(`\n🚀 Worker iniciado, aguardando mensagens...\n`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n🛑 Encerrando worker...");
    logStats();
    await receiver.close();
    await sbClient.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
