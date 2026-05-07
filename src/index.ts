// Copyright (c) 2026 Ednei Monteiro. Licensed under the MIT License.
// See LICENSE and DISCLAIMER.md in the project root for details.
//
// API server (ACA, ingress externo). Responsabilidades:
//  - /api/messages   → endpoint do Bot Framework (recebe eventos do Teams)
//  - /api/send       → enfileira N mensagens no Service Bus (auth: x-api-key)
//  - /api/jobs/:id   → progresso do job (Redis)
//  - /api/status     → contagem de usuários registrados
//  - /healthz        → liveness
//  - /readyz         → readiness (Redis + Storage)

import express, { NextFunction, Request, Response } from "express";
import { BotFrameworkAdapter } from "botbuilder";
import { ServiceBusClient, ServiceBusMessage } from "@azure/service-bus";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "crypto";
import * as dotenv from "dotenv";

import { ProactiveBot } from "./bot";
import {
  saveRef,
  removeRef,
  getAllRefs,
  ensureTables,
  pingStorage,
  safeRowKey,
} from "./table-store";
import {
  createJob,
  getJob,
  setJobStatus,
  refsCount,
  pingRedis,
} from "./redis-tracker";

dotenv.config();

const PORT = parseInt(process.env.PORT || "3978", 10);
const APP_ID = process.env.MICROSOFT_APP_ID || "";
const APP_PASSWORD = process.env.MICROSOFT_APP_PASSWORD || "";
const APP_TENANT = process.env.MICROSOFT_APP_TENANT_ID || "";
const SB_CONNECTION = process.env.SERVICE_BUS_CONNECTION || "";
const QUEUE_NAME = process.env.QUEUE_NAME || "send-messages";
const API_KEY = process.env.API_KEY || "";

// --- Bot Framework ---

const adapter = new BotFrameworkAdapter({
  appId: APP_ID,
  appPassword: APP_PASSWORD,
  channelAuthTenant: APP_TENANT,
});

adapter.onTurnError = async (context, error) => {
  console.error(`[BOT ERRO] ${error.message}`);
  // Só responde para mensagens reais; nunca em envios proativos.
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
app.use(express.json({ limit: "256kb" }));

// Bot Framework endpoint — auth via Bot Framework token, NÃO usa x-api-key.
app.post("/api/messages", async (req: Request, res: Response) => {
  await adapter.processActivity(req, res, async (context) => {
    await bot.run(context);
  });
});

// --- Auth middleware (apenas para endpoints administrativos) ---

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY) {
    // Sem API_KEY configurada → modo dev local (logs warning ao iniciar).
    return next();
  }
  const headerKey = req.header("x-api-key") || "";
  if (headerKey !== API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// --- POST /api/send (assíncrono) ---

app.post("/api/send", requireApiKey, async (req: Request, res: Response) => {
  const { message, repeat } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Campo 'message' (string) é obrigatório" });
  }
  // repeat: número de cópias por usuário (default 1; cap 100k para segurança)
  const repeatCount = Math.max(1, Math.min(parseInt(String(repeat || 1), 10) || 1, 100000));

  if (!sbClient) {
    return res.status(503).json({ error: "SERVICE_BUS_CONNECTION não configurada" });
  }

  let refs: { rowKey: string; refJson: string }[];
  try {
    refs = await getAllRefs();
  } catch (err: any) {
    console.error(`[SEND] Falha ao listar refs: ${err.message || err}`);
    return res.status(503).json({ error: "Falha ao acessar Storage" });
  }

  if (refs.length === 0) {
    return res.status(409).json({
      error: "Nenhum usuário registrado. Instale o Teams app primeiro.",
    });
  }

  const jobId = uuidv4();
  const totalMessages = refs.length * repeatCount;
  await createJob(jobId, message, totalMessages);

  const sender = sbClient.createSender(QUEUE_NAME);
  let enqueued = 0;
  try {
    let batch = await sender.createMessageBatch();
    for (const ref of refs) {
      const refHash = createHash("md5").update(ref.rowKey).digest("hex");
      for (let r = 0; r < repeatCount; r++) {
        const sbMessage: ServiceBusMessage = {
          body: { jobId, refJson: ref.refJson, rowKey: ref.rowKey },
          contentType: "application/json",
          // SB limita messageId a 128 chars; jobId(36) + ":" + md5(32) + ":" + r ≤ 80 chars
          messageId: `${jobId}:${refHash}:${r}`,
        };
        if (!batch.tryAddMessage(sbMessage)) {
          await sender.sendMessages(batch);
          enqueued += batch.count;
          batch = await sender.createMessageBatch();
          if (!batch.tryAddMessage(sbMessage)) {
            console.warn(`[SEND] Mensagem ${ref.rowKey}#${r} excede limite do batch`);
            continue;
          }
        }
      }
    }
    if (batch.count > 0) {
      await sender.sendMessages(batch);
      enqueued += batch.count;
    }
  } finally {
    await sender.close().catch(() => {});
  }

  await setJobStatus(jobId, "processing");
  console.log(
    `🚀 Job ${jobId}: ${enqueued}/${totalMessages} mensagens enfileiradas (refs=${refs.length}, repeat=${repeatCount})`
  );

  res.status(202).json({
    jobId,
    refs: refs.length,
    repeat: repeatCount,
    total: totalMessages,
    enqueued,
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
  console.log(`   POST /api/send       → Enfileira mensagens (auth: x-api-key)`);
  console.log(`   GET  /api/jobs/:id   → Progresso do job`);
  console.log(`   GET  /api/status     → Contagem de usuários`);
  console.log(`   GET  /healthz        → Liveness`);
  console.log(`   GET  /readyz         → Readiness (Redis + Storage)`);
  if (!API_KEY) {
    console.warn("   ⚠️  API_KEY vazia: /api/send está SEM autenticação (modo dev).\n");
  } else {
    console.log("   🔒 API_KEY configurada\n");
  }
});
