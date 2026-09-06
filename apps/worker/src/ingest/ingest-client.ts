import { createHash } from 'node:crypto';
import { computeBackoffDelayMs } from '../queue/backoff.js';

/**
 * Espejo de `apps/api/src/modules/tenders/schemas.ts` (`tenderRecordIngestSchema`).
 * NO se importa directamente desde `apps/api` (las apps no se importan entre
 * sí, solo `packages/*`): este tipo debe mantenerse sincronizado a mano con
 * ese archivo si cambia. `mapTenderRecordToIngestRecord()` (`ingest-mapper.ts`)
 * es el único lugar que produce este shape a partir de un `TenderRecord` de
 * `@atiende/sources`.
 */
export interface TenderIngestRecord {
  source: string;
  externalId: string;
  title: string;
  contractingEntity?: string;
  cpvCodes?: string[];
  classifiers?: Array<{ scheme: string; code: string; description?: string }>;
  budgetAmount?: number;
  currency?: string;
  submissionDeadline?: string;
  publishedAt?: string;
  url?: string;
  /** Identidad de versión de origen (clave real de dedupe en apps/api: reingestar la misma es SIEMPRE no-op). */
  sourceVersion: string;
  changeKind?: 'publication' | 'amendment' | 'annex' | 'deadline_change' | 'clarification' | 'cancellation';
  rawData?: Record<string, unknown>;
}

export interface IngestTenderRequest {
  records: TenderIngestRecord[];
  /** Si se omite, apps/api replica el registro a TODAS las organizaciones existentes (ver internal-ingest.routes.ts). */
  organizationIds?: string[];
}

export interface IngestResultItem {
  source: string;
  externalId: string;
  organizationId: string;
  action: 'created' | 'updated' | 'unchanged';
  tenderId: string;
  versionId: string | null;
}

export interface IngestTenderResponse {
  results: IngestResultItem[];
  summary: { created: number; updated: number; unchanged: number; organizationsAffected: number };
}

export class IngestApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable = false,
    /**
     * WK-21 (docs/auditoria-1/worker-cierre.md): fuerza `permanent` a un
     * valor explícito cuando no hay `status` HTTP real que clasificar (p.
     * ej. el "network error" desnudo de undici para 407, ver
     * `isBareUndiciNetworkError` abajo) — sin esto, la clasificación por
     * status de `permanent` (getter, abajo) siempre daría `false` para
     * `status === undefined`, aunque el llamador ya sepa con certeza que el
     * error es permanente.
     */
    private readonly permanentOverride?: boolean,
  ) {
    super(message);
    this.name = 'IngestApiError';
  }

  /**
   * WK-10 (docs/auditoria-1/worker.md): un 4xx de `apps/api` que no sea 429
   * (rate limit, transitorio) es un error PERMANENTE — el mismo payload
   * seguirá siendo rechazado por el mismo motivo en un reintento (dato mal
   * formado, no autorizado, etc.). `Worker.process()` usa esta propiedad
   * (`isPermanentJobError`, `queue/errors.ts`) para dead-letrar de inmediato
   * en vez de gastar el ciclo completo de backoff.
   *
   * WK-20 (docs/auditoria-1/worker-cierre.md, MEDIA): antes de esta ronda,
   * 501 y 505-599 (96 códigos) quedaban fuera de `RETRYABLE_STATUS` Y fuera
   * de `[400,500)` — ni retryable ni permanent explícitos ("zona gris"),
   * dejando la clasificación real en manos del fallback genérico de
   * `Worker.process()` (backoff normal a nivel de job, no incorrecto pero
   * no documentado). Ahora la clasificación es exhaustiva para 400-599: ver
   * `isRetryableStatus()` — 501/505 (fallas ESTRUCTURALES declaradas por el
   * servidor, no van a cambiar reintentando el MISMO request) son
   * PERMANENTES explícitos; el resto de 5xx (incluida la "zona gris"
   * 502-504 ya conocida + 506-599, nunca antes clasificados) son
   * transitorios explícitos, igual que cualquier otro 5xx.
   */
  get permanent(): boolean {
    if (this.permanentOverride !== undefined) return this.permanentOverride;
    if (this.retryable) return false;
    if (this.status === undefined) return false;
    if (this.status >= 400 && this.status < 500) return true;
    // WK-20: 501/505 son permanentes explícitos aunque isRetryableStatus()
    // ya haya marcado retryable=false para ellos (este branch documenta la
    // razón; en la práctica isRetryableStatus() es la única vía real hasta
    // aquí para status>=500 con retryable=false).
    if (this.status === 501 || this.status === 505) return true;
    return false;
  }
}

