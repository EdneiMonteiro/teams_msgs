// Copyright (c) 2026 Ednei Monteiro. Licensed under the MIT License.
// See LICENSE and DISCLAIMER.md in the project root for details.
import { ConversationReference } from "botbuilder";
import * as fs from "fs";
import * as path from "path";

const STORE_PATH = path.join(__dirname, "..", "data", "references.json");

/**
 * Store simples em arquivo JSON para conversationReferences.
 * Para produção, substitua por Azure Table Storage, Cosmos DB, ou SQL.
 */
export class ConversationReferenceStore {
  private refs: Map<string, Partial<ConversationReference>> = new Map();

  constructor() {
    this.load();
  }

  async save(ref: Partial<ConversationReference>): Promise<void> {
    const key = ref.conversation?.id;
    if (!key) return;
    this.refs.set(key, ref);
    this.persist();
  }

  async remove(conversationId: string): Promise<void> {
    this.refs.delete(conversationId);
    this.persist();
  }

  async getAll(): Promise<Partial<ConversationReference>[]> {
    return Array.from(this.refs.values());
  }

  async count(): Promise<number> {
    return this.refs.size;
  }

  private load(): void {
    try {
      if (fs.existsSync(STORE_PATH)) {
        const data = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
        for (const [key, val] of Object.entries(data)) {
          this.refs.set(key, val as Partial<ConversationReference>);
        }
        console.log(`[STORE] ${this.refs.size} referências carregadas.`);
      }
    } catch {
      console.warn("[STORE] Falha ao carregar referências, iniciando vazio.");
    }
  }

  private persist(): void {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj: Record<string, Partial<ConversationReference>> = {};
    for (const [key, val] of this.refs.entries()) {
      obj[key] = val;
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify(obj, null, 2));
  }
}
