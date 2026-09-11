import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { DbClient } from '@atiende/db';
import { MEMBERSHIP_ADMIN_ROLES } from '@atiende/db';
import { classifyVoiceInteraction, DISCLOSURE_MESSAGE_VOZ, RESPUESTA_FIJA_ES_HUMANO } from '@atiende/agents';
import { NotFoundError, UnauthorizedError, ForbiddenError } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { requireOrgRole } from '../../lib/authorize.js';
import { voiceConfigPatchSchema, voiceConfigSchema, voiceSecretRotationSchema, VOZ_TOOL_NAMES, VOZ_TOOL_PARAM_SCHEMAS, type VozToolName } from './schemas.js';

/**
 * REQ-092/REQ-093 (docs/REQUISITOS.md §21): telefonía/voz REAL del canal de
 * consultas y recordatorios con ElevenLabs Conversational AI -- MISMO PATRÓN
 * ya usado en los repos hermanos atiende-hoteles/atiende-restaurantes (ver
 * apps/api/src/routes/vozElevenlabs.ts de atiende-hoteles): ElevenLabs
 * maneja telefonía + modelo de voz de punta a punta vía su propia
 * plataforma de agentes conversacionales -- nosotros somos el RECEPTOR de
 * sus llamadas de herramienta (tool webhook), nunca el llamador de su API.
 * Ese repo hermano usa Hono; este usa Fastify (mismo patrón de módulo que
 * `modules/mail/webhook.routes.ts` de ESTE repo) -- el ajuste de framework
 * es solo el transporte, la lógica de secreto por tenant/catálogo cerrado/
 * guardrail es la MISMA idea.
 *
 * HONESTIDAD ("esqueleto honesto", ver CLAUDE.md de este repo): este
 * archivo implementa la llamada HTTP REAL que ElevenLabs hace a nuestro
 * backend cuando su modelo decide invocar una herramienta -- por eso SÍ se
 * puede probar de verdad sin ninguna credencial de ElevenLabs (ver
 * apps/api/test/voice-webhook.test.ts, que firma/llama exactamente como
 * ElevenLabs documenta que lo hace). NO existe cuenta real de ElevenLabs
 * conectada en este entorno: nada aquí se ha ejercitado contra una llamada
 * telefónica real todavía. `verificado_contra_real=false` explícito en cada
 * punto donde el contrato exacto de ElevenLabs no se pudo confirmar contra
 * una cuenta real (ver `extractToolParams` abajo) -- ver
 * docs/agente-voz/README.md para el runbook manual pendiente completo
 * (crear el agente en el dashboard de ElevenLabs, pegar
 * `disclosureMessage`/`respuestaFijaEsHumano` en su configuración,
 * registrar cada tool webhook, comprar/portar el número).
 *
 * LÍMITE ARQUITECTÓNICO EXPLÍCITO de REQ-093 en este canal (distinto de
 * WhatsApp, donde `mensajeria.ts` SÍ intercepta cada mensaje entrante ANTES
 * de llamar al LLM, ver `esPreguntaSiEsHumano` ahí): ElevenLabs es dueño del
 * loop de conversación de punta a punta (STT + diálogo + TTS) -- este
 * webhook SOLO se invoca cuando su modelo decide llamar una de las 5
 * herramientas de abajo, nunca en cada turno de voz. Por eso el disclosure
 * de primer turno y la respuesta fija a "¿eres humano?" NO pueden
 * interceptarse aquí con la misma garantía que WhatsApp: `disclosureMessage`/
 * `respuestaFijaEsHumano` (reexportados de `@atiende/agents`, MISMA fuente
 * de verdad que WhatsApp reutilizaría si se conectara) se exponen en
 * `GET /voice/config` para que quien configure el agente en el dashboard de
 * ElevenLabs los pegue TAL CUAL como "first message"/instrucción de sistema
 * -- un paso manual, documentado como pendiente honesto, no una garantía de
 * código. Lo que SÍ se aplica en código, con la misma garantía que
 * WhatsApp, es `classifyVoiceInteraction` sobre el ÚNICO campo de texto
 * libre que este catálogo acepta (`programar-recordatorio.message`): ahí
 * SÍ se detecta "confirmo"/intentos fuera de alcance ANTES de encolar nada
 * (REQ-092).
 *
 * SEGURIDAD/GOBIERNO:
 *   1. Secreto POR ORGANIZACIÓN (`voice_agent_config.tool_webhook_secret`,
 *      migración 0100), nunca uno global -- una organización nunca puede
 *      invocar las tools de voz de otra.
 *   2. Catálogo CERRADO a exactamente 5 tools (`VOZ_TOOL_NAMES`): las 4
 *      lecturas ya existentes de `apps/worker/src/agents/business-tools.ts`
 *      (`listar_convocatorias`/`leer_bases`/`leer_perfil_empresa`/
 *      `resumir_cambios_convocatoria`) + `programar_alerta` (recordatorio
 *      interno). Deliberadamente NO se reimporta ese registro de
 *      `apps/worker` (apps independientes, sin dependencia cruzada, mismo
 *      criterio que `lib/agent-triggers.ts` documenta para `jobs`) -- las
 *      consultas SQL de abajo son la MISMA lectura, ejecutada directamente
 *      contra las mismas tablas, filtrada explícitamente por `org_id`. Ni
 *      `set_final_price` (REQ-068/authorization.ts DEFAULT_PROHIBITED_ACTIONS)
 *      ni ninguna tool de firma/portal/contacto a terceros
 *      (DEFAULT_HARD_PROHIBITED_ACTIONS) existen siquiera en este catálogo:
 *      ni un modelo de voz totalmente comprometido podría invocarlas.
 *   3. Esta ruta SIEMPRE usa la conexión "cruda" de `app.db` (SIN `SET LOCAL
 *      ROLE app_role`), el MISMO patrón ya documentado y aceptado en
 *      `modules/tenders/internal-ingest.routes.ts` y
 *      `modules/mail/webhook.routes.ts`: ElevenLabs no es un miembro humano
 *      de la organización, así que RLS por membresía no aplica -- el
 *      aislamiento real lo da el filtro EXPLÍCITO `org_id = $1` (el mismo
 *      `orgId` cuyo secreto ya se verificó) en cada consulta.
 */

