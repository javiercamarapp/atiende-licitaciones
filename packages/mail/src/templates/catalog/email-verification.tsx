import * as React from "react";
import { z } from "zod";
import { EmailLayout } from "../../components/EmailLayout";
import { Paragraph, CtaButton, Callout, Title } from "../../components/blocks";
import { BaseVariablesSchema } from "../common";
import { renderEmailParts } from "../render-html";
import type { TemplateDefinition } from "../types";

export const EmailVerificationVariablesSchema = BaseVariablesSchema.extend({
  verificationUrl: z.string().url("verificationUrl debe ser una URL absoluta (usar signedLink)."),
  expiresInMinutes: z.number().int().positive(),
});

export type EmailVerificationVariables = z.infer<typeof EmailVerificationVariablesSchema>;

export const emailVerificationTemplate: TemplateDefinition<EmailVerificationVariables> = {
  id: "email-verification",
  name: "Verificación de correo",
  category: "account_security",
  mandatory: true,
  schema: EmailVerificationVariablesSchema,
  sampleData: {
    recipientName: "María Fernanda López (ejemplo)",
    appUrl: "https://app.atiende.mx",
    supportEmail: "soporte@atiende.mx",
    verificationUrl: "https://app.atiende.mx/verificar-correo?d=ejemplo&s=ejemplo",
    expiresInMinutes: 30,
  },
  async render(vars) {
    // Asunto alineado a docs/investigacion/salida-promocion-referencias.md
    // §6.3 (REQ-181, plantilla 1).
    const subject = "Confirma tu correo — Atiende Licitaciones";
    const element = (
      <EmailLayout
        documentTitle={subject}
        preheader={`Un solo clic y tu cuenta de Atiende Licitaciones queda activa. El enlace vence en ${vars.expiresInMinutes} minutos.`}
        reason="Te llegó este mensaje porque registraste este correo en Atiende Licitaciones."
        appUrl={vars.appUrl}
        supportEmail={vars.supportEmail}
      >
        <Title>Confirma tu correo</Title>
        <Paragraph>Hola {vars.recipientName}:</Paragraph>
        <Paragraph>
          Gracias por registrarte en Atiende Licitaciones. Para activar tu cuenta y empezar a recibir convocatorias
          relevantes, confirma que esta dirección de correo es tuya.
        </Paragraph>
        <CtaButton label="Confirmar mi correo" href={vars.verificationUrl} appUrl={vars.appUrl} showLiteralLink />
        <Callout>
          Este enlace vence en {vars.expiresInMinutes} minutos y solo funciona una vez. Si tú no creaste esta cuenta,
          puedes ignorar este correo: no se activará nada sin confirmar.
        </Callout>
      </EmailLayout>
    );
    const { html, text } = await renderEmailParts(element);
    return { subject, html, text };
  },
};
