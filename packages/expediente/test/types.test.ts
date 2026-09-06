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

/**
 * EX-EXP-20 (reverificación ronda 2, BAJA): ni `assertOffsetInRange` ni
 * `assertValidCalendarComponents` validaban nunca el componente de HORA
 * (`HH:MM:SS`). `"24:00:00"` — representación ISO 8601 válida de la
 * medianoche del día SIGUIENTE — pasaba sin lanzar: `new Date("...
 * T24:00:00Z")` no produce `NaN`, V8 la reinterpreta silenciosamente como
 * el día siguiente a las 00:00 — el mismo patrón exacto del bug de 29-feb
 * ya corregido para el componente de FECHA (EX-EXP-13), no extendido a la
 * HORA. Ahora se rechaza explícitamente, junto con cualquier
 * minuto/segundo ≥60 y formatos de hora/fracción mal formados.
 */
describe("assertExplicitOffset — EX-EXP-20: rechaza '24:00:00' y componentes de hora fuera de rango", () => {
  it("rechaza la hora '24:00:00' (medianoche del día siguiente, ISO 8601 válida pero NO aceptada aquí)", () => {
    expect(() => assertExplicitOffset("2026-06-15T24:00:00Z")).toThrow(/hora fuera de rango|EX-EXP-20/);
  });

  it("rechaza '24:00:00' también con offset numérico explícito, no solo 'Z'", () => {
    expect(() => assertExplicitOffset("2026-06-15T24:00:00-06:00")).toThrow(/hora fuera de rango/);
  });

  it("acepta horas límite válidas: '00:00:00' y '23:59:59'", () => {
    expect(() => assertExplicitOffset("2026-06-15T00:00:00Z")).not.toThrow();
    expect(() => assertExplicitOffset("2026-06-15T23:59:59Z")).not.toThrow();
  });

  it("rechaza minutos fuera de rango (00-59), p. ej. '23:60:00'", () => {
    expect(() => assertExplicitOffset("2026-06-15T23:60:00Z")).toThrow(/minutos fuera de rango/);
  });

  it("rechaza segundos fuera de rango (00-59), p. ej. '00:00:60'", () => {
    expect(() => assertExplicitOffset("2026-06-15T00:00:60Z")).toThrow(/segundos fuera de rango/);
  });

  it("rechaza una hora de 25 (fuera de todo rango real)", () => {
    expect(() => assertExplicitOffset("2026-06-15T25:00:00Z")).toThrow(/hora fuera de rango/);
  });

  it("acepta segundos fraccionarios válidos ('.999') sin falsos positivos", () => {
    expect(() => assertExplicitOffset("2026-06-15T23:59:59.999Z")).not.toThrow();
    expect(() => assertExplicitOffset("2026-06-15T00:00:00.123456Z")).not.toThrow();
  });

  it("rechaza una fracción de segundo con formato inválido (no dígitos tras el punto)", () => {
    expect(() => assertExplicitOffset("2026-06-15T12:00:00.abcZ")).toThrow();
  });

  it("rechaza un formato de hora con componentes faltantes/mal formados ('12:00' sin segundos)", () => {
    expect(() => assertExplicitOffset("2026-06-15T12:00Z")).toThrow(/formato de hora inválido/);
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

/**
 * EX-EXP-18 (reverificación ronda 2, MEDIA): antes, `sortKeysDeep` trataba
 * cualquier `typeof value === "object"` no-array (incluyendo `Date`, `Map`,
 * `Set`) como "objeto con propiedades enumerables" vía `Object.entries` —
 * que para estos tres tipos devuelve `[]`, así que CUALQUIER `Date`/`Map`/
 * `Set` colapsaba a `"{}"`. `sha256Hex(new Date("2026-01-01"))` ===
 * `sha256Hex(new Date("2099-12-31"))`: una colisión real. `bigint` ni
 * siquiera llegaba a esa rama (`typeof 1n === "bigint"`, no `"object"`) y
 * `JSON.stringify(1n)` LANZA. Ahora los cuatro se serializan explícitamente
 * con un marcador de tipo que preserva su valor lógico.
 */
describe("stableStringify/sha256Hex — EX-EXP-18: Date/Map/Set/BigInt ya no colisionan", () => {
  it("dos Date lógicamente distintos ya NO producen el mismo hash (antes: ambos colapsaban a '{}')", () => {
    expect(sha256Hex(new Date("2026-01-01T00:00:00.000Z"))).not.toBe(sha256Hex(new Date("2099-12-31T00:00:00.000Z")));
  });

  it("el mismo instante representado por dos objetos Date distintos (construidos de forma distinta) SÍ produce el mismo hash (ISO 8601 canónico)", () => {
    const a = new Date("2026-01-01T00:00:00.000Z");
    const b = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0));
    expect(sha256Hex(a)).toBe(sha256Hex(b));
  });

  it("una Date colapsada dentro de un objeto ya no colisiona con un objeto sin ese campo (antes: ambos '{}' anidados)", () => {
    const withDate = { fecha: new Date("2026-01-01T00:00:00.000Z") };
    const withoutDate = { fecha: {} };
    expect(sha256Hex(withDate)).not.toBe(sha256Hex(withoutDate));
  });

  it("serializar un Invalid Date lanza explícitamente (nunca produce '{}' silencioso)", () => {
    expect(() => sha256Hex(new Date("no-es-una-fecha"))).toThrow(/Invalid Date/);
  });

  it("un Map con las mismas entradas en distinto orden de inserción produce el MISMO hash", () => {
    const a = new Map<string, number>([["z", 1], ["a", 2]]);
    const b = new Map<string, number>([["a", 2], ["z", 1]]);
    expect(sha256Hex(a)).toBe(sha256Hex(b));
  });

  it("un Map con contenido lógicamente distinto produce un hash distinto, y ya no colisiona con {} ni con un objeto plano equivalente", () => {
    const a = new Map<string, number>([["x", 1]]);
    const b = new Map<string, number>([["x", 2]]);
    expect(sha256Hex(a)).not.toBe(sha256Hex(b));
    expect(sha256Hex(a)).not.toBe(sha256Hex({}));
    expect(sha256Hex(a)).not.toBe(sha256Hex({ x: 1 }));
  });

  it("un Set con los mismos elementos en distinto orden de inserción produce el MISMO hash", () => {
    const a = new Set([3, 1, 2]);
    const b = new Set([1, 2, 3]);
    expect(sha256Hex(a)).toBe(sha256Hex(b));
  });

  it("un Set con contenido lógicamente distinto produce un hash distinto, y ya no colisiona con {}", () => {
    expect(sha256Hex(new Set([1, 2]))).not.toBe(sha256Hex(new Set([1, 2, 3])));
    expect(sha256Hex(new Set([1, 2]))).not.toBe(sha256Hex({}));
  });

  it("un BigInt se serializa sin lanzar (antes: JSON.stringify(1n) lanzaba TypeError) y distingue valores distintos", () => {
    expect(() => sha256Hex(1n)).not.toThrow();
    expect(sha256Hex(1n)).not.toBe(sha256Hex(2n));
    expect(sha256Hex(10n)).toBe(sha256Hex(10n));
  });

  it("un BigInt no colisiona con el Number/string equivalente (tipos lógicamente distintos)", () => {
    expect(sha256Hex(10n)).not.toBe(sha256Hex(10));
    expect(sha256Hex(10n)).not.toBe(sha256Hex("10"));
  });

  it("undefined/null/ausente siguen produciendo hashes distintos entre sí (sin regresión de EX-EXP-01/EX-EXP-11)", () => {
    const withUndefined = { a: 1, b: undefined };
    const withNull = { a: 1, b: null };
    const absent = { a: 1 };
    expect(sha256Hex(withUndefined)).not.toBe(sha256Hex(withNull));
    expect(sha256Hex(withUndefined)).not.toBe(sha256Hex(absent));
    expect(sha256Hex(withNull)).not.toBe(sha256Hex(absent));
  });
});

/**
 * EX-EXP-18 residual (auditoría §4, corrector ronda 4, severidad BAJA):
 * `sortKeysDeep` dejaba pasar `number` sin normalizar a la rama final
 * `return value`, y `JSON.stringify` colisiona en dos casos reales:
 * `JSON.stringify(-0) === "0"` (colisiona con `0`) y
 * `JSON.stringify(NaN) === JSON.stringify(Infinity) === JSON.stringify(-Infinity)
 * === "null"` (colisiona entre los tres Y con `null`). Decisión de diseño
 * (ver README): un número no finito es un error de VALIDACIÓN del insumo,
 * no un valor serializable — `stableStringify`/`sha256Hex` lanzan
 * fail-closed. `-0` sí es un valor finito legítimo y se preserva con un
 * marcador de tipo, igual que `Date`/`Map`/`Set`/`BigInt`.
 */
describe("stableStringify/sha256Hex — EX-EXP-18 residual: -0/NaN/Infinity ya no colisionan", () => {
  it("-0 y 0 ya NO producen el mismo hash (antes: JSON.stringify(-0) === JSON.stringify(0) === '0')", () => {
    expect(sha256Hex(-0)).not.toBe(sha256Hex(0));
  });

  it("-0 anidado dentro de un objeto tampoco colisiona con 0 en la misma posición", () => {
    expect(sha256Hex({ total: -0 })).not.toBe(sha256Hex({ total: 0 }));
  });

  it("-0 es determinista consigo mismo", () => {
    expect(sha256Hex(-0)).toBe(sha256Hex(-0));
    expect(sha256Hex({ total: -0 })).toBe(sha256Hex({ total: -0 }));
  });

  it("serializar NaN lanza explícitamente (antes: colapsaba a 'null', colisionando con null/Infinity/-Infinity)", () => {
    expect(() => sha256Hex(NaN)).toThrow(/no finito/);
    expect(() => sha256Hex({ total: NaN })).toThrow(/no finito/);
  });

  it("serializar Infinity/-Infinity lanza explícitamente (antes: ambos colapsaban a 'null')", () => {
    expect(() => sha256Hex(Infinity)).toThrow(/no finito/);
    expect(() => sha256Hex(-Infinity)).toThrow(/no finito/);
  });

  it("un número finito normal (incluido 0 positivo) nunca lanza y sigue siendo determinista", () => {
    expect(() => sha256Hex(0)).not.toThrow();
    expect(() => sha256Hex(42)).not.toThrow();
    expect(sha256Hex(0)).toBe(sha256Hex(0));
  });
});
