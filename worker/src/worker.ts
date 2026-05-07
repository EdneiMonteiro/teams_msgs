// Copyright (c) 2026 Ednei Monteiro. Licensed under the MIT License.
// See LICENSE and DISCLAIMER.md in the project root for details.

import {
  ServiceBusClient,
  ServiceBusReceivedMessage,
  ProcessErrorArgs,
} from "@azure/service-bus";
import {
  BotFrameworkAdapter,
  CardFactory,
  ConversationReference,
  MessageFactory,
  TurnContext,
} from "botbuilder";
import {
  incrementSent,
  incrementFailed,
  getJobMessage,
  acquireToken,
  ResolvedMessage,
} from "./redis-tracker";
import { removeRefByRowKey } from "./table-store";

interface QueueMessage {
  jobId: string;
  refJson: string;
  rowKey: string;
  // Compat: mensagens antigas podiam carregar texto inline
  message?: string;
}

const SB_CONNECTION = process.env.SERVICE_BUS_CONNECTION || "";
const QUEUE_NAME = process.env.QUEUE_NAME || "send-messages";
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "10", 10);
const RATE_LIMIT_ENABLED =
  (process.env.RATE_LIMIT_ENABLED || "true").toLowerCase() === "true";

const adapter = new BotFrameworkAdapter({
  appId: process.env.MICROSOFT_APP_ID || "",
  appPassword: process.env.MICROSOFT_APP_PASSWORD || "",
  channelAuthTenant: process.env.MICROSOFT_APP_TENANT_ID || "",
});

adapter.onTurnError = async (_ctx, error) => {
  console.error(`[BOT ERRO] ${error.message}`);
};

