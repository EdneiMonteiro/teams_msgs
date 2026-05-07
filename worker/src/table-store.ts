// Copyright (c) 2026 Ednei Monteiro. Licensed under the MIT License.
// See LICENSE and DISCLAIMER.md in the project root for details.
//
// Worker-side: helper enxuto para remover refs inválidas (403/410) tanto da
// Table Storage quanto do index ativo no Redis. A escrita inicial das refs é
// responsabilidade da API.

import { TableClient } from "@azure/data-tables";
import { refsRemove } from "./redis-tracker";

const TABLE_NAME = "conversationrefs";
const PARTITION = "refs";

let cached: TableClient | null = null;

function getClient(): TableClient {
  if (!cached) {
    const conn = process.env.STORAGE_CONNECTION || "";
    cached = TableClient.fromConnectionString(conn, TABLE_NAME);
  }
  return cached;
}

export async function removeRefByRowKey(rowKey: string): Promise<void> {
  try {
    await getClient().deleteEntity(PARTITION, rowKey);
  } catch {
    // já removida — segue o jogo
  }
  await refsRemove(rowKey).catch(() => {});
}
