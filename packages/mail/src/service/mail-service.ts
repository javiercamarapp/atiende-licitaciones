import { DEFAULT_PROVIDER_TIMEOUT_MS, type MailProvider } from "../provider/types";
import { isCategoryEnabled } from "../preferences/filter";
import type { NotificationPreferences } from "../preferences/types";
import { assertRegisteredRecipient, type RegisteredRecipient } from "../recipients/types";
import { requireTemplate } from "../templates/registry";
import type { LinkSigner, SignedLinkPayload, VerifySignedLinkResult } from "../security/signed-link";
import type { SuppressionStore } from "../suppression/types";
import { buildListUnsubscribeHeaders } from "./list-unsubscribe";
import { computeBackoffDelay, DEFAULT_RETRY_POLICY, type RetryPolicy } from "./retry";
import { UnlimitedRateLimiter, type RateLimiter } from "./rate-limiter";
import { InMemorySendRecordStore, type SendRecord, type SendRecordStore } from "./send-store";
import type { ZodIssue } from "zod";

export interface SendMailInput<V = unknown> {
  to: RegisteredRecipient | RegisteredRecipient[];
  templateId: string;
  variables: V;
  /** Llave de idempotencia del ENVÍO DE NEGOCIO (no del intento HTTP): dos
   *  llamadas con la misma llave, aunque una haya reintentado por dentro,
   *  cuentan como un solo correo. */
  messageKey: string;
  preferences?: NotificationPreferences;
  fromLocalPart?: string;
}

export type SendOutcome =
  | { status: "sent"; messageKey: string; providerMessageId: string }
  | { status: "already_sent"; messageKey: string; providerMessageId?: string }
  | { status: "skipped_preferences"; messageKey: string }
  | { status: "skipped_suppressed"; messageKey: string }
  | { status: "not_configured"; messageKey: string }
  | { status: "invalid_variables"; messageKey: string; issues: ZodIssue[] }
  | { status: "unregistered_recipient"; messageKey: string; detail: string }
  | { status: "failed_permanent"; messageKey: string; detail: string }
  | { status: "dead"; messageKey: string; detail: string };

export interface MailServiceOptions {
  provider: MailProvider;
  store?: SendRecordStore;
  /** Lista de supresión (rebotes/quejas). Opcional, pero MUY recomendada
   *  antes de mandar cualquier volumen real: ver `suppression/types.ts`. */
  suppressionStore?: SuppressionStore;
  retryPolicy?: RetryPolicy;
  rateLimiter?: RateLimiter;
  linkSigner?: LinkSigner;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /**
   * ML-08: cuánto puede tardar el `MailProvider` real en responder una sola
   * llamada — el mismo `timeoutMs` con el que se configuró el adaptador
   * (`createResendProvider`/`createPostmarkProvider`, por defecto
   * `DEFAULT_PROVIDER_TIMEOUT_MS`). El "perdedor" de `reserve()` (ver
   * `waitForReservedRecord`) usa este valor para saber cuánto esperar antes
   * de rendirse — nunca menos de lo que el ganador puede tardar en llegar a
   * un resultado final, para no devolver un "ya en curso" ambiguo mientras
   * la llamada HTTP del ganador sigue perfectamente viva.
   */
  providerTimeoutMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Intervalo de sondeo de `waitForReservedRecord` — fino frente al
 *  presupuesto total (`providerTimeoutMs + RESERVATION_WAIT_BUFFER_MS`) para
 *  no añadir una espera perceptible una vez que el ganador ya escribió. */
const RESERVATION_POLL_INTERVAL_MS = 25;

/**
 * Colchón sobre el timeout del proveedor: además del tiempo que el
 * `MailProvider` puede tardar en responder (o en que su propio
 * `AbortSignal.timeout` dispare), se le da un margen para que el ganador
 * termine su `store.save()` (o `release()`) — E/S que, aunque rápida, no es
 * instantánea. +200 ms es el margen que ML-08 pide explícitamente.
 */
const RESERVATION_WAIT_BUFFER_MS = 200;

/**
 * El punto único de envío de correo de Atiende Licitaciones. Reúne lo que
 * `apps/api`/`apps/worker` necesitan para no reinventarlo cada uno: filtro
 * de preferencias, lista de supresión, idempotencia (outbox), reintentos
 * con backoff y límite de tasa — todo antes de tocar el `MailProvider` real.
 *
 * NUNCA acepta un correo suelto como destinatario: `to` es un
 * `RegisteredRecipient` (o varios), que el llamador debe haber obtenido de
 * su propia base de usuarios. `assertRegisteredRecipient` es una segunda
 * verificación en tiempo de ejecución, no la única — el contrato de tipos
 * ya empuja al llamador a validar antes de llegar aquí.
 */
export class MailService {
  private readonly provider: MailProvider;
  private readonly store: SendRecordStore;
  private readonly suppressionStore?: SuppressionStore;
  private readonly retryPolicy: RetryPolicy;
  private readonly rateLimiter: RateLimiter;
  private readonly linkSigner?: LinkSigner;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly providerTimeoutMs: number;

