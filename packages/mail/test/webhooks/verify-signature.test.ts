import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyResendWebhookSignature } from "../../src/webhooks/verify-signature";

const SECRET_B64 = Buffer.from("una-llave-de-32-bytes-para-hmac!").toString("base64");
const SECRET = `whsec_${SECRET_B64}`;

function sign(id: string, timestamp: string, body: string): string {
  const signedContent = `${id}.${timestamp}.${body}`;
  const digest = createHmac("sha256", Buffer.from(SECRET_B64, "base64")).update(signedContent).digest("base64");
  return `v1,${digest}`;
}

describe("verifyResendWebhookSignature", () => {
  it("acepta una firma válida", () => {
    const body = JSON.stringify({ type: "email.bounced" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = { svixId: "msg_1", svixTimestamp: timestamp, svixSignature: sign("msg_1", timestamp, body) };
    expect(verifyResendWebhookSignature(body, headers, SECRET)).toEqual({ ok: true });
  });

  it("rechaza si el cuerpo fue alterado después de firmar", () => {
    const body = JSON.stringify({ type: "email.bounced" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = { svixId: "msg_1", svixTimestamp: timestamp, svixSignature: sign("msg_1", timestamp, body) };
    const alteredBody = JSON.stringify({ type: "email.delivered" });
    expect(verifyResendWebhookSignature(alteredBody, headers, SECRET)).toEqual({ ok: false, reason: "firma_invalida" });
  });

  it("rechaza con el secreto equivocado", () => {
    const body = JSON.stringify({ type: "email.bounced" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = { svixId: "msg_1", svixTimestamp: timestamp, svixSignature: sign("msg_1", timestamp, body) };
    const otroSecreto = `whsec_${Buffer.from("otra-llave-completamente-distinta").toString("base64")}`;
    expect(verifyResendWebhookSignature(body, headers, otroSecreto)).toEqual({ ok: false, reason: "firma_invalida" });
  });

  it("rechaza cabeceras incompletas", () => {
    expect(verifyResendWebhookSignature("{}", { svixId: "", svixTimestamp: "", svixSignature: "" }, SECRET)).toEqual({
      ok: false,
      reason: "cabeceras_incompletas",
    });
  });

  it("rechaza un timestamp fuera de tolerancia (reenvío tardío o reloj desincronizado)", () => {
    const body = "{}";
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 10_000);
    const headers = { svixId: "msg_1", svixTimestamp: oldTimestamp, svixSignature: sign("msg_1", oldTimestamp, body) };
    expect(verifyResendWebhookSignature(body, headers, SECRET)).toEqual({ ok: false, reason: "timestamp_fuera_de_rango" });
  });

  it("acepta un timestamp viejo si se amplía la tolerancia explícitamente", () => {
    const body = "{}";
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 10_000);
    const headers = { svixId: "msg_1", svixTimestamp: oldTimestamp, svixSignature: sign("msg_1", oldTimestamp, body) };
    expect(verifyResendWebhookSignature(body, headers, SECRET, { toleranceSeconds: 20_000 })).toEqual({ ok: true });
  });

  it("acepta cuando svix-signature trae varias firmas separadas por espacio (rotación de secreto)", () => {
    const body = "{}";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const validSig = sign("msg_1", timestamp, body);
    const headers = { svixId: "msg_1", svixTimestamp: timestamp, svixSignature: `v1,firmavieja-invalida ${validSig}` };
    expect(verifyResendWebhookSignature(body, headers, SECRET)).toEqual({ ok: true });
  });

  it("rechaza un secreto que no es base64 válido tras quitarle el prefijo", () => {
    const body = "{}";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = { svixId: "msg_1", svixTimestamp: timestamp, svixSignature: sign("msg_1", timestamp, body) };
    // Una cadena vacía tras el prefijo produce una llave HMAC de longitud 0.
    expect(verifyResendWebhookSignature(body, headers, "whsec_", {})).toEqual({ ok: false, reason: "secreto_invalido" });
  });
});
