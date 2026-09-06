import { describe, expect, it } from "vitest";
import { assertExplicitOffset, isPast, sha256Hex } from "../src/types.js";

/**
 * EX-EXP-04/EX-EXP-13 (reverificación ronda 1): `assertExplicitOffset`
 * validaba solo el FORMATO del offset (`±HH:MM`), no su rango numérico
 * (00-23 horas, 00-59 minutos) ni la validez calendárica de la fecha. Un
 * offset imposible como `"+99:00"` pasaba, producía `Invalid Date` (`NaN`),
 * e `isPast()` evaluaba `NaN < NaN` como `false` — la fecha corrupta se
 * trataba como "nunca vencida" (fail-open) en vez de lanzar. Ahora
 * cualquier fecha inválida lanza explícitamente (fail-closed): NUNCA
 * "no vencido".
 */
describe("assertExplicitOffset — EX-EXP-04/EX-EXP-13: rango de offset y validez calendárica (fail-closed)", () => {
  it("acepta offsets válidos en todo el rango real (-12:00 a +14:00) y 'Z'", () => {
    for (const iso of [
      "2026-10-20T12:00:00Z",
      "2026-10-20T12:00:00-06:00",
      "2026-10-20T12:00:00-12:00",
      "2026-10-20T12:00:00+14:00",
      "2026-10-20T12:00:00+00:00",
    ]) {
      expect(() => assertExplicitOffset(iso)).not.toThrow();
    }
  });

  it("rechaza un offset numéricamente imposible '+99:00' (EX-EXP-13, hallazgo grave: antes era fail-open)", () => {
    expect(() => assertExplicitOffset("2026-09-05T23:59:59+99:00")).toThrow(/offset horario fuera del rango válido/);
  });

  it("rechaza offsets fuera de -12:00/+14:00 aunque el formato de 2 dígitos sea válido", () => {
    expect(() => assertExplicitOffset("2026-09-05T23:59:59+15:00")).toThrow(/offset horario fuera del rango válido/);
    expect(() => assertExplicitOffset("2026-09-05T23:59:59-13:00")).toThrow(/offset horario fuera del rango válido/);
  });

  it("rechaza minutos de offset fuera de 00-59", () => {
    expect(() => assertExplicitOffset("2026-09-05T23:59:59+05:75")).toThrow(/minutos de offset horario/);
  });

  it("rechaza una fecha calendáricamente inválida '2026-02-30' (EX-EXP-13: Date la reinterpretaría en silencio como 1 de marzo)", () => {
    expect(() => assertExplicitOffset("2026-02-30T00:00:00-06:00")).toThrow(/día calendárico inválido/);
  });

  it("rechaza el 29 de febrero en un año NO bisiesto (2026), acepta el mismo día en un año bisiesto (2028)", () => {
    expect(() => assertExplicitOffset("2026-02-29T00:00:00-06:00")).toThrow(/día calendárico inválido/);
    expect(() => assertExplicitOffset("2028-02-29T00:00:00-06:00")).not.toThrow();
  });

  it("rechaza un mes calendárico inválido (13)", () => {
    expect(() => assertExplicitOffset("2026-13-01T00:00:00-06:00")).toThrow(/mes calendárico inválido/);
  });

  it("rechaza una cadena vacía (fail-closed, nunca 'no vencido')", () => {
    expect(() => assertExplicitOffset("")).toThrow();
    expect(() => assertExplicitOffset("   ")).toThrow();
  });

  it("defensa final: una cadena con forma de offset válida ('Z') pero que no es una fecha real también se rechaza", () => {
    // No matchea el formato "AAAA-MM-DD..." (así que `assertValidCalendarComponents`
    // no la detecta) ni tiene un offset numérico "±HH:MM" que validar, pero
    // termina en "Z" — ejercita la defensa final `Number.isNaN` de
    // `assertExplicitOffset`, no las validaciones de rango/calendario.
    expect(() => assertExplicitOffset("not-a-date-Z")).toThrow(/no representa una fecha válida/);
  });

  it("rechaza null/undefined/no-string sin lanzar un TypeError distinto al esperado", () => {
    // @ts-expect-error prueba deliberada de un valor no-string
    expect(() => assertExplicitOffset(null)).toThrow();
    // @ts-expect-error prueba deliberada de un valor no-string
    expect(() => assertExplicitOffset(undefined)).toThrow();
  });
});

describe("isPast — EX-EXP-04/EX-EXP-13: nunca compara NaN, siempre falla cerrado ante una fecha inválida", () => {
  const ASOF = "2026-10-20T12:00:00-06:00";

  it("un offset imposible en la fecha límite lanza en vez de responder 'no vencido'", () => {
    expect(() => isPast("2026-09-05T23:59:59+99:00", ASOF)).toThrow();
  });

  it("un offset imposible en asOfIso también lanza (fail-closed en ambos lados de la comparación)", () => {
    expect(() => isPast("2026-09-05T23:59:59-06:00", "2026-10-20T12:00:00+99:00")).toThrow();
  });

  it("una fecha límite '2026-02-30' (inexistente) lanza en vez de ser reinterpretada en silencio", () => {
    expect(() => isPast("2026-02-30T00:00:00-06:00", ASOF)).toThrow();
  });

  it("cadena vacía o null como fecha límite lanzan, nunca producen un veredicto", () => {
    expect(() => isPast("", ASOF)).toThrow();
    // @ts-expect-error prueba deliberada de un valor no-string
    expect(() => isPast(null, ASOF)).toThrow();
  });

  it("con fechas válidas sigue funcionando exactamente igual que antes (no hay regresión)", () => {
    expect(isPast("2026-10-01T00:00:00-06:00", ASOF)).toBe(true);
    expect(isPast("2026-11-01T00:00:00-06:00", ASOF)).toBe(false);
  });
});

describe("sha256Hex/stableStringify — determinismo básico (usado por assertExplicitOffset indirectamente vía otros módulos)", () => {
  it("es determinista para el mismo valor lógico", () => {
    expect(sha256Hex({ a: 1, b: 2 })).toBe(sha256Hex({ b: 2, a: 1 }));
  });
});
