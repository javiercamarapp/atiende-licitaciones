import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  parseWhatsAppWebhookPayload,
  verifyMetaWebhookSignature,
  resolveWebhookSubscriptionChallenge,
  toE164FromMetaPhone,
  type WhatsAppInboundInteraction,
} from '@atiende/whatsapp';
import { AppError, UnauthorizedError } from '../../lib/errors.js';
import { PgWamidReplayGuard } from '../../lib/whatsapp/pg-wamid-replay-guard.js';
import { resolveGoNoGoActorFromPhone, type ResolveWhatsAppActorResult } from '../../lib/whatsapp/resolve-decision-actor.js';
import { decodeWhatsAppDecisionReplyId, encodeNoGoReasonRowId } from '../../lib/whatsapp/decision-payload.js';
import { NO_GO_REASONS } from '../../lib/whatsapp/reason-catalog.js';
import { decideGoNoGo, type DecideGoNoGoParams } from '../../modules/matching/go-no-go.routes.js';

/**
 * REQ-090 (WhatsApp como interfaz de trabajo primaria: "decide vía
 * botones/listas... nunca edita matriz o propuesta desde el chat") +
 * REQ-074 (idempotencia por `wamid`) + REQ-080 (límites de contenido) +
 * REQ-097 (red-teaming de payloads no confiables).
 *
 * Flujo real implementado (Go/No-Go, `go_no_go_decisions` -- la ÚNICA
 * decisión de negocio que hoy tiene un endpoint HTTP equivalente,
 * `POST /tenders/:id/go-no-go`, ver `modules/matching/go-no-go.routes.ts`):
 *
 *  1. La plantilla `nuevo_match_licitacion` (REQ-181, `new-tender-match-notify.ts`)
 *     ahora lleva 2 botones QUICK_REPLY ("Go"/"No-Go", texto fijo aprobado
 *     por Meta, `payload` dinámico por convocatoria) -- ver
 *     `OutboundWhatsAppMessage.buttonPayloads`.
 *  2. Tocar "Go" dispara DIRECTO `decideGoNoGo(decision:'go')` -- la MISMA
 *     función que usa la ruta HTTP, nunca una copia paralela.
 *  3. Tocar "No-Go" NO persiste nada todavía: se responde con una lista
 *     interactiva (≤10 filas, REQ-080) de motivos CERRADOS (nunca texto
 *     libre, ver `reason-catalog.ts`) -- esto es la mitad "listas" del
 *     criterio de REQ-090.
 *  4. Elegir una fila de esa lista dispara `decideGoNoGo(decision:'no_go',
 *     reasons:[...])`.
 *
 * Todo lo que entra por aquí viene de INTERNET SIN AUTENTICAR (mismo
 * encabezado de riesgo que `modules/mail/webhook.routes.ts`), así que el
 * orden de las comprobaciones es la seguridad de esta ruta:
 *
 *  1. Sin `WHATSAPP_WEBHOOK_APP_SECRET` configurado -> 503, nunca se procesa
 *     nada (falla cerrado, mismo criterio que el webhook de correo).
 *  2. Firma `X-Hub-Signature-256` sobre el cuerpo CRUDO (esquema real de
 *     Meta, ver `@atiende/whatsapp` `verifyMetaWebhookSignature`) -- parser
 *     de `application/json` propio y encapsulado, igual que el webhook de
 *     correo, para no perder el cuerpo exacto.
 *  3. Deduplicación por `wamid` (REQ-074, `PgWamidReplayGuard`): una
 *     entrega repetida del mismo mensaje (Meta reintenta si no respondemos
 *     200 a tiempo) es un no-op, nunca vuelve a disparar la decisión.
 *  4. Una firma válida SOLO prueba que Meta relayó el mensaje -- NUNCA que
 *     el número que escribió es un usuario real con permiso para decidir
 *     en la organización dueña de esa convocatoria (mismo principio que
 *     AM-03 para el webhook de correo). `resolveGoNoGoActorFromPhone`
 *     cierra esa brecha: sin usuario vinculado, sin membresía activa, o sin
 *     rol suficiente (`GO_NO_GO_ROLES`), el evento se acepta (200, Meta no
 *     debe reintentar) pero se IGNORA -- sin ningún efecto de negocio --
 *     con rastro en `audit_log`.
 */