// Cache em memória do payload (1 leitura no Redis por job).
const messageCache = new Map<string, { msg: ResolvedMessage; expiresAt: number }>();
const MESSAGE_CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveMessage(body: QueueMessage): Promise<ResolvedMessage> {
  if (body.message) return { type: "text", serialized: body.message };
  const cached = messageCache.get(body.jobId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.msg;
  const msg = await getJobMessage(body.jobId);
  if (!msg) {
    throw new Error(`Job ${body.jobId} não encontrado no Redis (expirou?)`);
  }
  messageCache.set(body.jobId, { msg, expiresAt: now + MESSAGE_CACHE_TTL_MS });
  return msg;
}

async function deliver(
  ctx: TurnContext,
  msg: ResolvedMessage
): Promise<void> {
  if (msg.type === "text") {
    await ctx.sendActivity(msg.serialized);
    return;
  }
  // card: parsed do JSON serializado
  let parsed: any;
  try {
    parsed = JSON.parse(msg.serialized);
  } catch (err: any) {
    throw new Error(`AdaptiveCard inválido: ${err.message}`);
  }
  const cardContent = parsed?.content;
  if (!cardContent) {
    throw new Error(`AdaptiveCard sem 'content'`);
  }
  const card = CardFactory.adaptiveCard(cardContent);
  await ctx.sendActivity(MessageFactory.attachment(card));
}

let processedCount = 0;
let errorCount = 0;
let throttledCount = 0;
const startTime = Date.now();

function logStats(): void {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  const rate =
    processedCount > 0
      ? (processedCount / ((Date.now() - startTime) / 60000)).toFixed(1)
      : "0";
  console.log(
    `📊 [${elapsed}s] sent=${processedCount} err=${errorCount} 429s=${throttledCount} rate=${rate} msg/min`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface SendOutcome {
  ok: boolean;
  permanent?: boolean;
  statusCode?: number;
  errorMsg?: string;
}

async function sendOnce(
  ref: ConversationReference,
  msg: ResolvedMessage
): Promise<SendOutcome> {
  const RETRIES = 3;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      // Token bucket global — bloqueia até obter permissão
      if (RATE_LIMIT_ENABLED) {
        await acquireToken();
      }
      await adapter.continueConversation(ref, async (ctx: TurnContext) => {
        await deliver(ctx, msg);
      });
      return { ok: true };
    } catch (err: any) {
      const status = err.statusCode || 0;

      if (status === 429 && attempt < RETRIES) {
        throttledCount++;
        const retryAfter = err.headers?.["retry-after"]
          ? parseInt(err.headers["retry-after"], 10) * 1000
          : 1000 * Math.pow(2, attempt);
        console.warn(`⏳ 429 throttle, retry #${attempt} em ${retryAfter}ms`);
        await sleep(retryAfter);
        continue;
      }

      if (status >= 500 && attempt < RETRIES) {
        const backoff = 500 * Math.pow(2, attempt);
        console.warn(`⚠️ ${status}, retry #${attempt} em ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      if (status === 403 || status === 410) {
        return {
          ok: false,
          permanent: true,
          statusCode: status,
          errorMsg:
            status === 403
              ? "Usuário bloqueou/desinstalou o bot"
              : "Conversa não existe mais (410)",
        };
      }

      if (status >= 400 && status < 500) {
        return {
          ok: false,
          permanent: true,
          statusCode: status,
          errorMsg: err.message || `HTTP ${status}`,
        };
      }

      return {
        ok: false,
        permanent: false,
        statusCode: status,
        errorMsg: err.message || String(err),
      };
    }
  }
  return { ok: false, permanent: false, errorMsg: "Max retries exceeded" };
}

async function processMessage(msg: ServiceBusReceivedMessage): Promise<void> {
  const body = msg.body as QueueMessage;
  if (!body || !body.jobId || !body.refJson) {
    console.error(`[WORKER] Mensagem inválida (sem jobId/refJson)`);
    return;
  }

  let ref: ConversationReference;
  try {
    ref = JSON.parse(body.refJson) as ConversationReference;
  } catch (err: any) {
    errorCount++;
    await incrementFailed(body.jobId, `refJson inválido: ${err.message}`).catch(() => {});
    return;
  }

  let resolved: ResolvedMessage;
  try {
    resolved = await resolveMessage(body);
  } catch (err: any) {
    errorCount++;
    await incrementFailed(body.jobId, err.message || String(err)).catch(() => {});
    return;
  }

  const outcome = await sendOnce(ref, resolved);

  if (outcome.ok) {
    await incrementSent(body.jobId);
    processedCount++;
    return;
  }

  errorCount++;

  if (outcome.statusCode === 403 || outcome.statusCode === 410) {
    await removeRefByRowKey(body.rowKey).catch((err) =>
      console.warn(`[WORKER] removeRefByRowKey: ${err.message || err}`)
    );
  }

  await incrementFailed(body.jobId, outcome.errorMsg);
  console.error(`❌ ${outcome.errorMsg}`);

  if (!outcome.permanent) {
    throw new Error(outcome.errorMsg || "Transient error");
  }
}

async function processError(args: ProcessErrorArgs): Promise<void> {
  console.error(`[SERVICE BUS ERRO] ${args.error.message}`);
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
  console.log(`  Rate limit:   ${RATE_LIMIT_ENABLED ? "ENABLED" : "DISABLED"}`);
  if (RATE_LIMIT_ENABLED) {
    console.log(`    capacity:   ${process.env.RATE_LIMIT_CAPACITY || "50"}`);
    console.log(`    per sec:    ${process.env.RATE_LIMIT_PER_SEC || "50"}`);
  }
  console.log(`  Bot App ID:   ${(process.env.MICROSOFT_APP_ID || "").substring(0, 8)}...`);
  console.log("=".repeat(50));

  const sbClient = new ServiceBusClient(SB_CONNECTION);
  const receiver = sbClient.createReceiver(QUEUE_NAME, {
    maxAutoLockRenewalDurationInMs: 300000,
  });

  receiver.subscribe(
    {
      processMessage: async (m) => {
        await processMessage(m);
      },
      processError,
    },
    {
      maxConcurrentCalls: MAX_CONCURRENT,
      autoCompleteMessages: true,
    }
  );

  setInterval(logStats, 30000);
  console.log(`\n🚀 Worker iniciado, aguardando mensagens...\n`);

  const shutdown = async () => {
    console.log("\n🛑 Encerrando worker...");
    logStats();
    try {
      await receiver.close();
      await sbClient.close();
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
