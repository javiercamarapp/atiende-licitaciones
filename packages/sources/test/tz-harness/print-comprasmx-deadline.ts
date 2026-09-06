/**
 * Harness ejecutado en un SUBPROCESO real (SR-02) para probar que
 * `mapComprasMxApiRecordToTenderRecord` produce el MISMO instante para
 * `fecha_apertura_proposiciones` sin importar el `TZ` del proceso que lo
 * ejecuta. No se puede probar esto dentro del mismo proceso vitest: V8 fija
 * el huso horario "local" (usado por `new Date("...naive...")`) al arrancar
 * el proceso, así que cambiar `process.env.TZ` a mitad de ejecución no
 * afecta a `new Date()`. Ver `test/timezone-independence.test.ts`.
 *
 * Uso: `tsx print-comprasmx-deadline.ts <fecha_apertura_proposiciones>`
 * Imprime en stdout un JSON `{ submissionDeadline: string | undefined }`.
 */
import { mapComprasMxApiRecordToTenderRecord } from "../../src/connectors/compras-mx/comprasmx-mapper.js";

const fechaAperturaProposiciones = process.argv[2];

const record = mapComprasMxApiRecordToTenderRecord(
  {
    codigo_expediente: "TZ-HARNESS-1",
    titulo_expediente: "Prueba de independencia de zona horaria (SR-02)",
    dependencia_entidad: "Entidad de prueba",
    fecha_apertura_proposiciones: fechaAperturaProposiciones,
  },
  { fetchedAt: new Date("2026-01-01T00:00:00Z") },
);

process.stdout.write(
  JSON.stringify({
    submissionDeadline: record?.dates.submissionDeadline?.toISOString(),
    processTz: process.env.TZ ?? null,
    resolvedTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }),
);