  constructor(options: MailServiceOptions) {
    this.provider = options.provider;
    this.store = options.store ?? new InMemorySendRecordStore();
    this.suppressionStore = options.suppressionStore;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.rateLimiter = options.rateLimiter ?? new UnlimitedRateLimiter();
    this.linkSigner = options.linkSigner;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.providerTimeoutMs = options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  }

  /** Delega en el `LinkSigner` inyectado. Lanza si el servicio no se
   *  configuró con uno — un enlace firmado sin llave secreta no es un enlace
   *  firmado, así que es mejor fallar alto y claro que fingir que hay uno. */
  signedLink(baseUrl: string, path: string, payload: SignedLinkPayload, ttlSeconds: number): string {
    if (!this.linkSigner) throw new Error("MailService no se configuró con un LinkSigner (falta MAIL_LINK_SECRET).");
    return this.linkSigner.signedLink(baseUrl, path, payload, ttlSeconds);
  }

  verifySignedLink<T extends SignedLinkPayload = SignedLinkPayload>(url: string): VerifySignedLinkResult<T> {
    if (!this.linkSigner) throw new Error("MailService no se configuró con un LinkSigner (falta MAIL_LINK_SECRET).");
    return this.linkSigner.verifySignedLink<T>(url);
  }

  async send<V>(input: SendMailInput<V>): Promise<SendOutcome> {
    let recipients: RegisteredRecipient[];
    try {
      recipients = (Array.isArray(input.to) ? input.to : [input.to]).map(assertRegisteredRecipient);
    } catch (error) {
      return { status: "unregistered_recipient", messageKey: input.messageKey, detail: error instanceof Error ? error.message : String(error) };
    }
    if (recipients.length === 0) {
      return { status: "unregistered_recipient", messageKey: input.messageKey, detail: "Sin destinatarios." };
    }

    const template = requireTemplate(input.templateId);

    if (!isCategoryEnabled(template.category, input.preferences)) {
      return { status: "skipped_preferences", messageKey: input.messageKey };
    }

    if (this.suppressionStore) {
      // FAIL-CLOSED (§ suppression/types.ts): un error consultando la lista
      // de supresión se trata como "sí está suprimido". Nunca se manda un
      // correo cuando no se pudo confirmar que la dirección sigue siendo
      // segura de contactar.
      const anySuppressed = await Promise.all(recipients.map((r) => this.isRecipientSuppressed(r.email))).then((results) =>
        results.some(Boolean),
      );
      if (anySuppressed) {
        return { status: "skipped_suppressed", messageKey: input.messageKey };
      }
    }

    const existing = await this.store.get(input.messageKey);
    if (existing?.status === "sent") {
      return { status: "already_sent", messageKey: input.messageKey, providerMessageId: existing.providerMessageId };
    }

    const parsed = template.schema.safeParse(input.variables);
    if (!parsed.success) {
      return { status: "invalid_variables", messageKey: input.messageKey, issues: parsed.error.issues };
    }

    const rendered = await template.render(parsed.data);
    const toAddresses = recipients.map((r) => r.email);
    const rateLimitKey = toAddresses[0] ?? input.messageKey;

    // ML-02: cabeceras List-Unsubscribe/List-Unsubscribe-Post (RFC 8058) —
    // "baja de un clic" a nivel de protocolo, no solo el enlace dentro del
    // cuerpo del correo. `unsubscribeUrl`/`supportEmail` vienen de
    // `BaseVariablesSchema` (presentes en toda plantilla, aunque V esté
    // type-erased aquí); `buildListUnsubscribeHeaders` ya descarta las
    // categorías obligatorias y cualquier `unsubscribeUrl` ausente.
    const variablesAsRecord = parsed.data as { unsubscribeUrl?: unknown; supportEmail?: unknown };
    const listUnsubscribeHeaders = buildListUnsubscribeHeaders({
      mandatory: template.mandatory,
      unsubscribeUrl: typeof variablesAsRecord.unsubscribeUrl === "string" ? variablesAsRecord.unsubscribeUrl : undefined,
      supportEmail: typeof variablesAsRecord.supportEmail === "string" ? variablesAsRecord.supportEmail : undefined,
    });

    // ML-01: reserva atómica JUSTO ANTES de tocar el proveedor real — ver el
    // comentario de `SendRecordStore.reserve()`. Sin esto, dos llamadas
    // concurrentes con la misma `messageKey` ya pasaron el `get()` de arriba
    // viendo ambas "no existe" y ambas llegarían al `MailProvider`.
    const claimed = await this.store.reserve(input.messageKey);
    if (!claimed) {
      const record = await this.waitForReservedRecord(input.messageKey);
      if (record?.status === "sent") {
        return { status: "already_sent", messageKey: input.messageKey, providerMessageId: record.providerMessageId };
      }
      if (record?.status === "failed_permanent") {
        return { status: "failed_permanent", messageKey: input.messageKey, detail: record.lastError ?? "" };
      }
      if (record?.status === "dead") {
        return { status: "dead", messageKey: input.messageKey, detail: record.lastError ?? "" };
      }
      // Quien ganó la reserva no terminó de escribir un resultado final
      // dentro de la ventana de espera (o abortó sin guardar, p. ej.
      // `not_configured`): se trata como ya en curso, para nunca duplicar el
      // envío desde este lado — un reintento posterior del llamador, con la
      // misma `messageKey`, hará su propio `get()`/`reserve()` de nuevo.
      return { status: "already_sent", messageKey: input.messageKey };
    }

    let lastDetail = "";
    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt++) {
      if (!this.rateLimiter.tryConsume(rateLimitKey)) {
        lastDetail = "Límite de tasa alcanzado para este destinatario.";
        if (attempt < this.retryPolicy.maxAttempts) {
          await this.sleep(computeBackoffDelay(attempt, this.retryPolicy, this.random));
        }
        continue;
      }

      const result = await this.provider.send({
        to: toAddresses,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        fromLocalPart: input.fromLocalPart,
        idempotencyKey: input.messageKey,
        ...(listUnsubscribeHeaders ? { headers: listUnsubscribeHeaders } : {}),
      });

      if (result.ok) {
        await this.store.save({
          messageKey: input.messageKey,
          templateId: template.id,
          status: "sent",
          providerMessageId: result.providerMessageId,
          attempts: attempt,
          maxAttempts: this.retryPolicy.maxAttempts,
          updatedAt: this.now().toISOString(),
        });
        return { status: "sent", messageKey: input.messageKey, providerMessageId: result.providerMessageId };
      }

      if (result.kind === "not_configured") {
        // Se abortó antes de un resultado final del proveedor: libera la
        // reserva para que una llamada POSTERIOR (no concurrente) con la
        // misma messageKey pueda intentarlo de nuevo una vez que se
        // configure un proveedor real.
        await this.store.release?.(input.messageKey);
        return { status: "not_configured", messageKey: input.messageKey };
      }

      if (result.kind === "permanent") {
        await this.store.save({
          messageKey: input.messageKey,
          templateId: template.id,
          status: "failed_permanent",
          attempts: attempt,
          maxAttempts: this.retryPolicy.maxAttempts,
          lastError: result.detail,
          updatedAt: this.now().toISOString(),
        });
        return { status: "failed_permanent", messageKey: input.messageKey, detail: result.detail };
      }

      // retryable
      lastDetail = result.detail;
      if (attempt < this.retryPolicy.maxAttempts) {
        await this.sleep(computeBackoffDelay(attempt, this.retryPolicy, this.random));
      }
    }

