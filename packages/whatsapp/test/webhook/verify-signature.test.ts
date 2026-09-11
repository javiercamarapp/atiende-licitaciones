import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyMetaWebhookSignature } from "../../src/webhook/verify-signature";

const APP_SECRET = "app-secret-de-prueba-0123456789";

function firmar(rawBody: string, secret: string = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

describe("REQ-090/097: verifyMetaWebhookSignature (esquema X-Hub-Signature-256 de Meta)", () => {
  it("firma válida -> ok", () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifyMetaWebhookSignature(body, firmar(body), APP_SECRET)).toEqual({ ok: true });
  });

  it("sin secreto configurado -> falla cerrado, nunca 'ok' por accidente", () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifyMetaWebhookSignature(body, firmar(body), undefined)).toEqual({ ok: false, reason: "secreto_no_configurado" });
  });

  it("ADVERSARIAL: sin cabecera de firma -> rechazado", () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifyMetaWebhookSignature(body, undefined, APP_SECRET)).toEqual({ ok: false, reason: "cabecera_ausente" });
  });

  it("ADVERSARIAL: cabecera sin el prefijo 'sha256=' -> rechazada", () => {
    const body = "x";
    expect(verifyMetaWebhookSignature(body, "abcdef", APP_SECRET)).toEqual({ ok: false, reason: "cabecera_mal_formada" });
  });

  it("ADVERSARIAL: cabecera con hex inválido -> rechazada", () => {
    const body = "x";
    expect(verifyMetaWebhookSignature(body, "sha256=no-es-hex!!", APP_SECRET)).toEqual({ ok: false, reason: "cabecera_mal_formada" });
  });

  it("ADVERSARIAL: firmado con OTRO secreto (forjado) -> rechazada", () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifyMetaWebhookSignature(body, firmar(body, "secreto-del-atacante"), APP_SECRET)).toEqual({ ok: false, reason: "firma_invalida" });
  });

  it("ADVERSARIAL: cuerpo alterado DESPUÉS de firmar -> rechazada", () => {
    const original = JSON.stringify({ a: 1 });
    const alterado = JSON.stringify({ a: 2 });
    expect(verifyMetaWebhookSignature(alterado, firmar(original), APP_SECRET)).toEqual({ ok: false, reason: "firma_invalida" });
  });
});
