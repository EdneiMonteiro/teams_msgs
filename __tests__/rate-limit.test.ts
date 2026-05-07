import {
  bucketStep,
  BucketState,
  TOKEN_BUCKET_LUA,
} from "../src/redis-tracker";

describe("token bucket math (bucketStep)", () => {
  test("permite consumo até a capacidade inicial", () => {
    let state: BucketState = { tokens: 5, ts: 0 };
    let granted = 0;
    for (let i = 0; i < 5; i++) {
      const r = bucketStep(state, 5, 50, 0);
      state = r.state;
      if (r.allowed) granted++;
    }
    expect(granted).toBe(5);
  });

  test("nega quando bucket vazio sem tempo decorrido", () => {
    const state: BucketState = { tokens: 0, ts: 0 };
    const r = bucketStep(state, 5, 50, 0);
    expect(r.allowed).toBe(false);
    expect(r.state.tokens).toBeCloseTo(0, 5);
  });

  test("recompõe tokens proporcionalmente ao tempo (rate=10/s)", () => {
    const state: BucketState = { tokens: 0, ts: 0 };
    const r = bucketStep(state, 50, 10, 500);
    expect(r.allowed).toBe(true);
    expect(r.state.tokens).toBeCloseTo(4, 5);
  });

  test("não passa da capacidade mesmo com elapsed grande", () => {
    const state: BucketState = { tokens: 0, ts: 0 };
    const r = bucketStep(state, 5, 1000, 10_000);
    expect(r.state.tokens).toBeLessThanOrEqual(5);
    expect(r.state.tokens).toBeCloseTo(4, 5);
    expect(r.allowed).toBe(true);
  });

  test("rate sustentado: ~50 grants em 1 s simulado", () => {
    let state: BucketState = { tokens: 50, ts: 0 };
    let granted = 0;
    for (let t = 0; t <= 1000; t += 5) {
      const r = bucketStep(state, 50, 50, t);
      state = r.state;
      if (r.allowed) granted++;
    }
    expect(granted).toBeGreaterThanOrEqual(95);
    expect(granted).toBeLessThanOrEqual(105);
  });

  test("script Lua é uma string com chamadas Redis esperadas", () => {
    expect(typeof TOKEN_BUCKET_LUA).toBe("string");
    expect(TOKEN_BUCKET_LUA).toContain("HMGET");
    expect(TOKEN_BUCKET_LUA).toContain("HSET");
    expect(TOKEN_BUCKET_LUA).toContain("EXPIRE");
  });
});
