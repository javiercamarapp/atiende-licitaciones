/**
 * REQ-055 — radar de renovaciones: a partir de contratos con fecha de fin
 * conocida, calcula qué umbrales de antelación (configurables, por
 * defecto 90/60/30 días) ya se cumplieron para generar una alerta de
 * "renovación/licitación probable" -- pura función de fechas, sin acceso a
 * base de datos (facilita la prueba exhaustiva; `renewal-radar.routes.ts`
 * hace el I/O real: consulta contratos, deduplica contra alertas ya
 * emitidas, y encola el job).
 *
 * LÍMITE DOCUMENTADO (honesto, no oculto): esta ronda detecta alertas a
 * partir de la fecha de fin del CONTRATO PROPIO (`contracts.end_date`).
 * Cruzar "convocatorias históricas de la misma entidad/objeto" para
 * predecir una licitación futura SIN que exista todavía un contrato propio
 * con fecha de fin (p. ej. la dependencia nunca le adjudicó antes) NO se
 * construyó en esta ronda -- ver README. Lo que SÍ se hace es enriquecer
 * cada alerta con hasta `MAX_HISTORICAL_TENDERS` convocatorias previas de
 * la MISMA organización y el MISMO `contracting_body` (si existen),
 * como contexto de apoyo (nunca como fuente única de la alerta).
 */
export const DEFAULT_RENEWAL_LEAD_DAYS: readonly number[] = [90, 60, 30];
export const MAX_HISTORICAL_TENDERS = 5;

export interface RenewalCandidateContract {
  contractId: string;
  tenderId: string;
  endDate: string; // "YYYY-MM-DD"
}

export interface RenewalAlertCandidate {
  contractId: string;
  tenderId: string;
  predictedDate: string;
  leadDays: number;
  /** Confianza más alta cuanto más cerca está el umbral cruzado de la fecha real de fin (antelación exacta = 1; mientras más días de margen ya pasado, más alta -- nunca baja de 0.5 para una fecha de fin real y conocida). */
  confidence: number;
}

function daysBetween(fromIsoDate: string, toIsoDate: string): number {
  const from = new Date(`${fromIsoDate}T00:00:00Z`).getTime();
  const to = new Date(`${toIsoDate}T00:00:00Z`).getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

/**
 * Para un contrato con `endDate` conocida, decide qué umbrales de
 * `leadDaysThresholds` ya se cumplieron a partir de `todayIsoDate`
 * (`daysUntilEnd <= threshold`, y todavía no venció: `daysUntilEnd >= 0`).
 * Puede devolver más de un umbral si varios ya se cumplieron a la vez
 * (p. ej. un escaneo tardío que salta directo a 30 días habiendo pasado
 * ya el de 90 y 60) -- el llamador decide, con el histórico de alertas ya
 * emitidas, cuáles insertar de nuevo (dedupe por (contrato, leadDays)).
 */
export function computeRenewalAlertCandidates(
  contracts: readonly RenewalCandidateContract[],
  todayIsoDate: string,
  leadDaysThresholds: readonly number[] = DEFAULT_RENEWAL_LEAD_DAYS
): RenewalAlertCandidate[] {
  const candidates: RenewalAlertCandidate[] = [];
  const sortedThresholds = [...leadDaysThresholds].sort((a, b) => a - b);

  for (const contract of contracts) {
    const daysUntilEnd = daysBetween(todayIsoDate, contract.endDate);
    if (daysUntilEnd < 0) continue; // contrato ya vencido -- fuera de alcance del radar (no es "próxima" renovación).

    for (const threshold of sortedThresholds) {
      if (daysUntilEnd <= threshold) {
        // Confianza: 1.0 si el escaneo cae justo en el umbral (antelación
        // exacta); decae linealmente (piso 0.5) cuanto más lejos del
        // umbral está la fecha de fin real -- nunca por debajo de 0.5
        // porque la fecha de fin en sí es un dato conocido, no inferido.
        const confidence = threshold === 0 ? 1 : Math.max(0.5, 1 - Math.abs(threshold - daysUntilEnd) / (2 * threshold));
        candidates.push({
          contractId: contract.contractId,
          tenderId: contract.tenderId,
          predictedDate: contract.endDate,
          leadDays: threshold,
          confidence: Math.round(confidence * 100) / 100,
        });
      }
    }
  }
  return candidates;
}
