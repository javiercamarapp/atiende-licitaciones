import type { JobHandler } from '../queue/types.js';

export interface SendAgentAlertPayload {
  organizationId: string;
  tenderId: string;
  kind: 'vencimiento' | 'cambio_bases' | 'otro';
  message: string;
}

/**
 * Handler del job `send_agent_alert`, encolado por la herramienta
 * `programar_alerta` (`src/agents/business-tools.ts`, Ronda 6). Registra la
 * alerta en el log estructurado del worker para seguimiento humano — **no**
 * envía correo/SMS/webhook a nadie: no hay canal de notificación real
 * configurado en este proyecto todavía (correo transaccional real está
 * documentado como bloqueo externo pendiente de credenciales en
 * docs/investigacion/paridad-producto.md §6.2). Implementar un canal real
 * (Resend/SES/webhook) es una extensión futura de este mismo handler, sin
 * cambiar el contrato del job ni de la herramienta que lo encola.
 */
export function createSendAgentAlertHandler(): JobHandler<SendAgentAlertPayload> {
  return async (job, ctx) => {
    ctx.logger.warn(
      {
        organization_id: job.payload.organizationId,
        tender_id: job.payload.tenderId,
        alert_kind: job.payload.kind,
      },
      `ALERTA DE AGENTE (sin canal de envío real configurado, ver docstring): ${job.payload.message}`,
    );
  };
}
