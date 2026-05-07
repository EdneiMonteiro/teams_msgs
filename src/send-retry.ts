// Copyright (c) 2026 Ednei Monteiro. Licensed under the MIT License.
// See LICENSE and DISCLAIMER.md in the project root for details.
//
// Algoritmo de envio com retry, isolado da dependência do BotFrameworkAdapter
// para facilitar testes unitários.

export interface SendOutcome {
  ok: boolean;
  permanent?: boolean;
  statusCode?: number;
  errorMsg?: string;
}

export interface RetryConfig {
  retries?: number;
  /** Custom sleep function (overridden in tests). */
  sleep?: (ms: number) => Promise<void>;
}

export type SendFn = () => Promise<void>;

/**
 * Wraps a send function with retry/backoff logic that mirrors the worker.
 * Returns a structured SendOutcome — caller decides how to react.
 */
export async function sendWithRetry(
  send: SendFn,
  cfg: RetryConfig = {}
): Promise<SendOutcome> {
  const RETRIES = cfg.retries ?? 3;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      await send();
      return { ok: true };
    } catch (err: any) {
      const status = err?.statusCode || 0;

      if (status === 429 && attempt < RETRIES) {
        const retryAfter = err?.headers?.["retry-after"]
          ? parseInt(err.headers["retry-after"], 10) * 1000
          : 1000 * Math.pow(2, attempt);
        await sleep(retryAfter);
        continue;
      }

      if (status >= 500 && attempt < RETRIES) {
        await sleep(500 * Math.pow(2, attempt));
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
          errorMsg: err?.message || `HTTP ${status}`,
        };
      }

      return {
        ok: false,
        permanent: false,
        statusCode: status,
        errorMsg: err?.message || String(err),
      };
    }
  }
  return { ok: false, permanent: false, errorMsg: "Max retries exceeded" };
}
