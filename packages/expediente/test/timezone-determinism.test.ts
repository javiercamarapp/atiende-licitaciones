import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * EX-EXP-04 (CRÍTICA, auditoría ronda 1): `isPast`/`CompanyDataService` no
 * validaban que las fechas trajeran offset horario explícito. La misma
 * cadena "naive" ("2026-10-20T23:59:59", sin "Z" ni "±HH:MM") producía
 * veredictos de vencimiento DISTINTOS según la variable `TZ` del proceso
 * Node que ejecutaba el código: `false` bajo `TZ=UTC`/`America/Mexico_City`,
 * `true` bajo `TZ=Asia/Tokyo` — confirmado empíricamente antes de corregir.
 *
 * Esta prueba spawnea procesos `node` REALES bajo tres zonas horarias
 * distintas (no solo cambia `process.env.TZ` dentro del mismo proceso
 * vitest) para eliminar cualquier duda sobre cacheo de zona horaria del
 * runtime, y ejecuta el `src/types.ts` real directamente (Node soporta
 * "type stripping" nativo de TypeScript en esta versión).
 */

const typesModulePath = fileURLToPath(new URL("../src/types.ts", import.meta.url));
const TIMEZONES = ["UTC", "America/Mexico_City", "Asia/Tokyo"];

interface RunResult {
  result?: boolean;
  error?: string;
}

function runIsPastUnderTz(tz: string, iso: string, asOfIso: string): RunResult {
  const dir = mkdtempSync(path.join(tmpdir(), "expediente-ex-exp-04-"));
  const scriptPath = path.join(dir, "run.mts");
  const script = `
import { isPast } from ${JSON.stringify(typesModulePath)};
try {
  const result = isPast(${JSON.stringify(iso)}, ${JSON.stringify(asOfIso)});
  process.stdout.write(JSON.stringify({ result }));
} catch (err) {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
}
`;
  writeFileSync(scriptPath, script, "utf8");
  const out = execFileSync(process.execPath, [scriptPath], {
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  return JSON.parse(out) as RunResult;
}

describe("isPast — determinismo ante el TZ del proceso (EX-EXP-04, REQ-160 vigencias)", () => {
  it("una fecha CON offset explícito produce EXACTAMENTE el mismo veredicto bajo TZ=UTC, America/Mexico_City y Asia/Tokyo", () => {
    const iso = "2026-10-20T23:59:59-06:00";
    const asOfIso = "2026-10-20T12:00:00-06:00";

    const results = TIMEZONES.map((tz) => ({ tz, ...runIsPastUnderTz(tz, iso, asOfIso) }));

    for (const r of results) {
      expect(r.error, `TZ=${r.tz} lanzó un error inesperado`).toBeUndefined();
    }
    const verdicts = new Set(results.map((r) => r.result));
    expect(verdicts.size, `veredictos distintos entre zonas horarias: ${JSON.stringify(results)}`).toBe(1);
    expect(results[0].result).toBe(false); // 23:59:59-06:00 del 20-oct es DESPUÉS de 12:00-06:00 del mismo día
  });

  it("REPRODUCCIÓN EXACTA del hallazgo: una fecha SIN offset (naive) ya NO produce veredictos distintos por TZ — ahora se rechaza siempre con el mismo error", () => {
    const naiveIso = "2026-10-20T23:59:59"; // el caso exacto reproducido por la auditoría
    const asOfIso = "2026-10-20T12:00:00-06:00";

    const results = TIMEZONES.map((tz) => ({ tz, ...runIsPastUnderTz(tz, naiveIso, asOfIso) }));

    for (const r of results) {
      expect(r.result, `TZ=${r.tz} debía rechazar la fecha naive, no producir un veredicto`).toBeUndefined();
      expect(r.error, `TZ=${r.tz} debía lanzar un error de offset faltante`).toContain("offset horario explícito");
    }
    // Antes del fix esto era exactamente el bug: {false, false, true} según TZ.
    // Ahora las 3 zonas deben coincidir en RECHAZAR la fecha, con el mismo mensaje.
    const errorMessages = new Set(results.map((r) => r.error));
    expect(errorMessages.size).toBe(1);
  });

  it("una fecha límite naive combinada con un asOfIso naive también se rechaza de forma consistente en las 3 zonas", () => {
    const naiveIso = "2026-10-01T00:00:00";
    const naiveAsOf = "2026-10-20T12:00:00";

    const results = TIMEZONES.map((tz) => ({ tz, ...runIsPastUnderTz(tz, naiveIso, naiveAsOf) }));
    for (const r of results) {
      expect(r.result).toBeUndefined();
      expect(r.error).toContain("offset horario explícito");
    }
  });

  /**
   * EX-EXP-13 (ALTA, reverificación ronda 1): `assertExplicitOffset` solo
   * validaba el FORMATO del offset, no su rango numérico ni la validez
   * calendárica. Un offset imposible como "+99:00" pasaba, producía
   * `Invalid Date` (NaN), e `isPast()` evaluaba `NaN < NaN` como `false`
   * ("nunca vencido") — fail-open. Se repite el mismo protocolo de 3 zonas
   * horarias reales para confirmar que el rechazo es consistente e
   * independiente del `TZ` del proceso, no solo un caso feliz de una zona.
   */
  it("EX-EXP-13: un offset numéricamente imposible ('+99:00') se RECHAZA en las 3 zonas, NUNCA se evalúa como 'no vencido'", () => {
    const isoConOffsetImposible = "2026-09-05T23:59:59+99:00";
    const asOfIso = "2026-10-20T12:00:00-06:00";

    const results = TIMEZONES.map((tz) => ({ tz, ...runIsPastUnderTz(tz, isoConOffsetImposible, asOfIso) }));
    for (const r of results) {
      expect(r.result, `TZ=${r.tz}: un offset imposible NUNCA debe producir un veredicto (antes: fail-open a 'no vencido')`).toBeUndefined();
      expect(r.error, `TZ=${r.tz} debía lanzar un error de offset fuera de rango`).toContain("offset horario fuera del rango válido");
    }
  });

  it("EX-EXP-13: una fecha calendáricamente inexistente ('2026-02-30') se RECHAZA en las 3 zonas, no se reinterpreta en silencio", () => {
    const results = TIMEZONES.map((tz) => ({ tz, ...runIsPastUnderTz(tz, "2026-02-30T00:00:00-06:00", "2026-10-20T12:00:00-06:00") }));
    for (const r of results) {
      expect(r.result).toBeUndefined();
      expect(r.error).toContain("día calendárico inválido");
    }
  });

  it("EX-EXP-13: cadena vacía como fecha límite se rechaza consistentemente en las 3 zonas", () => {
    const results = TIMEZONES.map((tz) => ({ tz, ...runIsPastUnderTz(tz, "", "2026-10-20T12:00:00-06:00") }));
    for (const r of results) {
      expect(r.result).toBeUndefined();
      expect(r.error).toBeDefined();
    }
  });
});
