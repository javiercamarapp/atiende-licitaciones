import { describe, expect, it, vi } from "vitest";
import { MailService } from "../../src/service/mail-service";
import { InMemorySendRecordStore } from "../../src/service/send-store";
import { InMemorySuppressionStore } from "../../src/suppression/types";
import { emailVerificationTemplate } from "../../src/templates/catalog/email-verification";
import { newTenderMatchTemplate } from "../../src/templates/catalog/new-tender-match";
import type { MailProvider, SendResult } from "../../src/provider/types";
import type { RegisteredRecipient } from "../../src/recipients/types";

const RECIPIENT: RegisteredRecipient = { email: "persona@ejemplo.mx", userId: "u1", status: "active" };

function fakeProvider(results: SendResult[]): { provider: MailProvider; calls: number[] } {
  const calls: number[] = [];
  let i = 0;
  const provider: MailProvider = {
    name: "fake",
    async send() {
      calls.push(Date.now());
      const result = results[Math.min(i, results.length - 1)];
      i++;
      return result!;
    },
  };
  return { provider, calls };
}

function buildService(provider: MailProvider, overrides: Partial<ConstructorParameters<typeof MailService>[0]> = {}): MailService {
  return new MailService({
    provider,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
    sleep: async () => {},
    random: () => 0.5,
    ...overrides,
  });
}

const VALID_VARS = { ...emailVerificationTemplate.sampleData };
const TENDER_MATCH_VARS = { ...newTenderMatchTemplate.sampleData };

