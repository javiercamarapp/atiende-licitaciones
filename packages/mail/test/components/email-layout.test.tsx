import * as React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@react-email/render";
import { EmailLayout } from "../../src/components/EmailLayout";
import { Paragraph } from "../../src/components/blocks";

const BASE_PROPS = {
  documentTitle: "Título de prueba",
  preheader: "Avance de prueba",
  reason: "Por qué te llegó",
  appUrl: "https://app.atiende.mx",
  supportEmail: "soporte@atiende.mx",
};

describe("EmailLayout", () => {
  it("sin logoCid, usa el wordmark de texto (default seguro para todo cliente)", async () => {
    const html = await render(
      <EmailLayout {...BASE_PROPS}>
        <Paragraph>Cuerpo</Paragraph>
      </EmailLayout>,
    );
    expect(html).toContain(">atiende<");
    expect(html).not.toContain("cid:");
  });

  it("con logoCid, usa un <img> referenciando cid: con alt con estilo de respaldo", async () => {
    const html = await render(
      <EmailLayout {...BASE_PROPS} logoCid="logo-atiende">
        <Paragraph>Cuerpo</Paragraph>
      </EmailLayout>,
    );
    expect(html).toContain('src="cid:logo-atiende"');
    expect(html).toContain('alt="atiende"');
  });

  it("sin preferencesUrl/unsubscribeUrl, no muestra esos enlaces (caso de correo obligatorio)", async () => {
    const html = await render(
      <EmailLayout {...BASE_PROPS}>
        <Paragraph>Cuerpo</Paragraph>
      </EmailLayout>,
    );
    expect(html).not.toContain("Administrar preferencias de notificación");
    expect(html).not.toContain("Darme de baja de estos correos");
  });

  it("con preferencesUrl y unsubscribeUrl, los muestra", async () => {
    const html = await render(
      <EmailLayout {...BASE_PROPS} preferencesUrl="https://app.atiende.mx/preferencias" unsubscribeUrl="https://app.atiende.mx/baja">
        <Paragraph>Cuerpo</Paragraph>
      </EmailLayout>,
    );
    expect(html).toContain("Administrar preferencias de notificación");
    expect(html).toContain("Darme de baja de estos correos");
  });

  it("un tono con rótulo (atencion/urgente/exito) pinta el micro-rótulo; neutral no pinta nada", async () => {
    const conRotulo = await render(
      <EmailLayout {...BASE_PROPS} tone="urgente">
        <Paragraph>Cuerpo</Paragraph>
      </EmailLayout>,
    );
    expect(conRotulo).toContain("Urgente");

    const neutral = await render(
      <EmailLayout {...BASE_PROPS}>
        <Paragraph>Cuerpo</Paragraph>
      </EmailLayout>,
    );
    expect(neutral).not.toContain("Urgente");
    expect(neutral).not.toContain("Requiere atención");
    expect(neutral).not.toContain("Completado");
  });

  it("un href que no es http(s) en preferencesUrl cae al appUrl (safeUrl)", async () => {
    const html = await render(
      <EmailLayout {...BASE_PROPS} preferencesUrl={"javascript:alert(1)" as string}>
        <Paragraph>Cuerpo</Paragraph>
      </EmailLayout>,
    );
    expect(html).not.toContain("javascript:alert");
  });
});
