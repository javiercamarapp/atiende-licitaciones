/**
 * REQ-053 — construcción del contenido estructurado de un BORRADOR de
 * inconformidad. Este módulo NUNCA envía nada a ninguna autoridad (no hay
 * ningún cliente HTTP saliente en todo este archivo) -- solo arma el
 * documento y calcula el plazo legal con el motor determinista de
 * `business-days.ts` (nunca con un LLM).
 *
 * Fundamentos legales citados (jurisdicción + fecha DOF), verificados
 * puntualmente en `docs/legal/verificacion-legal.md`:
 *  - Art. 49 LAASSP nueva (fila REQ-103): el fallo es el acto típicamente
 *    impugnado; frac. I exige listar razones de desechamiento.
 *  - Art. 95 LAASSP nueva (fila REQ-104): plazo de 6/10 días hábiles.
 * Ambos artículos son de la misma reforma (DOF 16-abr-2025).
 */
import { createHash } from 'node:crypto';
import { computeInconformidadDeadline, type InconformidadDeadlineResult } from './business-days.js';

export interface InconformidadFundamento {
  articulo: string;
  ley: string;
  jurisdiccion: string;
  fechaDof: string | null;
  texto: string;
}

export type InconformidadViability = 'alta' | 'media' | 'baja';

export const INCONFORMIDAD_DISCLAIMER =
  'BORRADOR — requiere revisión de abogado. Este documento es un insumo generado automáticamente a partir de datos capturados por el usuario; NO se presenta ante ninguna autoridad por este sistema, NO constituye asesoría legal, y NO debe presentarse sin que un abogado lo revise y, en su caso, lo corrija.';

export interface InconformidadContentInput {
  falloNotifiedOn: string;
  bajoTratados: boolean;
  hechos: readonly string[];
  agravios: readonly string[];
  pruebas: readonly string[];
  /** Días inhábiles oficiales adicionales a sábado/domingo (ver `calendar_holidays`, igual patrón que `post-award.routes.ts`). */
  holidays?: readonly string[];
}

export interface InconformidadContent {
  fundamentos: InconformidadFundamento[];
  plazo: InconformidadDeadlineResult & { fechaNotificacionFallo: string; bajoTratados: boolean };
  viability: InconformidadViability;
  viabilityRecommendation: string;
  contentHash: string;
}

function buildFundamentos(deadline: InconformidadDeadlineResult, bajoTratados: boolean): InconformidadFundamento[] {
  return [
    {
      articulo: 'Art. 49',
      ley: 'LAASSP nueva',
      jurisdiccion: 'Federal',
      fechaDof: '2025-04-16',
      texto:
        'Fracción I exige que el fallo liste a los proveedores desechados "expresando todas las razones legales, técnicas o económicas" que sustentan la determinación; "Contra el fallo no procederá recurso alguno; sin embargo, procederá la inconformidad que se interpondrá..." (docs/legal/verificacion-legal.md, fila REQ-103).',
    },
    {
      articulo: 'Art. 95',
      ley: 'LAASSP nueva',
      jurisdiccion: 'Federal',
      fechaDof: '2025-04-16',
      texto: `Plazo para presentar la inconformidad: ${deadline.businessDays} días hábiles siguientes a la notificación del acto impugnado${
        bajoTratados
          ? ' (licitación pública internacional bajo cobertura de tratados: 10 días hábiles, en vez del plazo general de 6)'
          : ' (plazo general de 6 días hábiles; 10 días hábiles tratándose de licitaciones públicas internacionales bajo cobertura de tratados)'
      } (docs/legal/verificacion-legal.md, fila REQ-104).`,
    },
  ];
}

/**
 * Guardrail anti-frivolidad DETERMINISTA (REQUISITOS.md REQ-053): compara
 * el número de agravios contra el número de elementos de prueba
 * registrados. NUNCA bloquea la generación del borrador -- solo advierte,
 * y la clasificación es una heurística de forma (cantidad de evidencia
 * declarada), no una opinión legal sobre el fondo del caso.
 */
function assessViability(agravios: readonly string[], pruebas: readonly string[]): { viability: InconformidadViability; recommendation: string } {
  if (pruebas.length === 0) {
    return {
      viability: 'baja',
      recommendation:
        'No se registró ninguna prueba que sustente los agravios planteados. Recomendación (heurística determinista, NO opinión legal): reunir evidencia documental concreta antes de presentar; presentar sin pruebas suele debilitar la inconformidad.',
    };
  }
  if (pruebas.length < agravios.length) {
    return {
      viability: 'media',
      recommendation: `Se registraron ${pruebas.length} prueba(s) para ${agravios.length} agravio(s): no todos los agravios tienen soporte documental explícito. Revise que cada agravio cuente con al menos una prueba antes de presentar.`,
    };
  }
  return {
    viability: 'alta',
    recommendation:
      'Se registró al menos una prueba por cada agravio planteado. Esta clasificación es una heurística determinista sobre la cantidad de evidencia declarada, NO una opinión legal sobre el fondo del caso -- requiere de cualquier forma revisión de un abogado antes de presentar.',
  };
}

/** Hash determinista del contenido (para versionado -- REQ-053 "versionado con hash"). Mismo orden de claves siempre, para que el hash sea reproducible. */
function hashContent(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function buildInconformidadContent(input: InconformidadContentInput): InconformidadContent {
  const deadline = computeInconformidadDeadline(input.falloNotifiedOn, input.bajoTratados, input.holidays ?? []);
  const fundamentos = buildFundamentos(deadline, input.bajoTratados);
  const { viability, recommendation } = assessViability(input.agravios, input.pruebas);

  const hashPayload = {
    hechos: input.hechos,
    agravios: input.agravios,
    pruebas: input.pruebas,
    fundamentos,
    falloNotifiedOn: input.falloNotifiedOn,
    bajoTratados: input.bajoTratados,
    dueDate: deadline.dueDate,
  };

  return {
    fundamentos,
    plazo: { ...deadline, fechaNotificacionFallo: input.falloNotifiedOn, bajoTratados: input.bajoTratados },
    viability,
    viabilityRecommendation: recommendation,
    contentHash: hashContent(hashPayload),
  };
}