describe("MailService.send", () => {
  it("manda con éxito al primer intento y registra el envío", async () => {
    const { provider } = fakeProvider([{ ok: true, providerMessageId: "p1" }]);
    const store = new InMemorySendRecordStore();
    const service = buildService(provider, { store });

    const outcome = await service.send({
      to: RECIPIENT,
      templateId: emailVerificationTemplate.id,
      variables: VALID_VARS,
      messageKey: "verificacion:u1",
    });

    expect(outcome).toEqual({ status: "sent", messageKey: "verificacion:u1", providerMessageId: "p1" });
    expect((await store.get("verificacion:u1"))?.status).toBe("sent");
  });

  it("es idempotente: una segunda llamada con la misma messageKey no vuelve a llamar al provider", async () => {
    const sendSpy = vi.fn().mockResolvedValue({ ok: true, providerMessageId: "p1" });
    const provider: MailProvider = { name: "fake", send: sendSpy };
    const service = buildService(provider);

    const input = { to: RECIPIENT, templateId: emailVerificationTemplate.id, variables: VALID_VARS, messageKey: "verificacion:u1" };
    const first = await service.send(input);
    const second = await service.send(input);

    expect(first.status).toBe("sent");
    expect(second).toEqual({ status: "already_sent", messageKey: "verificacion:u1", providerMessageId: "p1" });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("ML-01: es idempotente bajo llamadas CONCURRENTES (Promise.all) con la misma messageKey — exactamente 1 llega al provider", async () => {
    // Provider con latencia real simulada (setTimeout, no un `await` que se
    // resuelve en el mismo tick): si la idempotencia solo funcionara para el
    // caso secuencial (el registro `sent` ya escrito antes de la segunda
    // llamada), este escenario con 10 llamadas disparadas EN PARALELO sobre
    // la misma `messageKey` reproduciría 10 envíos reales al proveedor.
    let providerCalls = 0;
    const provider: MailProvider = {
      name: "fake",
      async send() {
        providerCalls++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ok: true, providerMessageId: `p-${providerCalls}` };
      },
    };
    const store = new InMemorySendRecordStore();
    const service = new MailService({
      provider,
      store,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
      random: () => 0.5,
    });

    const input = {
      to: RECIPIENT,
      templateId: emailVerificationTemplate.id,
      variables: VALID_VARS,
      messageKey: "verificacion:concurrente-u1",
    };

    const outcomes = await Promise.all(Array.from({ length: 10 }, () => service.send(input)));

    expect(providerCalls).toBe(1);
    expect(outcomes.filter((o) => o.status === "sent")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "already_sent")).toHaveLength(9);
    expect((await store.get("verificacion:concurrente-u1"))?.status).toBe("sent");
  });

  it("ML-08: el perdedor espera lo suficiente para ver el resultado real aunque el proveedor tarde más que los 200 ms fijos de antes", async () => {
    // Antes de ML-08, `waitForReservedRecord` esperaba como máximo 40 × 5 ms
    // = 200 ms, sin relación con cuánto puede tardar el proveedor real (cuyo
    // propio timeout de red por defecto es de varios SEGUNDOS —
    // `DEFAULT_PROVIDER_TIMEOUT_MS`). Este proveedor tarda 260 ms — más que
    // esos 200 ms fijos — para demostrar que el perdedor YA NO se rinde
    // antes de tiempo: sigue esperando (presupuesto por defecto,
    // `DEFAULT_PROVIDER_TIMEOUT_MS + 200 ms` ≈ 5.2 s) y devuelve el
    // resultado real, `providerMessageId` incluido, en vez de un
    // "already_sent" ambiguo sin id.
    let providerCalls = 0;
    const provider: MailProvider = {
      name: "fake",
      async send() {
        providerCalls++;
        await new Promise((resolve) => setTimeout(resolve, 260));
        return { ok: true, providerMessageId: "p-lento" };
      },
    };
    const store = new InMemorySendRecordStore();
    const service = new MailService({
      provider,
      store,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
      random: () => 0.5,
    });

    const input = {
      to: RECIPIENT,
      templateId: emailVerificationTemplate.id,
      variables: VALID_VARS,
      messageKey: "verificacion:lento-u1",
    };

    const outcomes = await Promise.all(Array.from({ length: 5 }, () => service.send(input)));

    expect(providerCalls).toBe(1);
    expect(outcomes.filter((o) => o.status === "sent")).toHaveLength(1);
    const losers = outcomes.filter((o) => o.status === "already_sent");
    expect(losers).toHaveLength(4);
    // La parte que ML-08 arregla: TODOS los perdedores ven el resultado real
    // (con providerMessageId), ninguno se rinde a medias camino.
    for (const loser of losers) {
      expect(loser).toMatchObject({ status: "already_sent", providerMessageId: "p-lento" });
    }
  });

  it("ML-08: el presupuesto de espera del perdedor es configurable (providerTimeoutMs) y sigue siendo acotado, nunca indefinido", async () => {
    // Con un `providerTimeoutMs` deliberadamente corto (10 ms → presupuesto
    // total de 210 ms) y un proveedor que tarda más que eso (400 ms), el
    // perdedor SÍ se rinde dentro de su presupuesto — la espera nunca es
    // indefinida — y lo declara como "already_sent" sin providerMessageId,
    // el mismo contrato documentado en `waitForReservedRecord`.
    const provider: MailProvider = {
      name: "fake",
      async send() {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { ok: true, providerMessageId: "p-tardio" };
      },
    };
    const store = new InMemorySendRecordStore();
    const service = new MailService({
      provider,
      store,
      providerTimeoutMs: 10,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
      random: () => 0.5,
    });

    const input = {
      to: RECIPIENT,
      templateId: emailVerificationTemplate.id,
      variables: VALID_VARS,
      messageKey: "verificacion:tardio-u1",
    };

    const started = Date.now();
    // Se mide el momento en que CADA llamada resuelve por separado (no
    // `Promise.all` de golpe) porque este esperaría a la más lenta de las
    // tres — el ganador, que sí tarda los 400 ms completos del proveedor. Lo
    // que ML-08 acota es la espera del PERDEDOR, no la del ganador.
    const timedOutcomes = await Promise.all(
      Array.from({ length: 3 }, () => service.send(input).then((outcome) => ({ outcome, elapsedMs: Date.now() - started }))),
    );

    const loserEntry = timedOutcomes.find((t) => t.outcome.status === "already_sent");
    expect(loserEntry?.outcome).toEqual({ status: "already_sent", messageKey: "verificacion:tardio-u1" });
    expect(loserEntry?.elapsedMs).toBeLessThan(400);
  });

  it("reintenta ante 429/5xx y termina en éxito (backoff)", async () => {
    const { provider } = fakeProvider([
      { ok: false, kind: "retryable", statusCode: 429, detail: "rate limited" },
      { ok: false, kind: "retryable", statusCode: 503, detail: "down" },
      { ok: true, providerMessageId: "p-final" },
    ]);
    const service = buildService(provider);

    const outcome = await service.send({
      to: RECIPIENT,
      templateId: emailVerificationTemplate.id,
      variables: VALID_VARS,
      messageKey: "verificacion:u2",
    });

    expect(outcome).toEqual({ status: "sent", messageKey: "verificacion:u2", providerMessageId: "p-final" });
  });

  it("un 4xx permanente NO reintenta y queda registrado como failed_permanent", async () => {
    const sendSpy = vi.fn().mockResolvedValue({ ok: false, kind: "permanent", statusCode: 422, detail: "remitente inválido" });
    const provider: MailProvider = { name: "fake", send: sendSpy };
    const store = new InMemorySendRecordStore();
    const service = buildService(provider, { store });

    const outcome = await service.send({
      to: RECIPIENT,
      templateId: emailVerificationTemplate.id,
      variables: VALID_VARS,
      messageKey: "verificacion:u3",
    });

    expect(outcome).toEqual({ status: "failed_permanent", messageKey: "verificacion:u3", detail: "remitente inválido" });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect((await store.get("verificacion:u3"))?.status).toBe("failed_permanent");
  });

  it("agota los reintentos y queda registrado como dead (outbox)", async () => {
    const sendSpy = vi.fn().mockResolvedValue({ ok: false, kind: "retryable", detail: "siempre falla" });
    const provider: MailProvider = { name: "fake", send: sendSpy };
    const store = new InMemorySendRecordStore();
    const service = buildService(provider, { store, retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } });

    const outcome = await service.send({
      to: RECIPIENT,
      templateId: emailVerificationTemplate.id,
      variables: VALID_VARS,
      messageKey: "verificacion:u4",
    });

    expect(outcome).toEqual({ status: "dead", messageKey: "verificacion:u4", detail: "siempre falla" });
    expect(sendSpy).toHaveBeenCalledTimes(3);
    expect((await store.get("verificacion:u4"))?.status).toBe("dead");
  });

  it("not_configured no se reintenta y no se registra como enviado", async () => {
    const sendSpy = vi.fn().mockResolvedValue({ ok: false, kind: "not_configured" });
    const provider: MailProvider = { name: "fake", send: sendSpy };
    const service = buildService(provider);

    const outcome = await service.send({
      to: RECIPIENT,
      templateId: emailVerificationTemplate.id,
      variables: VALID_VARS,
      messageKey: "verificacion:u5",
    });

    expect(outcome).toEqual({ status: "not_configured", messageKey: "verificacion:u5" });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("variables inválidas contra el esquema se rechazan sin llamar al provider", async () => {
    const sendSpy = vi.fn();
    const provider: MailProvider = { name: "fake", send: sendSpy };
    const service = buildService(provider);

    const outcome = await service.send({
      to: RECIPIENT,
      templateId: emailVerificationTemplate.id,
      variables: { ...VALID_VARS, appUrl: "no-es-una-url" },
      messageKey: "verificacion:u6",
    });

    expect(outcome.status).toBe("invalid_variables");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("un destinatario no registrado se rechaza sin llamar al provider", async () => {
    const sendSpy = vi.fn();
    const provider: MailProvider = { name: "fake", send: sendSpy };
    const service = buildService(provider);

    const outcome = await service.send({
      to: { email: "no-es-correo" } as RegisteredRecipient,
      templateId: emailVerificationTemplate.id,
      variables: VALID_VARS,
      messageKey: "verificacion:u7",
    });

    expect(outcome.status).toBe("unregistered_recipient");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("respeta las preferencias de notificación: categoría opcional apagada se salta sin llamar al provider", async () => {
    const sendSpy = vi.fn();
    const provider: MailProvider = { name: "fake", send: sendSpy };
    const service = buildService(provider);

    const outcome = await service.send({
      to: RECIPIENT,
      templateId: newTenderMatchTemplate.id,
      variables: TENDER_MATCH_VARS,
      messageKey: "match:u1:tender1",
      preferences: { tenderMatches: false },
    });

    expect(outcome).toEqual({ status: "skipped_preferences", messageKey: "match:u1:tender1" });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("una categoría obligatoria (account_security) ignora las preferencias del usuario", async () => {
    const { provider } = fakeProvider([{ ok: true, providerMessageId: "p1" }]);
    const service = buildService(provider);

    const outcome = await service.send({
      to: RECIPIENT,
      templateId: emailVerificationTemplate.id,
      variables: VALID_VARS,
      messageKey: "verificacion:u8",
      preferences: {}, // ninguna preferencia habilita explícitamente esto, y no debería importar
    });

    expect(outcome.status).toBe("sent");
  });

  it("un destinatario en la lista de supresión se bloquea sin llamar al provider", async () => {
    const sendSpy = vi.fn();
    const provider: MailProvider = { name: "fake", send: sendSpy };
    const suppressionStore = new InMemorySuppressionStore();
    await suppressionStore.suppress(RECIPIENT.email, "bounce", "test");
    const service = buildService(provider, { suppressionStore });

    const outcome = await service.send({
      to: RECIPIENT,
      templateId: newTenderMatchTemplate.id,
      variables: TENDER_MATCH_VARS,
      messageKey: "match:u1:tender2",
    });

    expect(outcome).toEqual({ status: "skipped_suppressed", messageKey: "match:u1:tender2" });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: si la consulta de supresión lanza, se trata como suprimido", async () => {
    const sendSpy = vi.fn();
    const provider: MailProvider = { name: "fake", send: sendSpy };
    const suppressionStore = { isSuppressed: vi.fn().mockRejectedValue(new Error("db caída")), suppress: vi.fn(), unsuppress: vi.fn(), get: vi.fn() };
    const service = buildService(provider, { suppressionStore });

    const outcome = await service.send({
      to: RECIPIENT,
      templateId: newTenderMatchTemplate.id,
      variables: TENDER_MATCH_VARS,
      messageKey: "match:u1:tender3",
    });

    expect(outcome.status).toBe("skipped_suppressed");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("ML-02: una categoría NO obligatoria manda List-Unsubscribe/List-Unsubscribe-Post al provider", async () => {
    const sendSpy = vi.fn().mockResolvedValue({ ok: true, providerMessageId: "p1" });
    const provider: MailProvider = { name: "fake", send: sendSpy };
    const service = buildService(provider);

    await service.send({
      to: RECIPIENT,
      templateId: newTenderMatchTemplate.id,
      variables: TENDER_MATCH_VARS,
      messageKey: "match:u1:headers",
    });

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          "List-Unsubscribe": `<${TENDER_MATCH_VARS.unsubscribeUrl}>, <mailto:${TENDER_MATCH_VARS.supportEmail}?subject=unsubscribe>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    );
  });

  it("ML-02: una categoría OBLIGATORIA (account_security) NUNCA manda List-Unsubscribe", async () => {
    const sendSpy = vi.fn().mockResolvedValue({ ok: true, providerMessageId: "p1" });
    const provider: MailProvider = { name: "fake", send: sendSpy };
    const service = buildService(provider);

    await service.send({
      to: RECIPIENT,
      templateId: emailVerificationTemplate.id,
      variables: VALID_VARS,
      messageKey: "verificacion:headers",
    });

    const [[sentMessage]] = sendSpy.mock.calls;
    expect(sentMessage.headers?.["List-Unsubscribe"]).toBeUndefined();
  });

  it("un destinatario NO suprimido pasa normalmente", async () => {
    const { provider } = fakeProvider([{ ok: true, providerMessageId: "p1" }]);
    const suppressionStore = new InMemorySuppressionStore();
    await suppressionStore.suppress("otra-persona@ejemplo.mx", "complaint", "test");
    const service = buildService(provider, { suppressionStore });

    const outcome = await service.send({
      to: RECIPIENT,
      templateId: emailVerificationTemplate.id,
      variables: VALID_VARS,
      messageKey: "verificacion:u9",
    });

    expect(outcome.status).toBe("sent");
  });
});

describe("MailService.signedLink / verifySignedLink", () => {
  it("lanza si no se configuró un LinkSigner", () => {
    const service = buildService({ name: "fake", send: vi.fn() });
    expect(() => service.signedLink("https://a.mx", "/x", {}, 60)).toThrow(/LinkSigner/);
    expect(() => service.verifySignedLink("https://a.mx/x")).toThrow(/LinkSigner/);
  });

  it("delega en el LinkSigner inyectado", () => {
    const linkSigner = {
      signedLink: vi.fn().mockReturnValue("https://a.mx/x?d=1&s=2"),
      verifySignedLink: vi.fn().mockReturnValue({ ok: true, payload: {} }),
    };
    const service = buildService({ name: "fake", send: vi.fn() }, { linkSigner });
    expect(service.signedLink("https://a.mx", "/x", { a: 1 }, 60)).toBe("https://a.mx/x?d=1&s=2");
    expect(service.verifySignedLink("https://a.mx/x?d=1&s=2")).toEqual({ ok: true, payload: {} });
  });
});
