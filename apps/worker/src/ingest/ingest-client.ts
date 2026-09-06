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
   */
  get permanent(): boolean {
    return !this.retryable && this.status !== undefined && this.status >= 400 && this.status < 500;
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

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

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
          const retryable = RETRYABLE_STATUS.has(response.status);
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
