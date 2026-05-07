// Copyright (c) 2026 Ednei Monteiro. Licensed under the MIT License.
// See LICENSE and DISCLAIMER.md in the project root for details.

import express, { NextFunction, Request, Response } from "express";
import { BotFrameworkAdapter } from "botbuilder";
import {
  ServiceBusClient,
  ServiceBusMessage,
  ServiceBusMessageBatch,
  ServiceBusSender,
} from "@azure/service-bus";
import { v4 as uuidv4 } from "uuid";
import { createHash, timingSafeEqual } from "crypto";
import * as dotenv from "dotenv";

import { ProactiveBot } from "./bot";
import {
  saveRef,
  removeRef,
  streamRefs,
  ensureTables,
  pingStorage,
} from "./table-store";
import {
  createJob,
  getJob,
  setJobStatus,
  updateJobTotal,
  incrementFailed,
  refsCount,
  pingRedis,
} from "./redis-tracker";
import { validateMessage } from "./validate-message";

dotenv.config();

const PORT = parseInt(process.env.PORT || "3978", 10);
const APP_ID = process.env.MICROSOFT_APP_ID || "";
const APP_PASSWORD = process.env.MICROSOFT_APP_PASSWORD || "";
const APP_TENANT = process.env.MICROSOFT_APP_TENANT_ID || "";
const SB_CONNECTION = process.env.SERVICE_BUS_CONNECTION || "";
const QUEUE_NAME = process.env.QUEUE_NAME || "send-messages";
const API_KEY = process.env.API_KEY || "";
const FLUSH_CONCURRENCY = parseInt(process.env.SEND_FLUSH_CONCURRENCY || "5", 10);

// --- Bot Framework ---

const adapter = new BotFrameworkAdapter({
  appId: APP_ID,
  appPassword: APP_PASSWORD,
  channelAuthTenant: APP_TENANT,
});

adapter.onTurnError = async (context, error) => {
  console.error(`[BOT ERRO] ${error.message}`);
  if (context.activity?.type === "message" && context.activity?.replyToId) {
    await context.sendActivity("Ocorreu um erro. Tente novamente.");
  }
};

const bot = new ProactiveBot({
  save: async (ref) => {
    const id = ref.conversation?.id;
    if (!id) return;
    await saveRef(id, JSON.stringify(ref));
    console.log(`[BOT] Ref salva: ${id.substring(0, 30)}...`);
  },
  remove: async (id) => {
    await removeRef(id);
    console.log(`[BOT] Ref removida: ${id.substring(0, 30)}...`);
  },
});

// --- Service Bus ---

const sbClient = SB_CONNECTION ? new ServiceBusClient(SB_CONNECTION) : null;

// --- App ---

const app = express();
// Adaptive Cards podem ser grandes; aumento para 1MB.
app.use(express.json({ limit: "1mb" }));

app.post("/api/messages", async (req: Request, res: Response) => {
  await adapter.processActivity(req, res, async (context) => {
    await bot.run(context);
  });
});

