import { BotFrameworkAdapter, ConversationReference, TurnContext } from "botbuilder";
import { ConversationReferenceStore } from "./store";

export interface SendResult {
  conversationId: string;
  success: boolean;
  error?: string;
}

export interface BulkSendOptions {
  message: string;
  batchSize?: number;
  delayBetweenBatchesMs?: number;
  maxConcurrent?: number;
  onProgress?: (sent: number, total: number, errors: number) => void;
}

/**
 * Envia mensagens proativas 1:1 para todos os usuários registrados,
 * com controle de throttling, batch e retry.
 * 
 * Para atingir ~250 msg/min:
 *   batchSize=25, delayBetweenBatchesMs=1000, maxConcurrent=25
 *   → 25 msgs/batch, 1 batch/s ≈ 250/min (com headroom para latência)
 */
export async function sendBulkMessages(
  adapter: BotFrameworkAdapter,
  store: ConversationReferenceStore,
  appId: string,
  options: BulkSendOptions
): Promise<SendResult[]> {
  const {
    message,
    batchSize = 25,
    delayBetweenBatchesMs = 1000,
    maxConcurrent = 25,
    onProgress,
  } = options;

  const refs = await store.getAll();
  const total = refs.length;
  const results: SendResult[] = [];
  let sent = 0;
  let errors = 0;

  console.log(`\n📨 Enviando para ${total} usuários...`);
  console.log(`   Batch: ${batchSize} | Delay: ${delayBetweenBatchesMs}ms | Concorrência: ${maxConcurrent}\n`);

  for (let i = 0; i < refs.length; i += batchSize) {
    const batch = refs.slice(i, i + batchSize);
    const batchStart = Date.now();

    // Processa batch com concorrência limitada real (semáforo)
    const batchResults = await runWithConcurrency(
      batch.map((ref) => () => sendSingleMessage(adapter, ref, appId, message)),
      maxConcurrent
    );

    for (const result of batchResults) {
      results.push(result);
      if (!result.success) errors++;
      sent++;
    }

    onProgress?.(sent, total, errors);
    const batchMs = Date.now() - batchStart;
    console.log(`   ✅ ${sent}/${total} enviados (${errors} erros) [batch: ${batchMs}ms]`);

    // Delay adaptativo: desconta o tempo já gasto no batch
    if (i + batchSize < refs.length) {
      const remainingDelay = Math.max(0, delayBetweenBatchesMs - batchMs);
      if (remainingDelay > 0) await sleep(remainingDelay);
    }
  }

  console.log(`\n📊 Resultado: ${sent - errors} sucesso, ${errors} erros de ${total} total\n`);
  return results;
}

/**
 * Executa funções com concorrência limitada (semáforo).
 * Diferente de Promise.all que dispara tudo de uma vez.
 */
async function runWithConcurrency(
  tasks: (() => Promise<SendResult>)[],
  limit: number
): Promise<SendResult[]> {
  const results: SendResult[] = new Array(tasks.length);
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

async function sendSingleMessage(
  adapter: BotFrameworkAdapter,
  ref: Partial<ConversationReference>,
  appId: string,
  message: string,
  retries = 3
): Promise<SendResult> {
  const conversationId = ref.conversation?.id || "unknown";

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await adapter.continueConversation(
        ref as ConversationReference,
        async (context: TurnContext) => {
          await context.sendActivity(message);
        }
      );
      return { conversationId, success: true };
    } catch (err: any) {
      const status = err.statusCode || err.code || 0;

      // 429 = throttled → retry com backoff exponencial
      if (status === 429 && attempt < retries) {
        const retryAfter = err.headers?.["retry-after"]
          ? parseInt(err.headers["retry-after"]) * 1000
          : 1000 * Math.pow(2, attempt);
        console.warn(`   ⏳ Throttled, retry #${attempt} em ${retryAfter}ms...`);
        await sleep(retryAfter);
        continue;
      }

      // 5xx = erro do servidor → retry com backoff
      if (status >= 500 && attempt < retries) {
        const backoff = 500 * Math.pow(2, attempt);
        console.warn(`   ⚠️ Server error ${status}, retry #${attempt} em ${backoff}ms...`);
        await sleep(backoff);
        continue;
      }

      // 403 = usuário bloqueou ou desinstalou o bot
      if (status === 403) {
        return {
          conversationId,
          success: false,
          error: "Usuário bloqueou ou desinstalou o bot",
        };
      }

      return { conversationId, success: false, error: err.message || String(err) };
    }
  }

  return { conversationId, success: false, error: "Max retries exceeded" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
