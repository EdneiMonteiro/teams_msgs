import { sendWithRetry } from "../src/send-retry";

const noSleep = (_ms: number) => Promise.resolve();

function httpError(statusCode: number, headers?: Record<string, string>) {
  const e: any = new Error(`HTTP ${statusCode}`);
  e.statusCode = statusCode;
  if (headers) e.headers = headers;
  return e;
}

describe("sendWithRetry", () => {
  test("sucesso na primeira tentativa", async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const r = await sendWithRetry(send, { sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("429 retentado e sucede no retry", async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(httpError(429, { "retry-after": "1" }))
      .mockResolvedValueOnce(undefined);
    const r = await sendWithRetry(send, { sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("5xx retentado e sucede no retry", async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce(undefined);
    const r = await sendWithRetry(send, { sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("403 marcado como permanent sem retry", async () => {
    const send = jest.fn().mockRejectedValue(httpError(403));
    const r = await sendWithRetry(send, { sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.permanent).toBe(true);
    expect(r.statusCode).toBe(403);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("410 marcado como permanent (Gone)", async () => {
    const send = jest.fn().mockRejectedValue(httpError(410));
    const r = await sendWithRetry(send, { sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.permanent).toBe(true);
    expect(r.statusCode).toBe(410);
  });

  test("400 (outro 4xx) também é permanent", async () => {
    const send = jest.fn().mockRejectedValue(httpError(400));
    const r = await sendWithRetry(send, { sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.permanent).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("erro sem statusCode é transient", async () => {
    const send = jest.fn().mockRejectedValue(new Error("timeout"));
    const r = await sendWithRetry(send, { sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.permanent).toBe(false);
  });

  test("429 esgota retries e retorna transient com statusCode 429", async () => {
    const send = jest.fn().mockRejectedValue(httpError(429));
    const r = await sendWithRetry(send, { sleep: noSleep, retries: 3 });
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBe(429);
    expect(send).toHaveBeenCalledTimes(3);
  });

  test("respeita Retry-After do 429 (header em segundos)", async () => {
    const sleeps: number[] = [];
    const send = jest
      .fn()
      .mockRejectedValueOnce(httpError(429, { "retry-after": "2" }))
      .mockResolvedValueOnce(undefined);
    await sendWithRetry(send, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([2000]);
  });
});
