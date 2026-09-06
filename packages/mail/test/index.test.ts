import { describe, expect, it } from "vitest";
import * as mail from "../src/index";

/**
 * Prueba de humo del punto de entrada público del paquete: lo que
 * `apps/api`/`apps/worker` importarán como `@atiende/mail`. No repite las
 * pruebas unitarias de cada módulo (esas ya viven en `test/**`) — solo
 * confirma que el barril re-exporta lo que promete el README.
 */
describe("@atiende/mail (barril público)", () => {
  it("exporta MailService y CaptureProvider", () => {
    expect(mail.MailService).toBeTypeOf("function");
    expect(mail.CaptureProvider).toBeTypeOf("function");
  });

  it("exporta el registro de plantillas con al menos 15 entradas", () => {
    expect(mail.listTemplates().length).toBeGreaterThanOrEqual(15);
  });

  it("exporta createLinkSigner y createMailProviderFromEnv", () => {
    expect(mail.createLinkSigner).toBeTypeOf("function");
    expect(mail.createMailProviderFromEnv).toBeTypeOf("function");
  });

  it("exporta los tokens de tema (colors/fonts)", () => {
    expect(mail.colors.brand).toBe("#1d4ed8");
    expect(mail.fonts.display).toContain("Inter Tight");
  });

  it("exporta el helper de webhooks y supresión", () => {
    expect(mail.verifyResendWebhookSignature).toBeTypeOf("function");
    expect(mail.applyMailWebhookEvent).toBeTypeOf("function");
    expect(mail.InMemorySuppressionStore).toBeTypeOf("function");
  });
});
