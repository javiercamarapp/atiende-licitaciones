/**
 * Harness ejecutado en un SUBPROCESO real (SR-12, mismo patrón que
 * `print-comprasmx-deadline.ts` para SR-02) para probar que
 * `parseComprasMxHistoricoCsv` produce el MISMO instante para `fecha_inicio`
 * sin importar el `TZ` del proceso que lo ejecuta. No se puede probar esto
 * dentro del mismo proceso vitest: V8 fija el huso horario "local" al
 * arrancar el proceso, así que mutar `process.env.TZ` a mitad de ejecución
 * no afecta a `new Date()`. Ver `test/timezone-independence.test.ts`.
 *
 * Uso: `tsx print-csv-historico-deadline.ts <fecha_inicio_naive>`
 * Imprime en stdout un JSON `{ published: string | undefined, resolvedTz: string }`.
 */
import { parseComprasMxHistoricoCsv } from "../../src/connectors/compras-mx/comprasmx-mapper.js";

const fechaInicioNaive = process.argv[2];

const csv =
  "codigo_contrato,codigo_expediente,proveedor,titulo_contrato,importe,moneda,fecha_inicio,fecha_fin\n" +
  `C-TZ-1,E-TZ-1,Proveedor de prueba,Prueba de independencia de zona horaria (SR-12),100,MXN,${fechaInicioNaive},\n`;

const { records } = parseComprasMxHistoricoCsv(csv, {
  fetchedAt: new Date("2026-01-01T00:00:00Z"),
  publishingEntity: "Entidad de prueba",
});

process.stdout.write(
  JSON.stringify({
    published: records[0]?.dates.published?.toISOString(),
    processTz: process.env.TZ ?? null,
    resolvedTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }),
);