interface VoiceAgentConfigRow {
  id: string;
  elevenlabs_agent_id: string | null;
  tool_webhook_secret: string;
  enabled: boolean;
}

const VOICE_CONFIG_SELECT = 'select id, elevenlabs_agent_id, tool_webhook_secret, enabled from voice_agent_config where org_id = $1';

async function ensureVoiceAgentConfig(db: DbClient, orgId: string): Promise<VoiceAgentConfigRow> {
  const { rows } = await db.query<VoiceAgentConfigRow>(VOICE_CONFIG_SELECT, [orgId]);
  if (rows[0]) return rows[0];
  const secret = randomUUID();
  await db.query(
    `insert into voice_agent_config (org_id, tool_webhook_secret) values ($1, $2) on conflict (org_id) do nothing`,
    [orgId, secret]
  );
  const { rows: after } = await db.query<VoiceAgentConfigRow>(VOICE_CONFIG_SELECT, [orgId]);
  return after[0]!;
}

/** Comparación en tiempo constante sobre los digests SHA-256 de ambos valores (evita filtrar
 *  la LONGITUD del secreto real -- `timingSafeEqual` exige buffers del mismo tamaño). */
function secretMatches(received: string | null | undefined, expected: string): boolean {
  if (!received) return false;
  const a = createHash('sha256').update(received, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * ElevenLabs documenta el webhook de una tool con DOS formas posibles según
 * la versión/configuración exacta del tool (`verificado_contra_real=false`:
 * no se pudo confirmar contra una cuenta real en este entorno, ver
 * docstring del archivo): (a) el cuerpo ES literalmente los parámetros
 * declarados del tool; (b) `{ tool_call_id, tool_name, parameters,
 * conversation_id }`. Se acepta CUALQUIERA de las dos formas -- si llega un
 * objeto `parameters`, se usa ese; si no, se usa el cuerpo completo.
 */
function extractToolParams(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const looksLikeEnvelope =
      obj.parameters !== null &&
      typeof obj.parameters === 'object' &&
      !Array.isArray(obj.parameters) &&
      (typeof obj.tool_name === 'string' || typeof obj.tool_call_id === 'string');
    if (looksLikeEnvelope) return obj.parameters as Record<string, unknown>;
    return obj;
  }
  return {};
}

function toolResult(body: Record<string, unknown>) {
  return { result: body };
}

interface TenderRow {
  id: string;
  title: string;
  status: string;
  source: string;
  submission_deadline: string | Date | null;
}

export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // ---------------------------------------------------------------------
  // Webhook PÚBLICO -- registrado SIN preHandler de sesión de staff (ver
  // docstring del archivo, punto 3). `:toolName` debe ser uno de
  // VOZ_TOOL_NAMES; cualquier otro valor es 404 (catálogo cerrado).
  // ---------------------------------------------------------------------
  server.post('/webhooks/voz/:orgId/:toolName', async (request, reply) => {
    const { orgId, toolName: toolNameParam } = request.params as { orgId: string; toolName: string };
    const secretHeader = request.headers['x-atiende-voz-tool-secret'];

    if (!(VOZ_TOOL_NAMES as string[]).includes(toolNameParam)) {
      throw new NotFoundError(`Tool de voz desconocida: "${toolNameParam}".`);
    }
    const toolName = toolNameParam as VozToolName;

    const { rows: configRows } = await app.db.query<VoiceAgentConfigRow>(
      'select id, elevenlabs_agent_id, tool_webhook_secret, enabled from voice_agent_config where org_id = $1',
      [orgId]
    );
    const config = configRows[0];
    if (!config) throw new NotFoundError('Esta organización no tiene el agente de voz configurado.');
    if (!secretMatches(typeof secretHeader === 'string' ? secretHeader : null, config.tool_webhook_secret)) {
      throw new UnauthorizedError('Secreto de webhook de voz inválido o ausente.');
    }
    if (!config.enabled) {
      throw new ForbiddenError('El agente de voz de esta organización todavía no está activado (voice_agent_config.enabled=false).');
    }

    const raw = (request.body ?? {}) as unknown;
    const params = extractToolParams(raw);

    const paramSchema = VOZ_TOOL_PARAM_SCHEMAS[toolName];
    const parsed = paramSchema.safeParse(params);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      reply.code(400);
      return { error: `entrada inválida para "${toolName}": ${first?.path?.join('.') || '(input)'} — ${first?.message ?? 'valor inválido'}` };
    }

    if (toolName === 'programar-recordatorio') {
      const input = parsed.data as z.infer<(typeof VOZ_TOOL_PARAM_SCHEMAS)['programar-recordatorio']>;

      // REQ-092: guardrail sobre el ÚNICO campo de texto libre de todo este
      // catálogo -- "confirmo"/intentos de fijar precio, firmar o actuar en
      // un portal NUNCA se encolan, sin importar qué diga `message` (ver
      // docstring del archivo). Se evalúa ANTES de tocar `jobs`.
      const decision = classifyVoiceInteraction(input.message);
      if (decision && decision.kind !== 'es_humano') {
        await recordVoiceGuardrailEvent(app.db, { orgId, toolName, decisionKind: decision.kind, requestId: request.id });
        return toolResult({ ok: false, ejecutado: false, mensaje: decision.guestFacingMessage });
      }

      const tenderRes = await app.db.query<{ id: string }>('select id from tenders where id = $1 and org_id = $2', [input.tenderId, orgId]);
      if (!tenderRes.rows[0]) {
        reply.code(404);
        return { error: 'No se encontró la convocatoria en esta organización.' };
      }

      const jobKey = `agent_alert:${orgId}:${input.tenderId}:${input.kind}:${input.scheduledFor}`;
      const enqueued = await enqueueSendAgentAlertJob(app.db, {
        orgId,
        jobKey,
        runAt: new Date(input.scheduledFor),
        payload: { organizationId: orgId, tenderId: input.tenderId, kind: input.kind, message: input.message },
      });

      return toolResult({ ok: true, ejecutado: true, jobId: enqueued.jobId, deduped: enqueued.deduped, scheduledFor: input.scheduledFor });
    }

    if (toolName === 'listar-convocatorias') {
      const input = parsed.data as z.infer<(typeof VOZ_TOOL_PARAM_SCHEMAS)['listar-convocatorias']>;
      const limit = input.limit ?? 10;
      const { rows } = input.status
        ? await app.db.query<TenderRow>(
            'select id, title, status, source, submission_deadline from tenders where org_id = $1 and status = $2 order by created_at desc limit $3',
            [orgId, input.status, limit]
          )
        : await app.db.query<TenderRow>(
            'select id, title, status, source, submission_deadline from tenders where org_id = $1 order by created_at desc limit $2',
            [orgId, limit]
          );
      return toolResult({
        tenders: rows.map((r) => ({
          id: r.id,
          title: r.title,
          status: r.status,
          source: r.source,
          submissionDeadline: r.submission_deadline ? new Date(r.submission_deadline).toISOString() : null,
        })),
      });
    }

    if (toolName === 'leer-bases') {
      const input = parsed.data as z.infer<(typeof VOZ_TOOL_PARAM_SCHEMAS)['leer-bases']>;
      const reqs = await app.db.query<{ id: string; category: string; description: string; is_mandatory: boolean }>(
        `select id, category, description, is_mandatory from requirement_items
         where org_id = $1 and tender_id = $2 and invalidated_at is null`,
        [orgId, input.tenderId]
      );
      return toolResult({
        tenderId: input.tenderId,
        requirements: reqs.rows.map((r) => ({ id: r.id, category: r.category, description: r.description, isMandatory: r.is_mandatory })),
      });
    }

    if (toolName === 'leer-perfil-empresa') {
      const profile = await app.db.query<{ legal_name: string; sector: string | null }>(
        'select legal_name, sector from company_profiles where org_id = $1',
        [orgId]
      );
      const caps = await app.db.query<{ name: string; is_verified: boolean }>('select name, is_verified from capabilities where org_id = $1', [
        orgId,
      ]);
      return toolResult({
        profile: profile.rows[0] ? { legalName: profile.rows[0].legal_name, sector: profile.rows[0].sector } : null,
        capabilities: caps.rows.map((c) => ({ name: c.name, isVerified: c.is_verified })),
      });
    }

    // toolName === 'resumir-cambios-convocatoria'
    {
      const input = parsed.data as z.infer<(typeof VOZ_TOOL_PARAM_SCHEMAS)['resumir-cambios-convocatoria']>;
      const events = await app.db.query<{ id: string; change_kind: string; summary: string | null; created_at: string }>(
        `select id, change_kind, summary, created_at from tender_change_events
         where org_id = $1 and tender_id = $2 order by created_at desc limit 10`,
        [orgId, input.tenderId]
      );
      return toolResult({
        tenderId: input.tenderId,
        changeEvents: events.rows.map((e) => ({
          id: e.id,
          changeKind: e.change_kind,
          summary: e.summary,
          effectiveAt: new Date(e.created_at).toISOString(),
        })),
      });
    }
  });

  // ---------------------------------------------------------------------
  // Configuración del agente de voz (owner/admin) -- sesión de staff normal.
  // ---------------------------------------------------------------------
  server.get(
    '/voice/config',
    { preHandler: [app.authenticate, app.requireOrg], schema: { response: { 200: voiceConfigSchema } } },
    async (request) => {
      requireOrgRole(request, MEMBERSHIP_ADMIN_ROLES, 'Solo owner/admin pueden ver la configuración del agente de voz');
      const orgId = request.orgId!;
      const config = await ensureVoiceAgentConfig(app.db, orgId);
      return {
        elevenlabsAgentId: config.elevenlabs_agent_id,
        toolWebhookSecret: config.tool_webhook_secret,
        habilitado: config.enabled,
        webhookUrls: Object.fromEntries(VOZ_TOOL_NAMES.map((name) => [name, `/webhooks/voz/${orgId}/${name}`])),
        disclosureMessage: DISCLOSURE_MESSAGE_VOZ,
        respuestaFijaEsHumano: RESPUESTA_FIJA_ES_HUMANO,
      };
    }
  );

  server.patch(
    '/voice/config',
    { preHandler: [app.authenticate, app.requireOrg], schema: { body: voiceConfigPatchSchema, response: { 200: voiceConfigSchema } } },
    async (request) => {
      requireOrgRole(request, MEMBERSHIP_ADMIN_ROLES, 'Solo owner/admin pueden editar la configuración del agente de voz');
      const orgId = request.orgId!;
      const current = await ensureVoiceAgentConfig(app.db, orgId);
      const body = request.body;

      const elevenlabsAgentId = body.elevenlabsAgentId !== undefined ? body.elevenlabsAgentId : current.elevenlabs_agent_id;
      const enabled = body.habilitado ?? current.enabled;

      await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        await tx.query('update voice_agent_config set elevenlabs_agent_id = $1, enabled = $2 where org_id = $3', [
          elevenlabsAgentId,
          enabled,
          orgId,
        ]);
        await recordAudit(tx, {
          orgId,
          actorId: request.userId!,
          action: 'voice_agent_config.update',
          entity: 'voice_agent_config',
          entityId: current.id,
          after: { elevenlabsAgentId, habilitado: enabled },
          requestId: request.id,
          correlationId: request.correlationId,
        });
      });

      return {
        elevenlabsAgentId,
        toolWebhookSecret: current.tool_webhook_secret,
        habilitado: enabled,
        webhookUrls: Object.fromEntries(VOZ_TOOL_NAMES.map((name) => [name, `/webhooks/voz/${orgId}/${name}`])),
        disclosureMessage: DISCLOSURE_MESSAGE_VOZ,
        respuestaFijaEsHumano: RESPUESTA_FIJA_ES_HUMANO,
      };
    }
  );

  server.post(
    '/voice/config/rotar-secreto',
    { preHandler: [app.authenticate, app.requireOrg], schema: { response: { 200: voiceSecretRotationSchema } } },
    async (request) => {
      requireOrgRole(request, MEMBERSHIP_ADMIN_ROLES, 'Solo owner/admin pueden rotar el secreto del webhook de voz');
      const orgId = request.orgId!;
      const current = await ensureVoiceAgentConfig(app.db, orgId);
      const nuevoSecreto = randomUUID();

      await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        await tx.query('update voice_agent_config set tool_webhook_secret = $1 where org_id = $2', [nuevoSecreto, orgId]);
        await recordAudit(tx, {
          orgId,
          actorId: request.userId!,
          action: 'voice_agent_config.rotate_secret',
          entity: 'voice_agent_config',
          entityId: current.id,
          requestId: request.id,
          correlationId: request.correlationId,
        });
      });

      return { toolWebhookSecret: nuevoSecreto };
    }
  );

}