    await this.store.save({
      messageKey: input.messageKey,
      templateId: template.id,
      status: "dead",
      attempts: this.retryPolicy.maxAttempts,
      maxAttempts: this.retryPolicy.maxAttempts,
      lastError: lastDetail,
      updatedAt: this.now().toISOString(),
    });
    return { status: "dead", messageKey: input.messageKey, detail: lastDetail };
  }

  private async isRecipientSuppressed(email: string): Promise<boolean> {
    try {
      return (await this.suppressionStore?.isSuppressed(email)) ?? false;
    } catch {
      return true;
    }
  }

  /**
   * Quien PIERDE `store.reserve()` espera a que quien la ganó termine de
   * escribir el registro final (`save()`), en vez de asumir cualquier
   * resultado a ciegas — así una llamada concurrente que pierde la carrera
   * puede devolver el `providerMessageId` real del envío que sí se hizo.
   *
   * ML-08: el presupuesto de espera está atado a `providerTimeoutMs`
   * (`DEFAULT_PROVIDER_TIMEOUT_MS` si no se configuró uno distinto) — es
   * decir, a lo que el `MailProvider` real puede tardar en dar un resultado
   * — más `RESERVATION_WAIT_BUFFER_MS` (+200 ms) de margen para el
   * `store.save()`/`release()` del ganador. Antes era un valor fijo
   * (40 × 5 ms = 200 ms) sin relación con el proveedor: bastaba con que el
   * envío real tardara más de esos 200 ms (nada raro en una llamada HTTP
   * real, cuyo propio timeout por defecto es de varios segundos) para que
   * el perdedor se rindiera y devolviera "ya en curso" sin saber si el
   * envío en verdad tuvo éxito, falló o murió — un resultado ambiguo.
   * Espera acotada (nunca indefinida): si nadie escribe un registro dentro
   * del presupuesto, `send()` trata la llave como "ya en curso" y no
   * reintenta por su cuenta (ver el llamador).
   */
  private async waitForReservedRecord(messageKey: string): Promise<SendRecord | undefined> {
    const budgetMs = this.providerTimeoutMs + RESERVATION_WAIT_BUFFER_MS;
    const attempts = Math.max(1, Math.ceil(budgetMs / RESERVATION_POLL_INTERVAL_MS));
    for (let attempt = 0; attempt < attempts; attempt++) {
      const record = await this.store.get(messageKey);
      if (record) return record;
      await this.sleep(RESERVATION_POLL_INTERVAL_MS);
    }
    return this.store.get(messageKey);
  }
}
