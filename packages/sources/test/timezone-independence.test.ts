import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tsxBin = path.join(__dirname, "..", "..", "..", "node_modules", ".bin", "tsx");
const harnessPath = path.join(__dirname, "tz-harness", "print-comprasmx-deadline.ts");
const csvHistoricoHarnessPath = path.join(__dirname, "tz-harness", "print-csv-historico-deadline.ts");

/**
 * Ejecuta el harness en un SUBPROCESO real con el `TZ` dado (necesario:
 * dentro del mismo proceso vitest, V8 fija el huso horario "local" al
 * arrancar, así que mutar `process.env.TZ` a mitad de ejecución NO afecta a
 * `new Date()` — ver comentario en el propio harness).
 */
function runHarness(fechaNaive: string, tz: string): { submissionDeadline?: string; processTz: string | null; resolvedTz: string } {
  const stdout = execFileSync(tsxBin, [harnessPath, fechaNaive], {
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

function runCsvHistoricoHarness(fechaNaive: string, tz: string): { published?: string; processTz: string | null; resolvedTz: string } {
  const stdout = execFileSync(tsxBin, [csvHistoricoHarnessPath, fechaNaive], {
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

describe("SR-02: independencia de zona horaria del proceso en fechas de ComprasMX", () => {
  it(
    "el mismo dato de entrada naive produce el MISMO instante submissionDeadline con TZ=UTC, TZ=America/Mexico_City y TZ=Asia/Tokyo",
    () => {
      const fechaNaive = "2026-09-10T14:00:00";
      const resultUtc = runHarness(fechaNaive, "UTC");
      const resultMx = runHarness(fechaNaive, "America/Mexico_City");
      const resultTokyo = runHarness(fechaNaive, "Asia/Tokyo");

      // Confirma que cada subproceso realmente corrió con el TZ pedido (si esto fallara, el test no probaría nada).
      expect(resultUtc.resolvedTz).toBe("UTC");
      expect(resultMx.resolvedTz).toBe("America/Mexico_City");
      expect(resultTokyo.resolvedTz).toBe("Asia/Tokyo");

      expect(resultUtc.submissionDeadline).toBeDefined();
      expect(resultUtc.submissionDeadline).toBe(resultMx.submissionDeadline);
      expect(resultUtc.submissionDeadline).toBe(resultTokyo.submissionDeadline);

      // El valor correcto es la interpretación como hora del Centro de México (UTC-6 fijo): 14:00 CDMX = 20:00 UTC.
      expect(resultUtc.submissionDeadline).toBe("2026-09-10T20:00:00.000Z");
    },
    20_000,
  );
});

describe("SR-12: independencia de zona horaria del proceso en fechas del CSV histórico de ComprasMX (parseComprasMxHistoricoCsv)", () => {
  it(
    "el mismo fecha_inicio naive produce el MISMO instante published con TZ=UTC, TZ=America/Mexico_City y TZ=Asia/Tokyo",
    () => {
      const fechaNaive = "2026-09-10T14:00:00";
      const resultUtc = runCsvHistoricoHarness(fechaNaive, "UTC");
      const resultMx = runCsvHistoricoHarness(fechaNaive, "America/Mexico_City");
      const resultTokyo = runCsvHistoricoHarness(fechaNaive, "Asia/Tokyo");

      expect(resultUtc.resolvedTz).toBe("UTC");
      expect(resultMx.resolvedTz).toBe("America/Mexico_City");
      expect(resultTokyo.resolvedTz).toBe("Asia/Tokyo");

      expect(resultUtc.published).toBeDefined();
      expect(resultUtc.published).toBe(resultMx.published);
      expect(resultUtc.published).toBe(resultTokyo.published);

      // 14:00 CDMX (UTC-6 fijo) = 20:00 UTC -- el mismo valor correcto que SR-02 ya confirmó para el API en vivo.
      expect(resultUtc.published).toBe("2026-09-10T20:00:00.000Z");
    },
    20_000,
  );
});
