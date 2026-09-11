import { describe, expect, it } from "vitest";
import { computeHmacDigest } from "../src/hmac";
import { InMemoryWebhookReplayGuard } from "../src/replay-guard";
import { isWithinTolerance, verifyHmacWebhookSignature } from "../src/verify";

describe("isWithinTolerance", () => {
  it("acepta un timestamp dentro de la ventana", () => {
    expect(isWithinTolerance(1000, 1_000_000 /* ms */, 300)).toBe(true);
  });

  it("rechaza un timestamp fuera de la ventana", () => {
    expect(isWithinTolerance(0, 1_000_000 /* ms = 1000s */, 300)).toBe(false);
  });

  it("es simétrico: rechaza tanto un timestamp muy viejo como uno futuro", () => {
    const nowMs = 1_000_000; // 1000s
    expect(isWithinTolerance(1000 - 400, nowMs, 300)).toBe(false); // 400s en el pasado
    expect(isWithinTolerance(1000 + 400, nowMs, 300)).toBe(false); // 400s en el futuro
  });

  it("el borde exacto de la tolerancia se acepta (<=, no <)", () => {
    expect(isWithinTolerance(700, 1_000_000, 300)).toBe(true);
  });
});

const SECRET = Buffer.from("llave-de-prueba-generica-32-bytes!!");
const buildSignedContent = (rawBody: string, eventId: string) => `${eventId}.${rawBody}`;

function sign(eventId: string, rawBody: string, secret = SECRET): string {
  return computeHmacDigest(buildSignedContent(rawBody, eventId), secret, "hex");
}

describe("verifyHmacWebhookSignature", () => {
  it("acepta una firma válida sin timestamp ni replay guard", async () => {
    const rawBody = JSON.stringify({ tipo: "evento.creado" });
    const result = await verifyHmacWebhookSignature({
      rawBody,
      eventId: "evt_1",
      signatureCandidates: [sign("evt_1", rawBody)],
      secret: SECRET,
      buildSignedContent,
      encoding: "hex",
    });
    expect(result).toEqual({ ok: true });
  });

  it("rechaza firma inválida (cuerpo alterado)", async () => {
    const rawBody = JSON.stringify({ tipo: "evento.creado" });
    const firmaOriginal = sign("evt_1", rawBody);
    const result = await verifyHmacWebhookSignature({
      rawBody: JSON.stringify({ tipo: "evento.alterado" }),
      eventId: "evt_1",
      signatureCandidates: [firmaOriginal],
      secret: SECRET,
      buildSignedContent,
      encoding: "hex",
    });
    expect(result).toEqual({ ok: false, reason: "firma_invalida" });
  });

  it("rechaza firma calculada con el secreto equivocado", async () => {
    const rawBody = "{}";
    const result = await verifyHmacWebhookSignature({
      rawBody,
      eventId: "evt_1",
      signatureCandidates: [sign("evt_1", rawBody, Buffer.from("otro-secreto-distinto"))],
      secret: SECRET,
      buildSignedContent,
      encoding: "hex",
    });
    expect(result).toEqual({ ok: false, reason: "firma_invalida" });
  });

  it("rechaza un timestamp fuera de la ventana de tolerancia ANTES de mirar la firma", async () => {
    const rawBody = "{}";
    const nowMs = 1_700_000_000_000;
    const result = await verifyHmacWebhookSignature({
      rawBody,
      eventId: "evt_1",
      // Firma deliberadamente inválida: si esto devolviera "firma_invalida"
      // en vez de "timestamp_fuera_de_rango", probaría que el chequeo de
      // tiempo no se está aplicando primero.
      signatureCandidates: ["cualquier-cosa"],
      secret: SECRET,
      buildSignedContent,
      encoding: "hex",
      timestampSeconds: nowMs / 1000 - 10_000,
      toleranceSeconds: 300,
      now: () => nowMs,
    });
    expect(result).toEqual({ ok: false, reason: "timestamp_fuera_de_rango" });
  });

  it("acepta un timestamp viejo si la tolerancia se amplía explícitamente", async () => {
    const rawBody = "{}";
    const nowMs = 1_700_000_000_000;
    const timestampSeconds = nowMs / 1000 - 10_000;
    const result = await verifyHmacWebhookSignature({
      rawBody,
      eventId: "evt_1",
      signatureCandidates: [sign("evt_1", rawBody)],
      secret: SECRET,
      buildSignedContent,
      encoding: "hex",
      timestampSeconds,
      toleranceSeconds: 20_000,
      now: () => nowMs,
    });
    expect(result).toEqual({ ok: true });
  });

  it("sin replayGuard, el MISMO eventId puede verificarse varias veces (dedup es opt-in)", async () => {
    const rawBody = "{}";
    const input = {
      rawBody,
      eventId: "evt_repetido",
      signatureCandidates: [sign("evt_repetido", rawBody)],
      secret: SECRET,
      buildSignedContent,
      encoding: "hex" as const,
    };
    expect(await verifyHmacWebhookSignature(input)).toEqual({ ok: true });
    expect(await verifyHmacWebhookSignature(input)).toEqual({ ok: true });
  });

  it("con replayGuard, la SEGUNDA vez que llega el mismo eventId se rechaza como replay", async () => {
    const rawBody = "{}";
    const replayGuard = new InMemoryWebhookReplayGuard();
    const input = {
      rawBody,
      eventId: "evt_repetido",
      signatureCandidates: [sign("evt_repetido", rawBody)],
      secret: SECRET,
      buildSignedContent,
      encoding: "hex" as const,
      replayGuard,
    };
    expect(await verifyHmacWebhookSignature(input)).toEqual({ ok: true });
    expect(await verifyHmacWebhookSignature(input)).toEqual({ ok: false, reason: "replay" });
  });

  it("una firma inválida NUNCA reclama el eventId del replay guard (no puede 'gastar' un id legítimo futuro)", async () => {
    const rawBody = "{}";
    const replayGuard = new InMemoryWebhookReplayGuard();

    const invalido = await verifyHmacWebhookSignature({
      rawBody,
      eventId: "evt_1",
      signatureCandidates: ["firma-forjada-invalida"],
      secret: SECRET,
      buildSignedContent,
      encoding: "hex",
      replayGuard,
    });
    expect(invalido).toEqual({ ok: false, reason: "firma_invalida" });
    expect(replayGuard.size()).toBe(0);

    // La petición LEGÍTIMA con el mismo eventId debe poder pasar después.
    const valido = await verifyHmacWebhookSignature({
      rawBody,
      eventId: "evt_1",
      signatureCandidates: [sign("evt_1", rawBody)],
      secret: SECRET,
      buildSignedContent,
      encoding: "hex",
      replayGuard,
    });
    expect(valido).toEqual({ ok: true });
  });
});
