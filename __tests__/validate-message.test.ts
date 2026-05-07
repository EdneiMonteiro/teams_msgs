import { validateMessage } from "../src/validate-message";

describe("validateMessage", () => {
  test("aceita string simples", () => {
    const r = validateMessage("Olá, mundo");
    expect(r).toEqual({ type: "text", serialized: "Olá, mundo" });
  });

  test("rejeita string vazia ou só espaços", () => {
    expect(validateMessage("")).toEqual(
      expect.objectContaining({ error: expect.any(String) })
    );
    expect(validateMessage("   ")).toEqual(
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  test("rejeita number / null / array", () => {
    expect("error" in (validateMessage(42) as any)).toBe(true);
    expect("error" in (validateMessage(null) as any)).toBe(true);
    expect("error" in (validateMessage([1, 2]) as any)).toBe(true);
  });

  test("aceita Adaptive Card válido", () => {
    const card = {
      type: "AdaptiveCard",
      content: {
        type: "AdaptiveCard",
        version: "1.5",
        body: [{ type: "TextBlock", text: "Hello" }],
      },
    };
    const r = validateMessage(card);
    expect(r).toMatchObject({ type: "card" });
    if ("serialized" in r) {
      const parsed = JSON.parse(r.serialized);
      expect(parsed.content.type).toBe("AdaptiveCard");
    }
  });

  test("rejeita AdaptiveCard sem content", () => {
    const r = validateMessage({ type: "AdaptiveCard" });
    expect(r).toEqual(
      expect.objectContaining({ error: expect.stringContaining("content") })
    );
  });

  test("rejeita AdaptiveCard com content.type errado", () => {
    const r = validateMessage({
      type: "AdaptiveCard",
      content: { foo: "bar" },
    });
    expect(r).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });

  test("rejeita objeto não-AdaptiveCard", () => {
    const r = validateMessage({ type: "Hero", content: {} });
    expect(r).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });
});
