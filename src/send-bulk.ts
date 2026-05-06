/**
 * Script CLI para enviar mensagem em massa.
 * 
 * Uso:
 *   npx ts-node src/send-bulk.ts "Sua mensagem aqui"
 *   npm run send -- "Sua mensagem aqui"
 */
import {
  BotFrameworkAdapter,
} from "botbuilder";
import { ConversationReferenceStore } from "./store";
import { sendBulkMessages } from "./sender";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const message = process.argv[2];
  if (!message) {
    console.error("❌ Uso: npx ts-node src/send-bulk.ts \"Sua mensagem aqui\"");
    process.exit(1);
  }

  const appId = process.env.MICROSOFT_APP_ID || "";

  const adapter = new BotFrameworkAdapter({
    appId,
    appPassword: process.env.MICROSOFT_APP_PASSWORD || "",
    channelAuthTenant: process.env.MICROSOFT_APP_TENANT_ID || "",
  });

  const store = new ConversationReferenceStore();
  const count = await store.count();

  if (count === 0) {
    console.error("❌ Nenhum usuário registrado. Instale o app primeiro.");
    process.exit(1);
  }

  console.log(`📋 ${count} usuários registrados`);
  console.log(`📨 Mensagem: "${message}"\n`);

  const results = await sendBulkMessages(
    adapter,
    store,
    process.env.MICROSOFT_APP_ID || "",
    {
      message,
      batchSize: parseInt(process.env.BATCH_SIZE || "50"),
      delayBetweenBatchesMs: parseInt(process.env.DELAY_BETWEEN_BATCHES_MS || "2000"),
      maxConcurrent: parseInt(process.env.MAX_CONCURRENT || "10"),
    }
  );

  const success = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success);

  console.log(`\n=== RESUMO ===`);
  console.log(`Total: ${results.length}`);
  console.log(`Sucesso: ${success}`);
  console.log(`Falhas: ${failed.length}`);

  if (failed.length > 0) {
    console.log(`\nPrimeiros erros:`);
    for (const f of failed.slice(0, 10)) {
      console.log(`  - ${f.conversationId}: ${f.error}`);
    }
  }
}

main().catch(console.error);
