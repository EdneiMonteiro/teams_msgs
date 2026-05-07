// Copyright (c) 2026 Ednei Monteiro. Licensed under the MIT License.
// See LICENSE and DISCLAIMER.md in the project root for details.
//
// Persistência durável dos conversationReferences em Azure Table Storage.
// O index ativo (para contagem rápida e fan-out) é mantido em paralelo no
// Redis (refsAdd / refsRemove / refsCount). Table Storage é a fonte da
// verdade; Redis é cache otimizado para leitura.

import { TableClient, TableEntity } from "@azure/data-tables";
import { refsAdd, refsRemove } from "./redis-tracker";

const TABLE_NAME = "conversationrefs";
const PARTITION = "refs";

export interface ConversationRef extends TableEntity {
  partitionKey: string;
  rowKey: string;
  refJson: string;
}

let cachedClient: TableClient | null = null;
let tableEnsured = false;

function getClient(): TableClient {
  if (!cachedClient) {
    const conn = process.env.STORAGE_CONNECTION || "";
    cachedClient = TableClient.fromConnectionString(conn, TABLE_NAME);
  }
  return cachedClient;
}

export async function ensureTables(): Promise<void> {
  if (tableEnsured) return;
  await getClient().createTable().catch(() => {});
  tableEnsured = true;
}

export function safeRowKey(conversationId: string): string {
  return Buffer.from(conversationId).toString("base64url");
}

export async function saveRef(conversationId: string, refJson: string): Promise<void> {
  await ensureTables();
  const rowKey = safeRowKey(conversationId);
  const entity: ConversationRef = {
    partitionKey: PARTITION,
    rowKey,
    refJson,
  };
  await getClient().upsertEntity(entity, "Replace");
  await refsAdd(rowKey).catch((err) => {
    console.warn(`[TABLE] refsAdd falhou (não-fatal): ${err.message || err}`);
  });
}

export async function removeRef(conversationId: string): Promise<void> {
  await ensureTables();
  const rowKey = safeRowKey(conversationId);
  try {
    await getClient().deleteEntity(PARTITION, rowKey);
  } catch {
    // entidade já removida
  }
  await refsRemove(rowKey).catch((err) => {
    console.warn(`[TABLE] refsRemove falhou (não-fatal): ${err.message || err}`);
  });
}

export async function removeRefByRowKey(rowKey: string): Promise<void> {
  await ensureTables();
  try {
    await getClient().deleteEntity(PARTITION, rowKey);
  } catch {
    // já removida
  }
  await refsRemove(rowKey).catch(() => {});
}

export async function getAllRefs(): Promise<{ rowKey: string; refJson: string }[]> {
  await ensureTables();
  const refs: { rowKey: string; refJson: string }[] = [];
  const iter = getClient().listEntities<ConversationRef>({
    queryOptions: { filter: `PartitionKey eq '${PARTITION}'` },
  });
  for await (const entity of iter) {
    refs.push({ rowKey: entity.rowKey, refJson: entity.refJson });
  }
  return refs;
}

/**
 * Streaming version — yields refs one by one without materializing the
 * full list in memory. Recommended for large audiences (>10k).
 */
export async function* streamRefs(): AsyncGenerator<{ rowKey: string; refJson: string }> {
  await ensureTables();
  const iter = getClient().listEntities<ConversationRef>({
    queryOptions: { filter: `PartitionKey eq '${PARTITION}'` },
  });
  for await (const entity of iter) {
    yield { rowKey: entity.rowKey, refJson: entity.refJson };
  }
}

export async function countRefsFromTable(): Promise<number> {
  // Usado apenas como fallback (ex.: reconciliação). O caminho rápido é
  // refsCount() do redis-tracker, baseado em SCARD.
  const refs = await getAllRefs();
  return refs.length;
}

export async function pingStorage(): Promise<boolean> {
  try {
    await ensureTables();
    return true;
  } catch {
    return false;
  }
}
