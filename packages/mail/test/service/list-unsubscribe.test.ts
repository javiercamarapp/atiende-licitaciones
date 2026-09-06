import { describe, expect, it } from "vitest";
import { buildListUnsubscribeHeaders } from "../../src/service/list-unsubscribe";

describe("buildListUnsubscribeHeaders (ML-02 — RFC 8058)", () => {
  it("construye List-Unsubscribe (https + mailto) y List-Unsubscribe-Post=One-Click para una categoría NO obligatoria", () => {
    const headers = buildListUnsubscribeHeaders({
      mandatory: false,
      unsubscribeUrl: "https://app.atiende.mx/preferencias/baja?d=1&s=2",
      supportEmail: "soporte@atiende.mx",
    });

    expect(headers).toEqual({
      "List-Unsubscribe": "<https://app.atiende.mx/preferencias/baja?d=1&s=2>, <mailto:soporte@atiende.mx?subject=unsubscribe>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("devuelve undefined para una categoría OBLIGATORIA (nunca se ofrece baja de un clic en seguridad de cuenta)", () => {
    const headers = buildListUnsubscribeHeaders({
      mandatory: true,
      unsubscribeUrl: "https://app.atiende.mx/preferencias/baja?d=1&s=2",
      supportEmail: "soporte@atiende.mx",
    });
    expect(headers).toBeUndefined();
  });

  it("devuelve undefined si no hay unsubscribeUrl (aunque no sea obligatoria)", () => {
    const headers = buildListUnsubscribeHeaders({ mandatory: false, supportEmail: "soporte@atiende.mx" });
    expect(headers).toBeUndefined();
  });

  it("funciona sin supportEmail: solo la parte https en List-Unsubscribe", () => {
    const headers = buildListUnsubscribeHeaders({ mandatory: false, unsubscribeUrl: "https://app.atiende.mx/baja" });
    expect(headers).toEqual({
      "List-Unsubscribe": "<https://app.atiende.mx/baja>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("un unsubscribeUrl no-http(s)/no-localhost (ej. javascript:) se trata como ausente vía safeUrl", () => {
    const headers = buildListUnsubscribeHeaders({ mandatory: false, unsubscribeUrl: "javascript:alert(1)" });
    expect(headers).toBeUndefined();
  });
});
