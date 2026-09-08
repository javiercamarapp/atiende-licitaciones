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

export function daysBetween(fromIsoDate: string, toIsoDate: string): number {
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

// ---------------------------------------------------------------------------
// REQ-055 (ronda 8) -- "cliente concreto" del radar: `GET /renewals/upcoming`
// (`renewal-radar.routes.ts`) necesita, además de la lista plana de
// candidatas que ya produce `computeRenewalAlertCandidates`, una forma
// EXPLÍCITA de agrupar por urgencia para que un consumidor de negocio (no
// un desarrollador leyendo `lead_days`) entienda de un vistazo qué tan
// pronto actuar -- sin colapsar los tres umbrales en un solo `alertLevel`
// binario como hace el mecanismo genérico (`post-award.routes.ts`,
// `computeAlertLevel`).
// ---------------------------------------------------------------------------
export type RenewalUrgency = 'urgente' | 'proxima' | 'seguimiento';

/**
 * Traduce un umbral de antelación (en días) a una etiqueta de urgencia
 * relativa a `sortedThresholds` (ascendente, sin duplicados): el umbral MÁS
 * PEQUEÑO (el que se cruza más cerca del vencimiento real) es 'urgente', el
 * MÁS GRANDE es 'seguimiento', y cualquiera intermedio es 'proxima'. Con un
 * único umbral configurado, es 'urgente' (no hay "más" ni "menos" urgente
 * que comparar). Puro y determinista -- la MISMA lista de umbrales siempre
 * produce la MISMA etiqueta para el mismo valor.
 */
export function urgencyForLeadDays(leadDays: number, sortedThresholds: readonly number[]): RenewalUrgency {
  const idx = sortedThresholds.indexOf(leadDays);
  if (idx <= 0) return 'urgente';
  if (idx === sortedThresholds.length - 1) return 'seguimiento';
  return 'proxima';
}

export interface RenewalUpcomingCandidate extends RenewalAlertCandidate {
  /** Días calendario restantes hasta `predictedDate` desde `todayIsoDate` -- SIEMPRE >= 0 (mismo filtro que `computeRenewalAlertCandidates`: un contrato ya vencido no es una "próxima" renovación). */
  daysUntilEnd: number;
  urgency: RenewalUrgency;
}

/**
 * Igual que `computeRenewalAlertCandidates` (misma semántica: un contrato
 * puede cruzar varios umbrales A LA VEZ y aparece una vez por cada uno,
 * NUNCA deduplicado a "el más urgente") pero además calcula `daysUntilEnd`
 * y `urgency` para consumo directo de un endpoint de negocio -- sin tocar
 * base de datos ni tablas de alertas persistidas (`renewal_alerts`), a
 * diferencia de `POST /renewals/scan`. Pura, sin I/O -- facilita probar de
 * forma exhaustiva la agrupación por urgencia con fechas fijas.
 */
export function computeUpcomingRenewals(
  contracts: readonly RenewalCandidateContract[],
  todayIsoDate: string,
  leadDaysThresholds: readonly number[] = DEFAULT_RENEWAL_LEAD_DAYS
): RenewalUpcomingCandidate[] {
  const sortedThresholds = [...new Set(leadDaysThresholds)].sort((a, b) => a - b);
  const candidates = computeRenewalAlertCandidates(contracts, todayIsoDate, sortedThresholds);
  return candidates.map((candidate) => ({
    ...candidate,
    daysUntilEnd: daysBetween(todayIsoDate, candidate.predictedDate),
    urgency: urgencyForLeadDays(candidate.leadDays, sortedThresholds),
  }));
}