export async function whatsappWebhookRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // Cuerpo CRUDO (punto 2 arriba) -- encapsulado en este plugin, el resto
  // de la API conserva el parser normal de Fastify.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  const replayGuard = new PgWamidReplayGuard(app.db);

  server.get(
    '/',
    {
      schema: {
        querystring: z.object({
          'hub.mode': z.string().optional(),
          'hub.verify_token': z.string().optional(),
          'hub.challenge': z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const result = resolveWebhookSubscriptionChallenge(request.query, app.config.whatsappWebhookVerifyToken);
      if (!result.ok) {
        reply.code(403);
        return 'forbidden';
      }
      reply.type('text/plain');
      return result.challenge;
    }
  );

  server.post(
    '/',
    { schema: { response: { 200: z.object({ processed: z.number() }) } } },
    async (request, reply) => {
      reply.code(200);
      const secret = app.config.whatsappWebhookAppSecret;
      if (!secret) {
        throw new AppError(
          503,
          'https://atiende.example/errors/whatsapp-webhook-not-configured',
          'El webhook de WhatsApp no está configurado (falta WHATSAPP_WEBHOOK_APP_SECRET).'
        );
      }

      const rawBody = typeof request.body === 'string' ? request.body : '';
      const signatureHeader = headerValue(request.headers['x-hub-signature-256']);
      const verification = verifyMetaWebhookSignature(rawBody, signatureHeader, secret);
      if (!verification.ok) {
        app.log.warn({ motivo: verification.reason }, 'Webhook de WhatsApp rechazado (firma inválida)');
        throw new UnauthorizedError('Firma de webhook inválida');
      }

      let json: unknown;
      try {
        json = JSON.parse(rawBody) as unknown;
      } catch {
        json = null;
      }
      const events = parseWhatsAppWebhookPayload(json);

      let processed = 0;
      for (const event of events) {
        const claimed = await replayGuard.claim(event.wamid);
        if (!claimed) continue; // REQ-074: doble entrega del mismo wamid = no-op
        await handleDecisionEvent(app, event);
        processed++;
      }

      return { processed };
    }
  );
}

async function handleDecisionEvent(app: FastifyInstance, event: WhatsAppInboundInteraction): Promise<void> {
  const decoded = decodeWhatsAppDecisionReplyId(event.replyId);
  if (decoded.kind === 'unrecognized') {
    app.log.warn({ wamid: event.wamid, replyId: event.replyId }, 'Interacción de WhatsApp con un replyId no reconocido -- ignorada');
    return;
  }

  const fromPhoneE164 = toE164FromMetaPhone(event.from);
  const resolved = await resolveGoNoGoActorFromPhone(app.db, { fromPhoneE164, tenderId: decoded.tenderId });
  if (!resolved.ok) {
    app.log.warn(
      { wamid: event.wamid, tenderId: decoded.tenderId, motivo: resolved.reason },
      'Interacción de WhatsApp aceptada pero IGNORADA: no corresponde a un usuario autorizado para decidir (REQ-090)'
    );
    await recordIgnoredWhatsAppEvent(app, { reason: resolved.reason, wamid: event.wamid, replyId: event.replyId });
    return;
  }
  const { actor } = resolved;

  if (decoded.kind === 'go') {
    await runDecision(app, { orgId: actor.orgId, userId: actor.userId, tenderId: decoded.tenderId, decision: 'go', reasons: [], source: 'whatsapp' });
    await app.whatsapp.sendText(fromPhoneE164, 'Listo — registramos tu decisión *Go* para esta convocatoria.');
    return;
  }

  if (decoded.kind === 'ask_no_go_reason') {
    await app.whatsapp.sendInteractiveList({
      to: fromPhoneE164,
      bodyText: '¿Por qué decides *No-Go* para esta convocatoria?',
      buttonText: 'Elegir motivo',
      sections: [
        {
          rows: NO_GO_REASONS.map((r) => ({
            id: encodeNoGoReasonRowId(decoded.tenderId, r.slug),
            title: r.shortLabel,
            description: r.label,
          })),
        },
      ],
    });
    return;
  }

  // decoded.kind === 'no_go_with_reason'
  await runDecision(app, {
    orgId: actor.orgId,
    userId: actor.userId,
    tenderId: decoded.tenderId,
    decision: 'no_go',
    reasons: [decoded.reasonLabel],
    source: 'whatsapp',
  });
  await app.whatsapp.sendText(fromPhoneE164, `Listo — registramos tu decisión *No-Go* (motivo: ${decoded.reasonLabel}).`);
}

/** Abre la MISMA transacción con el contexto de sesión de RLS que usa la
 *  ruta HTTP `POST /tenders/:id/go-no-go` (`set local role app_role` +
 *  `app.current_org_id`/`app.current_user_id`), fijado a partir del actor
 *  YA resuelto y autorizado por `resolveGoNoGoActorFromPhone` -- y dentro
 *  de ella llama a `decideGoNoGo`, la MISMA función de negocio que usa esa
 *  ruta (nunca una copia paralela). */
async function runDecision(app: FastifyInstance, params: DecideGoNoGoParams): Promise<void> {
  await app.db.transaction(async (tx) => {
    await tx.query('set local role app_role');
    await tx.query("select set_config('app.current_org_id', $1, true)", [params.orgId]);
    await tx.query("select set_config('app.current_user_id', $1, true)", [params.userId]);
    await decideGoNoGo(tx, params);
  });
}

function headerValue(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * Deja rastro en `audit_log` de una interacción con firma válida que se
 * descartó por no corresponder a un usuario autorizado -- mismo criterio
 * que `recordIgnoredWebhookEvent` de `modules/mail/webhook.routes.ts`
 * (AM-03): sin sesión ni organización (evento de plataforma), `db.query`
 * DIRECTO (sin `set local role app_role`), `after` nunca lleva más que
 * metadatos ya visibles en el propio webhook.
 */
type ResolveFailureReason = Extract<ResolveWhatsAppActorResult, { ok: false }>['reason'];

async function recordIgnoredWhatsAppEvent(
  app: FastifyInstance,
  params: { reason: ResolveFailureReason; wamid: string; replyId: string }
): Promise<void> {
  try {
    await app.db.query(
      `insert into audit_log (org_id, actor_id, action, entity, entity_id, after)
       values (null, null, 'whatsapp.webhook_event_ignored', 'whatsapp_webhook', $1, $2::jsonb)`,
      [params.wamid, JSON.stringify({ reason: params.reason, replyId: params.replyId })]
    );
  } catch (err) {
    app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'No se pudo registrar el evento de WhatsApp ignorado en audit_log');
  }
}
