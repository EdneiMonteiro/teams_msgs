// Copyright (c) 2026 Ednei Monteiro. Licensed under the MIT License.
// See LICENSE and DISCLAIMER.md in the project root for details.
//
// Validador puro extraído de index.ts para permitir testes unitários sem
// subir o servidor Express.

export type MessageType = "text" | "card";

export interface ValidatedMessage {
  type: MessageType;
  serialized: string;
}

export interface ValidationError {
  error: string;
}

export function validateMessage(input: unknown): ValidatedMessage | ValidationError {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return { error: "Campo 'message' (string) não pode ser vazio" };
    return { type: "text", serialized: input };
  }
  if (
    input &&
    typeof input === "object" &&
    (input as any).type === "AdaptiveCard"
  ) {
    const content = (input as any).content;
    if (!content || typeof content !== "object") {
      return { error: "AdaptiveCard precisa de 'content' (objeto)" };
    }
    if (content.type !== "AdaptiveCard") {
      return { error: "AdaptiveCard 'content' precisa ter type='AdaptiveCard'" };
    }
    return { type: "card", serialized: JSON.stringify(input) };
  }
  return {
    error:
      "Campo 'message' deve ser string OU { type: 'AdaptiveCard', content: <card> }",
  };
}