// --- Auth middleware ---

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY) {
    return next();
  }
  const headerKey = req.header("x-api-key") || "";
  if (!safeCompare(headerKey, API_KEY)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// --- Message validation (text or Adaptive Card) ---

// Implementação em ./validate-message para permitir testes unitários

// --- Parallel batch flushing ---

async function flushQueue(
  sender: ServiceBusSender,
  pending: ServiceBusMessageBatch,
  inFlight: Set<Promise<void>>,
  concurrency: number
): Promise<{ count: number }> {
  if (pending.count === 0) return { count: 0 };
  while (inFlight.size >= concurrency) {
    await Promise.race(inFlight);
  }
  const count = pending.count;
  const send = sender.sendMessages(pending);
  const tracked: Promise<void> = send
    .then(() => undefined)
    .finally(() => inFlight.delete(tracked));
  inFlight.add(tracked);
  return { count };
}

// --- POST /api/send (assíncrono, streaming + parallel) ---

app.post("/api/send", requireApiKey, async (req: Request, res: Response) => {
  const validation = validateMessage(req.body?.message);
  if ("error" in validation) {
    return res.status(400).json({ error: validation.error });
  }
  const repeatCount = Math.max(
    1,
    Math.min(parseInt(String(req.body?.repeat || 1), 10) || 1, 100000)
  );

  if (!sbClient) {
    return res.status(503).json({ error: "SERVICE_BUS_CONNECTION não configurada" });
  }

  // Total estimado pelo index do Redis (O(1)). Se houver drift com a Table,
  // a gente reconcilia abaixo após o stream.
  const estimatedRefCount = await refsCount();
  if (estimatedRefCount === 0) {
    return res.status(409).json({
      error: "Nenhum usuário registrado. Instale o Teams app primeiro.",
    });
  }

  const jobId = uuidv4();
  const estimatedTotal = estimatedRefCount * repeatCount;
  await createJob(jobId, validation.serialized, estimatedTotal, validation.type);

  const sender = sbClient.createSender(QUEUE_NAME);
  const inFlight = new Set<Promise<void>>();
  let enqueued = 0;
  let drops = 0;
  let refsSeen = 0;

  try {
    let batch = await sender.createMessageBatch();

    for await (const ref of streamRefs()) {
      refsSeen++;
      const refHash = createHash("md5").update(ref.rowKey).digest("hex");

      for (let r = 0; r < repeatCount; r++) {
        const sbMessage: ServiceBusMessage = {
          body: { jobId, refJson: ref.refJson, rowKey: ref.rowKey },
          contentType: "application/json",
          messageId: `${jobId}:${refHash}:${r}`,
        };

        if (!batch.tryAddMessage(sbMessage)) {
          // Batch atual cheio → manda para flush e abre novo
          const flushed = await flushQueue(sender, batch, inFlight, FLUSH_CONCURRENCY);
          enqueued += flushed.count;
          batch = await sender.createMessageBatch();

          if (!batch.tryAddMessage(sbMessage)) {
            // Mensagem isolada > limite do batch (256KB SB Basic)
            drops++;
            console.error(
              `[SEND] msg ${ref.rowKey}#${r} excede limite do batch (drop)`
            );
          }
        }
      }
    }

    // último batch
    const flushed = await flushQueue(sender, batch, inFlight, FLUSH_CONCURRENCY);
    enqueued += flushed.count;
    await Promise.all(inFlight);
  } catch (err: any) {
    console.error(`[SEND] Falha durante fan-out: ${err.message || err}`);
    await setJobStatus(jobId, "failed").catch(() => {});
    return res
      .status(503)
      .json({ error: `Falha ao enfileirar mensagens: ${err.message || err}` });
  } finally {
    await sender.close().catch(() => {});
  }

  // Reconcilia: se a Table tem N refs e o Redis tinha M, ajusta total
  const actualTotal = refsSeen * repeatCount;
  if (actualTotal !== estimatedTotal) {
    console.warn(
      `[SEND] Drift refs Table=${refsSeen} Redis=${estimatedRefCount} → ajustando total`
    );
    await updateJobTotal(jobId, actualTotal);
  }

  // Drops: marca como falha pra preservar invariant total = sent + failed
  for (let i = 0; i < drops; i++) {
    await incrementFailed(jobId, "Mensagem excede limite do batch (>256KB)");
  }

  await setJobStatus(jobId, "processing");
  console.log(
    `🚀 Job ${jobId}: ${enqueued} enfileiradas, ${drops} drops (refs=${refsSeen}, repeat=${repeatCount})`
  );

  res.status(202).json({
    jobId,
    refs: refsSeen,
    repeat: repeatCount,
    total: actualTotal,
    enqueued,
    drops,
    messageType: validation.type,
    status: "queued",
    statusUrl: `/api/jobs/${jobId}`,
  });
});

// --- GET /api/jobs/:id ---

app.get("/api/jobs/:id", requireApiKey, async (req: Request, res: Response) => {
  const job = await getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job não encontrado" });
  }
  res.json(job);
});

// --- GET /api/status ---

app.get("/api/status", requireApiKey, async (_req: Request, res: Response) => {
  const count = await refsCount();
  res.json({
    registeredUsers: count,
    status: "running",
    mode: "queue",
    queue: QUEUE_NAME,
  });
});

// --- Health probes ---

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/readyz", async (_req: Request, res: Response) => {
  const [redisOk, storageOk] = await Promise.all([pingRedis(), pingStorage()]);
  const ok = redisOk && storageOk && !!sbClient;
  res.status(ok ? 200 : 503).json({
    redis: redisOk,
    storage: storageOk,
    serviceBus: !!sbClient,
  });
});

// --- Bootstrap ---

app.listen(PORT, async () => {
  await ensureTables();
  console.log("\n🤖 Teams Proactive Messaging API");
  console.log(`   Listening on http://localhost:${PORT}`);
  console.log(`   POST /api/messages   → Bot Framework endpoint`);
  console.log(`   POST /api/send       → Enfileira (text/AdaptiveCard, x-api-key)`);
  console.log(`   GET  /api/jobs/:id   → Progresso do job`);
  console.log(`   GET  /api/status     → Contagem de usuários`);
  console.log(`   GET  /healthz        → Liveness`);
  console.log(`   GET  /readyz         → Readiness (Redis + Storage)`);
  console.log(`   Flush concurrency:   ${FLUSH_CONCURRENCY}`);
  if (!API_KEY) {
    console.warn("   ⚠️  API_KEY vazia: /api/send está SEM autenticação (modo dev).\n");
  } else {
    console.log("   🔒 API_KEY configurada\n");
  }
});