/**
 * Inserta un job `send_agent_alert` (mismo `kind`/payload/handler que
 * `apps/worker/src/handlers/send-agent-alert.ts` ya consume) directamente,
 * SIN reimportar `JobQueue` de `apps/worker` -- mismo criterio que
 * `lib/agent-triggers.ts` documenta: la tabla `jobs` es el contrato
 * compartido real entre ambos procesos, no una clase de un app ajeno.
 * Dedupe por `(kind, payload->>'jobKey')` con `pg_advisory_xact_lock`, MISMO
 * mecanismo que `JobQueue.enqueue` (`apps/worker/src/queue/job-queue.ts`).
 */
async function enqueueSendAgentAlertJob(
  db: DbClient,
  params: { orgId: string; jobKey: string; runAt: Date; payload: Record<string, unknown> }
): Promise<{ jobId: string; deduped: boolean }> {
  return db.transaction(async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtext($1)::bigint)', [`send_agent_alert:${params.jobKey}`]);
    const existing = await tx.query<{ id: string }>(
      `select id from jobs where kind = 'send_agent_alert' and payload ->> 'jobKey' = $1 and status in ('queued', 'running')
       order by created_at desc limit 1`,
      [params.jobKey]
    );
    if (existing.rows[0]) return { jobId: existing.rows[0].id, deduped: true };

    const fullPayload = { ...params.payload, jobKey: params.jobKey };
    const inserted = await tx.query<{ id: string }>(
      `insert into jobs (org_id, kind, payload, max_attempts, next_run_at) values ($1, 'send_agent_alert', $2::jsonb, 5, $3) returning id`,
      [params.orgId, JSON.stringify(fullPayload), params.runAt.toISOString()]
    );
    return { jobId: inserted.rows[0]!.id, deduped: false };
  });
}

/**
 * AG-07 (mismo patrón que `guardrails/anticorruption.ts`): registra en
 * `audit_log` (org_id real, actor_id null -- este webhook no representa a
 * ningún usuario humano) cada vez que `classifyVoiceInteraction` bloqueó un
 * intento por el canal de voz, para que quede un rastro auditable de
 * intentos de "confirmar" una acción sensible por teléfono. Nunca lanza:
 * "registrar nunca debe lanzar ni tumbar el bloqueo ya decidido" (mismo
 * criterio que el resto de guardrails de este repo).
 */
async function recordVoiceGuardrailEvent(
  db: DbClient,
  entry: { orgId: string; toolName: string; decisionKind: string; requestId: string }
): Promise<void> {
  try {
    await recordAudit(db, {
      orgId: entry.orgId,
      actorId: null,
      action: 'voice.guardrail_blocked',
      entity: 'voice_agent_config',
      after: { toolName: entry.toolName, decisionKind: entry.decisionKind },
      requestId: entry.requestId,
    });
  } catch {
    // Registrar nunca debe tumbar la respuesta de rechazo ya decidida.
  }
}