export interface TenderIngestClientOptions {
  /** Base de apps/api, p. ej. `http://localhost:3000`. */
  baseUrl: string;
  /**
   * Clave compartida worker<->api para el endpoint interno (cabecera
   * `X-Platform-Api-Key`, ver `apps/api/src/plugins/auth.plugin.ts`
   * `requirePlatformApiKey` y `config.ts` `PLATFORM_API_KEY`).
   */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

/**
 * WK-17 (docs/auditoria-1/worker-reverificacion.md, cierre de WK-10
 * PARCIAL): 408 (Request Timeout) y 425 (Too Early) son, semánticamente,
 * errores TRANSITORIOS de HTTP estándar — el mismo request probablemente
 * tendría éxito en un reintento inmediato (timeout momentáneo del lado del
 * servidor bajo carga, o una ventana de reintento temprano detectada por el
 * servidor) — no un rechazo permanente del payload como un 400/401/422.
 * Antes de esta ronda, 408 caía fuera de este set y `IngestApiError.permanent`
 * lo clasificaba como PERMANENTE (cualquier 4xx no retryable), así que un
 * 408 real mataba el job en el primer intento (`deadLetterPermanent`) en vez
 * de dársele el ciclo normal de backoff. Ver tabla de verdad completa en
 * `apps/worker/test/ingest-client.test.ts` ("WK-17").
 *
 * WK-20 (docs/auditoria-1/worker-cierre.md, MEDIA): la reverificación
 * confirmó una "zona gris" de 96 códigos (501, 505-599) fuera de este set
 * de excepciones explícitas Y fuera del rango `[400,500)` que
 * `IngestApiError.permanent` marca permanente — ni retryable ni permanent
 * explícitos. Ahora la clasificación es exhaustiva para TODO 400-599:
 *  - 408/425/429: transitorios explícitos (ya lo eran).
 *  - Todo el resto de 5xx (500, 502-504 ya conocidos + la "zona gris"
 *    506-599, nunca antes clasificada) es transitorio: un error de
 *    servidor genérico puede ser momentáneo, y no hay ninguna razón
 *    estructural para no darle el mismo ciclo de reintentos que a un 500.
 *  - EXCEPCIÓN documentada: 501 (Not Implemented) y 505 (HTTP Version Not
 *    Supported) son fallas ESTRUCTURALES que el servidor declara sobre sí
 *    mismo (una funcionalidad/versión de protocolo que simplemente no
 *    soporta) — reintentar el MISMO request contra el MISMO servidor
 *    siempre fallará exactamente igual, así que se tratan como
 *    PERMANENTES explícitos (ver `IngestApiError.permanent`), igual que
 *    cualquier 4xx no-429.
 *  - El resto de 400-499 (todo salvo 408/425/429) sigue siendo permanente
 *    vía la regla `[400,500)` de `IngestApiError.permanent` — sin cambios.
 */
function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500 && status < 600) return status !== 501 && status !== 505;
  return false;
}

/**
 * Cliente HTTP para `POST {baseUrl}/internal/tenders/ingest`. Es la ÚNICA
 * vía por la que `apps/worker` hace llegar convocatorias descubiertas a la
 * base de datos: nunca escribe directamente en `tenders` (frontera de
 * paquetes, ver instrucciones de esta ronda) porque esa tabla vive en
 * `packages/db`/`apps/api`, fuera de este alcance.
 */
export class TenderIngestClient {
  constructor(private readonly options: TenderIngestClientOptions) {}

