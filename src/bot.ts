import {
  ActivityHandler,
  TurnContext,
  ConversationReference,
} from "botbuilder";

export interface RefStore {
  save(ref: Partial<ConversationReference>): Promise<void>;
  remove(conversationId: string): Promise<void>;
}

/**
 * Bot que captura conversationReferences quando o app é instalado.
 * Aceita qualquer store que implemente RefStore (JSON, Table Storage, etc.)
 */
export class ProactiveBot extends ActivityHandler {
  constructor(private store: RefStore) {
    super();

    this.onConversationUpdate(async (context, next) => {
      const added = context.activity.membersAdded || [];
      for (const member of added) {
        if (member.id !== context.activity.recipient.id) {
          const ref = TurnContext.getConversationReference(context.activity);
          await this.store.save(ref);
        }
      }
      await next();
    });

    this.onConversationUpdate(async (context, next) => {
      const removed = context.activity.membersRemoved || [];
      for (const member of removed) {
        if (member.id !== context.activity.recipient.id) {
          const ref = TurnContext.getConversationReference(context.activity);
          if (ref.conversation?.id) {
            await this.store.remove(ref.conversation.id);
          }
        }
      }
      await next();
    });

    this.onMessage(async (context, next) => {
      const ref = TurnContext.getConversationReference(context.activity);
      await this.store.save(ref);
      await context.sendActivity(
        "✅ Sua referência foi registrada. Você receberá notificações neste chat."
      );
      await next();
    });

    this.onInstallationUpdate(async (context, next) => {
      if (context.activity.action === "add") {
        const ref = TurnContext.getConversationReference(context.activity);
        await this.store.save(ref);
        console.log("[BOT] App instalado, referência salva.");
      }
      await next();
    });
  }
}
