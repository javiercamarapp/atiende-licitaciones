import { describe, expect, it } from "vitest";
import { assertRegisteredRecipient, UnregisteredRecipientError } from "../../src/recipients/types";

describe("assertRegisteredRecipient", () => {
  it("acepta un destinatario válido y normaliza el status por default", () => {
    const recipient = assertRegisteredRecipient({ email: "a@b.mx", userId: "u1" });
    expect(recipient).toEqual({ email: "a@b.mx", userId: "u1", status: "active" });
  });

  it("acepta explícitamente status invited", () => {
    const recipient = assertRegisteredRecipient({ email: "a@b.mx", userId: "u1", status: "invited" });
    expect(recipient.status).toBe("invited");
  });

  it("rechaza un correo inválido", () => {
    expect(() => assertRegisteredRecipient({ email: "no-es-correo", userId: "u1" })).toThrow(UnregisteredRecipientError);
  });

  it("rechaza sin userId", () => {
    expect(() => assertRegisteredRecipient({ email: "a@b.mx" })).toThrow(UnregisteredRecipientError);
  });

  it("rechaza un valor que no es ni siquiera un objeto", () => {
    expect(() => assertRegisteredRecipient("a@b.mx")).toThrow(UnregisteredRecipientError);
  });

  it("rechaza una cuenta suspendida", () => {
    expect(() => assertRegisteredRecipient({ email: "a@b.mx", userId: "u1", status: "suspended" })).toThrow(/suspendida/);
  });
});
