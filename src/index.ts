// Copyright (c) 2026 Ednei Monteiro. Licensed under the MIT License.
// See LICENSE and DISCLAIMER.md in the project root for details.
import express, { Request, Response } from "express";
import { BotFrameworkAdapter, TurnContext } from "botbuilder";
import { ServiceBusClient } from "@azure/service-bus";
import { v4 as uuidv4 } from "uuid";
import { ProactiveBot } from "./bot";
import {
  saveRef, removeRef, getAllRefs, countRefs, ensureTables,
} from "./table-store";
import { createJob, getJob } from "./redis-tracker";
import * as dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 3978;
const appId = process.env.MICROSOFT_APP_ID || "";
const appPassword = process.env.MICROSOFT_APP_PASSWORD || "";
const sbConnection = process.env.SERVICE_BUS_CONNECTION || "";

// BotFrameworkAdapter SingleTenant
const adapter = new BotFrameworkAdapter({
  appId,
  appPassword,
  channelAuthTenant: process.env.MICROSOFT_APP_TENANT_ID || "",
});

adapter.onTurnError = async (context, error) => {
  console.error(`[ERRO] ${error.message}`);
  if (context.activity?.type === "message" && context.activity?.replyToId) {
    await context.sendActivity("Ocorreu um erro. Tente novamente.");
  }
};

// Bot que salva refs no Table Storage
const bot = new ProactiveBot({
  save: async (ref) => {
    const key = ref.conversation?.id;
    if (!key) return;
    await saveRef(key, JSON.stringify(ref));
    console.log(`[BOT] Referência salva (Table Storage): ${key.substring(0, 30)}...`);
  },
  remove: async (conversationId) => {
    await removeRef(conversationId);
    console.log(`[BOT] Referência removida: ${conversationId.substring(0, 30)}...`);
  },
});

// Service Bus client
const sbClient = sbConnection ? new ServiceBusClient(sbConnection) : null;

const app2 = express();
app2.use(express.json());

// Endpoint do Bot Framework
app2.post("/api/messages", async (req: Request, res: Response) => {
  await adapter.processActivity(req, res, async (context) => {
    await bot.run(context);
  });
});

// ASYNC: Envia mensagens via Service Bus (retorna jobId imediato)
app2.post("/api/send", async (req: Request, res: Response) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Campo 'message' é obrigatório" });
  }

  if (!sbClient) {
    return res.status(500).json({ error: "SERVICE_BUS_CONNECTION não configurada" });
  }

  const refs = await getAllRefs();
  if (refs.length === 0) {
    return res.status(404).json({
      error: "Nenhum usuário registrado. O app precisa ser instalado primeiro.",
    });
  }

  const jobId = uuidv4();
  await createJob(jobId, message, refs.length);

  // Enfileirar mensagens no Service Bus em batches de 250
  const sender = sbClient.createSender("send-messages");
  const QUEUE_BATCH = 250;
  for (let i = 0; i < refs.length; i += QUEUE_BATCH) {
    const batch = await sender.createMessageBatch();
    for (const refJson of refs.slice(i, i + QUEUE_BATCH)) {
      const added = batch.tryAddMessage({
        body: { jobId, refJson, message },
        contentType: "application/json",
      });
      if (!added) {
        // Batch cheio, enviar e criar novo
        await sender.sendMessages(batch);
        const newBatch = await sender.createMessageBatch();
        newBatch.tryAddMessage({
          body: { jobId, refJson, message },
          contentType: "application/json",
        });
      }
    }
    if (batch.count > 0) {
      await sender.sendMessages(batch);
    }
  }
  await sender.close();

  console.log(`🚀 Job ${jobId}: ${refs.length} mensagens enfileiradas`);

  res.json({
    jobId,
    total: refs.length,
    status: "queued",
    statusUrl: `/api/jobs/${jobId}`,
  });
});

// Consultar progresso do job
app2.get("/api/jobs/:id", async (req: Request, res: Response) => {
  const job = await getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job não encontrado" });
  }
  res.json(job);
});

// Status geral
app2.get("/api/status", async (_req: Request, res: Response) => {
  const count = await countRefs();
  res.json({ registeredUsers: count, status: "running", mode: "queue" });
});

app2.listen(PORT, async () => {
  await ensureTables();
  console.log(`\n🤖 Bot rodando em http://localhost:${PORT}`);
  console.log(`   POST /api/messages  → Endpoint do Bot Framework`);
  console.log(`   POST /api/send      → Enfileira mensagens (retorna jobId)`);
  console.log(`   GET  /api/jobs/:id  → Progresso do job`);
  console.log(`   GET  /api/status    → Status e contagem de usuários\n`);
});
