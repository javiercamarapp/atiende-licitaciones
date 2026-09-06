import * as React from "react";
import { z } from "zod";
import { EmailLayout } from "../../components/EmailLayout";
import { Paragraph, CtaButton, DataTable, Title } from "../../components/blocks";
import { BaseVariablesSchema, formatFechaEs } from "../common";
import { renderEmailParts } from "../render-html";
import type { TemplateDefinition } from "../types";

export const SubmissionPackageReadyVariablesSchema = BaseVariablesSchema.extend({
  tenderTitle: z.string().min(1),
  documentCount: z.number().int().positive(),
  submissionDeadlineIso: z.string().min(1),
  packageUrl: z.string().url(),
});

export type SubmissionPackageReadyVariables = z.infer<typeof SubmissionPackageReadyVariablesSchema>;

export const submissionPackageReadyTemplate: TemplateDefinition<SubmissionPackageReadyVariables> = {
  id: "submission-package-ready",
  name: "Paquete listo para presentar",
  category: "submission",
  mandatory: false,
  schema: SubmissionPackageReadyVariablesSchema,
  sampleData: {
    recipientName: "Ana Torres (ejemplo)",
    appUrl: "https://app.atiende.mx",
    supportEmail: "soporte@atiende.mx",
    preferencesUrl: "https://app.atiende.mx/preferencias?d=ejemplo&s=ejemplo",
    unsubscribeUrl: "https://app.atiende.mx/preferencias/baja?d=ejemplo&s=ejemplo",
    tenderTitle: "Suministro de equipo de cómputo para oficinas regionales (ejemplo)",
    documentCount: 12,
    submissionDeadlineIso: "2026-10-07T18:00:00.000Z",
    packageUrl: "https://app.atiende.mx/expedientes/demo-001/paquete",
  },
  async render(vars) {
    // Asunto alineado a docs/investigacion/salida-promocion-referencias.md
    // §6.3 (REQ-181, plantilla 8).
    const subject = `Tu paquete de licitación para ${vars.tenderTitle} está listo`;
    const deadline = formatFechaEs(vars.submissionDeadlineIso);
    const element = (
      <EmailLayout
        documentTitle={subject}
        preheader={`${vars.documentCount} documentos revisados y listos. Cierra el ${deadline}.`}
        tone="exito"
        reason="Te llegó este mensaje porque das seguimiento a esta convocatoria en Atiende Licitaciones."
        appUrl={vars.appUrl}
        supportEmail={vars.supportEmail}
        preferencesUrl={vars.preferencesUrl}
        unsubscribeUrl={vars.unsubscribeUrl}
      >
        <Title>Tu expediente está listo</Title>
        <Paragraph>Hola {vars.recipientName}:</Paragraph>
        <Paragraph>
          El paquete de documentos para <strong>{vars.tenderTitle}</strong> ya pasó la revisión de cumplimiento y está
          listo para presentar. Nadie lo envía por ti: la presentación final la haces tú, desde la plataforma de la
          convocante o como corresponda a este proceso.
        </Paragraph>
        <DataTable
          rows={[
            { label: "Documentos incluidos", value: String(vars.documentCount) },
            { label: "Cierre de propuestas", value: deadline },
          ]}
        />
        <CtaButton label="Ver paquete completo" href={vars.packageUrl} appUrl={vars.appUrl} />
      </EmailLayout>
    );
    const { html, text } = await renderEmailParts(element);
    return { subject, html, text };
  },
};
