import * as React from "react";
import { z } from "zod";
import { EmailLayout } from "../../components/EmailLayout";
import { Paragraph, CtaButton, DataTable, Title } from "../../components/blocks";
import { BaseVariablesSchema } from "../common";
import { renderEmailParts } from "../render-html";
import type { TemplateDefinition } from "../types";

/**
 * Cubre REQ-181 (plantilla 10, "resumen diario/semanal") con un solo
 * template: `periodKind` decide si el asunto y el cuerpo hablan de "hoy" o
 * de la semana — el job programado que encola el envío es quien decide la
 * cadencia por usuario (configurable, según §6.3 de
 * docs/investigacion/salida-promocion-referencias.md), no esta plantilla.
 */
export const WeeklySummaryVariablesSchema = BaseVariablesSchema.extend({
  periodKind: z.enum(["diario", "semanal"]),
  periodRangeLabel: z.string().min(1),
  newMatches: z.number().int().min(0),
  changesDetected: z.number().int().min(0),
  pendingApprovals: z.number().int().min(0),
  upcomingDeadlines: z.number().int().min(0),
  summaryUrl: z.string().url(),
});

export type WeeklySummaryVariables = z.infer<typeof WeeklySummaryVariablesSchema>;

export const weeklySummaryTemplate: TemplateDefinition<WeeklySummaryVariables> = {
  id: "weekly-summary",
  name: "Resumen diario/semanal",
  category: "weekly_summary",
  mandatory: false,
  schema: WeeklySummaryVariablesSchema,
  sampleData: {
    recipientName: "Ana Torres (ejemplo)",
    appUrl: "https://app.atiende.mx",
    supportEmail: "soporte@atiende.mx",
    preferencesUrl: "https://app.atiende.mx/preferencias?d=ejemplo&s=ejemplo",
    unsubscribeUrl: "https://app.atiende.mx/preferencias/baja?d=ejemplo&s=ejemplo",
    periodKind: "semanal",
    periodRangeLabel: "1 al 6 de septiembre de 2026 (ejemplo)",
    newMatches: 7,
    changesDetected: 3,
    pendingApprovals: 2,
    upcomingDeadlines: 4,
    summaryUrl: "https://app.atiende.mx/resumen/semana-actual",
  },
  async render(vars) {
    // Asunto alineado a docs/investigacion/salida-promocion-referencias.md
    // §6.3 (REQ-181, plantilla 10).
    const subject = `Tu resumen ${vars.periodKind} de Atiende Licitaciones`;
    const element = (
      <EmailLayout
        documentTitle={subject}
        preheader={`${vars.newMatches} convocatorias nuevas, ${vars.pendingApprovals} aprobaciones pendientes.`}
        reason={`Te llegó este mensaje porque tienes activado el resumen ${vars.periodKind} de actividad.`}
        appUrl={vars.appUrl}
        supportEmail={vars.supportEmail}
        preferencesUrl={vars.preferencesUrl}
        unsubscribeUrl={vars.unsubscribeUrl}
      >
        <Title>{vars.periodKind === "diario" ? "Tu día en Atiende Licitaciones" : "Tu semana en Atiende Licitaciones"}</Title>
        <Paragraph>Hola {vars.recipientName}:</Paragraph>
        <Paragraph>Esto es lo que pasó del {vars.periodRangeLabel}:</Paragraph>
        <DataTable
          rows={[
            { label: "Convocatorias nuevas", value: String(vars.newMatches) },
            { label: "Cambios detectados", value: String(vars.changesDetected) },
            { label: "Aprobaciones pendientes", value: String(vars.pendingApprovals) },
            { label: "Plazos próximos a vencer", value: String(vars.upcomingDeadlines) },
          ]}
        />
        <CtaButton label="Ver resumen completo" href={vars.summaryUrl} appUrl={vars.appUrl} />
      </EmailLayout>
    );
    const { html, text } = await renderEmailParts(element);
    return { subject, html, text };
  },
};
