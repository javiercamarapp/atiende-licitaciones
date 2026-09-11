import { describe, expect, it } from "vitest";
import {
  MAX_LIST_ROWS_TOTAL,
  MAX_QUICK_REPLY_BUTTONS,
  validateButtonPayloads,
  validateInteractiveListMessage,
} from "../../src/provider/content-limits";
import type { OutboundInteractiveListMessage } from "../../src/provider/types";

/**
 * REQ-080: "Límite de 3 botones y listas de 10 opciones en mensajes de
 * WhatsApp (límite de la API)" — "Test de contrato de contenido de
 * mensajes".
 */
describe("REQ-080: validateButtonPayloads", () => {
  it("sin buttonPayloads (o vacío) es válido — plantillas sin botones siguen funcionando", () => {
    expect(validateButtonPayloads(undefined)).toEqual({ ok: true });
    expect(validateButtonPayloads([])).toEqual({ ok: true });
  });

  it(`hasta ${MAX_QUICK_REPLY_BUTTONS} botones es válido`, () => {
    expect(validateButtonPayloads(["GO:1"])).toEqual({ ok: true });
    expect(validateButtonPayloads(["GO:1", "NOGO:1", "MAS_INFO:1"])).toEqual({ ok: true });
  });

  it(`más de ${MAX_QUICK_REPLY_BUTTONS} botones se rechaza`, () => {
    const result = validateButtonPayloads(["a", "b", "c", "d"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("4 botones");
  });

  it("un payload vacío se rechaza", () => {
    const result = validateButtonPayloads(["GO:1", ""]);
    expect(result.ok).toBe(false);
  });
});

function listMessage(rows: number, overrides: Partial<OutboundInteractiveListMessage> = {}): OutboundInteractiveListMessage {
  return {
    to: "+525512345678",
    bodyText: "¿Por qué decides No-Go?",
    buttonText: "Elegir razón",
    sections: [{ rows: Array.from({ length: rows }, (_, i) => ({ id: `r${i}`, title: `Razón ${i}` })) }],
    ...overrides,
  };
}

describe("REQ-080: validateInteractiveListMessage", () => {
  it(`hasta ${MAX_LIST_ROWS_TOTAL} filas EN TOTAL (sumando secciones) es válido`, () => {
    expect(validateInteractiveListMessage(listMessage(MAX_LIST_ROWS_TOTAL)).ok).toBe(true);
  });

  it(`más de ${MAX_LIST_ROWS_TOTAL} filas en una sola sección se rechaza`, () => {
    const result = validateInteractiveListMessage(listMessage(MAX_LIST_ROWS_TOTAL + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("11 filas");
  });

  it(`más de ${MAX_LIST_ROWS_TOTAL} filas repartidas en VARIAS secciones también se rechaza (el límite es total, no por sección)`, () => {
    const result = validateInteractiveListMessage({
      to: "+525512345678",
      bodyText: "b",
      buttonText: "Elegir",
      sections: [
        { title: "A", rows: Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, title: `A${i}` })) },
        { title: "B", rows: Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, title: `B${i}` })) },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("sin secciones o sin filas se rechaza", () => {
    expect(validateInteractiveListMessage(listMessage(0)).ok).toBe(false);
    expect(validateInteractiveListMessage({ ...listMessage(1), sections: [] }).ok).toBe(false);
  });

  it("un título de fila demasiado largo se rechaza", () => {
    const result = validateInteractiveListMessage(
      listMessage(1, { sections: [{ rows: [{ id: "r0", title: "X".repeat(30) }] }] })
    );
    expect(result.ok).toBe(false);
  });

  it("una descripción de fila demasiado larga se rechaza", () => {
    const result = validateInteractiveListMessage(
      listMessage(1, { sections: [{ rows: [{ id: "r0", title: "ok", description: "X".repeat(80) }] }] })
    );
    expect(result.ok).toBe(false);
  });

  it("ids de fila repetidos dentro de la misma lista se rechazan", () => {
    const result = validateInteractiveListMessage({
      ...listMessage(0),
      sections: [{ rows: [{ id: "dup", title: "uno" }, { id: "dup", title: "dos" }] }],
    });
    expect(result.ok).toBe(false);
  });

  it("un texto de botón demasiado largo se rechaza", () => {
    const result = validateInteractiveListMessage(listMessage(1, { buttonText: "X".repeat(30) }));
    expect(result.ok).toBe(false);
  });
});
