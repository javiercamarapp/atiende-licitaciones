import { describe, expect, it } from "vitest";
import { parseWhatsAppWebhookPayload } from "../../src/webhook/parse-payload";

function envelope(messages: unknown[]): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "525500000000", phone_number_id: "1" },
              contacts: [{ profile: { name: "Ana" }, wa_id: "525512345678" }],
              messages,
            },
          },
        ],
      },
    ],
  };
}

describe("REQ-090/074: parseWhatsAppWebhookPayload", () => {
  it("botón de respuesta rápida sobre una plantilla (type:button)", () => {
    const events = parseWhatsAppWebhookPayload(
      envelope([
        {
          id: "wamid.AAA",
          from: "525512345678",
          timestamp: "1690000000",
          type: "button",
          button: { payload: "GO:tender-1", text: "Sí, continuar" },
        },
      ])
    );
    expect(events).toEqual([
      {
        wamid: "wamid.AAA",
        from: "525512345678",
        timestampSeconds: "1690000000",
        kind: "template_quick_reply",
        replyId: "GO:tender-1",
        replyTitle: "Sí, continuar",
        raw: expect.any(Object),
      },
    ]);
  });

  it("botón de un mensaje interactivo libre (button_reply)", () => {
    const events = parseWhatsAppWebhookPayload(
      envelope([
        {
          id: "wamid.BBB",
          from: "525512345678",
          timestamp: "1690000001",
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: "NOGO:tender-1", title: "No, descartar" } },
        },
      ])
    );
    expect(events[0]).toMatchObject({ kind: "interactive_button_reply", replyId: "NOGO:tender-1", replyTitle: "No, descartar" });
  });

  it("fila elegida de una lista (list_reply)", () => {
    const events = parseWhatsAppWebhookPayload(
      envelope([
        {
          id: "wamid.CCC",
          from: "525512345678",
          timestamp: "1690000002",
          type: "interactive",
          interactive: {
            type: "list_reply",
            list_reply: { id: "NOGO_REASON:tender-1:plazo_insuficiente", title: "Plazo insuficiente", description: "" },
          },
        },
      ])
    );
    expect(events[0]).toMatchObject({ kind: "interactive_list_reply", replyId: "NOGO_REASON:tender-1:plazo_insuficiente" });
  });

  it("varios mensajes en un solo POST producen varios eventos, en orden", () => {
    const events = parseWhatsAppWebhookPayload(
      envelope([
        { id: "wamid.1", from: "1", timestamp: "1", type: "button", button: { payload: "GO:a", text: "" } },
        { id: "wamid.2", from: "1", timestamp: "2", type: "button", button: { payload: "GO:b", text: "" } },
      ])
    );
    expect(events.map((e) => e.wamid)).toEqual(["wamid.1", "wamid.2"]);
  });

  it("texto libre, imágenes u otros tipos se ignoran (no son una decisión)", () => {
    const events = parseWhatsAppWebhookPayload(
      envelope([
        { id: "wamid.txt", from: "1", timestamp: "1", type: "text", text: { body: "hola" } },
        { id: "wamid.img", from: "1", timestamp: "1", type: "image", image: { id: "img1" } },
      ])
    );
    expect(events).toEqual([]);
  });

  it("recibos de entrega/lectura (value.statuses, sin `messages`) no producen eventos ni lanzan", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ id: "W", changes: [{ field: "messages", value: { statuses: [{ id: "wamid.1", status: "delivered" }] } }] }],
    };
    expect(parseWhatsAppWebhookPayload(payload)).toEqual([]);
  });

  describe("ADVERSARIAL (REQ-097): payloads deformes/inesperados nunca lanzan, solo producen menos eventos", () => {
    it.each([
      [null],
      [undefined],
      [42],
      ["texto"],
      [[]],
      [{}],
      [{ object: "otra_cosa" }],
      [{ object: "whatsapp_business_account", entry: "no-es-arreglo" }],
      [{ object: "whatsapp_business_account", entry: [{ changes: "no-es-arreglo" }] }],
      [{ object: "whatsapp_business_account", entry: [{ changes: [{ field: "otro_campo", value: {} }] }] }],
      [{ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { messages: "no-es-arreglo" } }] }] }],
      [envelope([{ type: "button" }])],
      [envelope([{ id: "w1", from: "1", timestamp: "1", type: "button", button: { payload: 12345 } }])],
      [envelope([{ id: "w1", from: "1", timestamp: "1", type: "interactive", interactive: { type: "button_reply" } }])],
      [envelope([{ id: "w1", from: "1", timestamp: "1", type: "interactive", interactive: { type: "algo_nuevo_que_meta_agregue" } }])],
      [envelope([{ from: "1", timestamp: "1", type: "button", button: { payload: "x" } }])], // sin id
    ])("caso adversarial %#", (payload) => {
      expect(() => parseWhatsAppWebhookPayload(payload)).not.toThrow();
      expect(parseWhatsAppWebhookPayload(payload)).toEqual([]);
    });
  });
});