  async ingest(request: IngestTenderRequest, signal?: AbortSignal): Promise<IngestTenderResponse> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const maxRetries = this.options.maxRetries ?? 3;
    const url = new URL('/internal/tenders/ingest', this.options.baseUrl).toString();
    const body = JSON.stringify(request);
    /**
     * WK-09 (docs/auditoria-1/worker.md): cabecera `Idempotency-Key` de
     * transporte, derivada determinísticamente del CONTENIDO exacto del
     * lote (hash del cuerpo ya serializado: mismo `records` + mismo
     * `organizationIds` en el mismo orden -> misma clave). Antes de esto la
     * idempotencia dependía ENTERAMENTE de que `apps/api` deduplicara por
     * contenido (`source, externalId, sourceVersion`), sin ninguna capa de
     * defensa adicional en el transporte si ese contrato cambiara. No
     * reemplaza esa deduplicación (sigue siendo la fuente de verdad real,
     * documentado en README/tests); es una capa extra, no un sustituto.
     */
    const idempotencyKey = createHash('sha256').update(body).digest('hex');

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      if (signal?.aborted) throw new IngestApiError('ingest_abortado', undefined, false);
      const controller = new AbortController();
      const onExternalAbort = () => controller.abort();
      signal?.addEventListener('abort', onExternalAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);

      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
            ...(this.options.apiKey ? { 'x-platform-api-key': this.options.apiKey } : {}),
          },
          body,
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const retryable = isRetryableStatus(response.status);
          const error = new IngestApiError(`ingest respondió ${response.status}: ${text}`, response.status, retryable);
          if (!retryable || attempt > maxRetries) throw error;
          lastError = error;
          await sleep(computeBackoffDelayMs(attempt, { baseMs: this.options.retryBaseDelayMs ?? 500 }));
          continue;
        }

        return (await response.json()) as IngestTenderResponse;
      } catch (error) {
        if (error instanceof IngestApiError) throw error;
        const isAbort = error instanceof Error && error.name === 'AbortError';
        if (signal?.aborted) throw new IngestApiError('ingest_abortado', undefined, false);

        // WK-21 (docs/auditoria-1/worker-cierre.md, BAJA): undici (fetch
        // nativo de Node) implementa el paso del spec WHATWG fetch "si
        // response.status es 407 y request.window es 'no-window', retorna
        // un network error". Node SIEMPRE corre con window='no-window' (no
        // hay navegador), así que CUALQUIER 407 real — de un proxy saliente
        // mal configurado, o incluso de un servidor de origen que por error
        // responda 407 — hace que `fetch()` lance un `TypeError: fetch
        // failed` genérico con una `cause` VACÍA (sin `.code`, sin
        // `.message`), indistinguible A SIMPLE VISTA de cualquier otro
        // fallo de red. Confirmado empíricamente (repro aislado sin este
        // cliente): DNS trae `cause.code='ENOTFOUND'` + mensaje, ECONNRESET
        // trae `cause.code='ECONNRESET'` + mensaje, ECONNREFUSED trae
        // `cause.code='ECONNREFUSED'` + mensaje — SOLO el caso 407 produce
        // una `cause` completamente en blanco, porque no viene de una
        // excepción real de E/S sino del paso `makeNetworkError()` del spec
        // sin motivo adjunto. Es la única vía realista por la que un fetch
        // simple (sin redirecciones/CORS) contra este endpoint produce ese
        // "network error" desnudo, así que se trata como el caso 407: un
        // problema de CONFIGURACIÓN DE PROXY, PERMANENTE (reintentar el
        // mismo request no lo arregla), con mensaje explícito en vez de
        // perderse en el "fallo de red" genérico de abajo.
        if (isBareUndiciNetworkError(error)) {
          throw new IngestApiError(
            `ingest hacia ${url} falló con un "network error" desnudo de undici — indistinguible de un HTTP 407 (Proxy Authentication Required) devuelto directamente al cliente, dado que Node siempre ejecuta fetch() con window="no-window" (WHATWG fetch spec, paso de status 407). Tratado como error PERMANENTE de configuración de proxy (revisar credenciales/URL del proxy saliente) — reintentar el mismo request no lo soluciona.`,
            undefined,
            false,
            true,
          );
        }

        lastError = error;
        if (attempt > maxRetries) {
          throw new IngestApiError(
            `fallo de red hacia ${url}: ${isAbort ? 'timeout' : describeError(error)}`,
            undefined,
            true,
          );
        }
        await sleep(computeBackoffDelayMs(attempt, { baseMs: this.options.retryBaseDelayMs ?? 500 }));
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onExternalAbort);
      }
    }

    throw lastError instanceof Error ? lastError : new IngestApiError('fallo desconocido al ingerir', undefined, true);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * WK-21 (docs/auditoria-1/worker-cierre.md, BAJA): detecta el "network
 * error" desnudo que undici produce específicamente para HTTP 407 (ver
 * comentario extenso junto a su único punto de uso, arriba). La firma es:
 * `TypeError` con mensaje EXACTO `'fetch failed'` (el que usa
 * `httpFetch`/`mainFetch` de undici para cualquier `makeNetworkError()`) Y
 * una `cause` que es un `Error` real pero SIN `.code` y SIN `.message` —
 * ausencia total de detalle que ningún fallo de E/S genuino (DNS,
 * ECONNRESET, ECONNREFUSED, `bad port`, todos con `.code`/`.message` no
 * vacíos, confirmado empíricamente) produce.
 */
function isBareUndiciNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError) || error.message !== 'fetch failed') return false;
  const cause = (error as { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return false;
  return !cause.message && !('code' in cause);
}
