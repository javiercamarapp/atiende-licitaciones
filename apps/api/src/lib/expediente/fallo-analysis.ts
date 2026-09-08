/**
 * REQ-054 — autopsia del fallo, capa de ANÁLISIS AUTOMATIZADO: a partir de
 * (a) lo que el usuario ya declaró sobre el fallo real (`fallo_autopsies`,
 * ver `fallo-autopsy.routes.ts`) y (b) la matriz de requisitos propia de la
 * convocatoria (E6, `requirement_items` -- ya existente, este módulo no
 * reimplementa esa extracción, solo LEE su `matrix_status`, el campo de
 * gestión que el equipo edita en vivo vía `PATCH /matrix/:id`, la única
 * señal real de "¿esto ya se cumplió?" que persiste este repo hoy; la
 * tabla `compliance_items`/`requirement_id` de E7 quedó sin escritor real
 * -- no se usa aquí para no fingir una señal que nadie llena), deriva una
 * lista de "posibles causas de no adjudicación".
 *
 * Regla dura (E9, honestidad legal -- nunca afirmar certeza que no existe):
 * este módulo NUNCA determina la causa real de la no adjudicación (eso solo
 * lo sabe la convocante, en el acta de fallo real). Solo señala HIPÓTESIS
 * verificables mecánicamente:
 *   - lo que el usuario ya declaró que dijo el acta de fallo (un HECHO ya
 *     capturado, no inferido por este módulo);
 *   - requisitos obligatorios de la matriz propia sin `matrix_status` de
 *     "cumplido" (una posible explicación, nunca una confirmación -- puede
 *     que el fallo real no haya tenido nada que ver con ese requisito).
 * Si falta el dato base (no hay autopsia registrada, o la matriz de
 * requisitos nunca se construyó para esta convocatoria), el resultado lo
 * declara explícitamente en `missingDataNotes` -- nunca inventa una causa
 * para rellenar el hueco.
 */

export type FalloOwnProposalStatus = 'ganadora' | 'desechada' | 'no_presentada' | 'desconocido';

/** Valores reales de `requirement_items.matrix_status` (migración 0029). */
export type MatrixStatusValue = 'pendiente' | 'en_progreso' | 'cumplido' | 'bloqueado' | 'no_evaluable';

export interface FalloAnalysisAutopsyInput {
  ownProposalStatus: FalloOwnProposalStatus;
  /** Motivo de desechamiento YA declarado por el usuario (texto real del acta, según lo capturado) -- `null` si no se capturó (nunca el sentinel "no disponible": el llamador lo traduce a `null` antes de invocar este módulo). */
  disqualificationReason: string | null;
}

export interface FalloAnalysisRequirementInput {
  requirementItemId: string;
  description: string;
  category: string;
  /** Solo los requisitos OBLIGATORIOS entran a esta comparación (REQ-054: "criterios de evaluación conocidos"); opcionales/condicionales no generan una causa por sí solos. */
  obligatoriedad: 'obligatorio' | 'opcional' | 'condicional';
  sourcePage: number | null;
  clauseRef: string | null;
  matrixStatus: MatrixStatusValue;
}

export type FalloPossibleCauseOrigin = 'fallo_declarado' | 'requisito_pendiente' | 'requisito_bloqueado';

export interface FalloPossibleCause {
  origin: FalloPossibleCauseOrigin;
  description: string;
  requirementItemId: string | null;
  category: string | null;
  sourcePage: number | null;
  clauseRef: string | null;
}

export interface FalloAnalysisResult {
  /** `false` cuando el análisis no aplica (propuesta ganadora, o sin autopsia registrada todavía) -- ver `missingDataNotes` para el motivo. */
  applicable: boolean;
  hasAutopsy: boolean;
  /** El acta de fallo REAL fue cargada/capturada con un motivo de desechamiento explícito (no el sentinel "no disponible"). */
  hasFalloReasonDeclared: boolean;
  /** La matriz de requisitos (E6) tiene al menos un ítem obligatorio activo para esta convocatoria. */
  hasRequirementMatrix: boolean;
  possibleCauses: FalloPossibleCause[];
  /** Huecos de información declarados explícitamente -- nunca se rellenan con una suposición. */
  missingDataNotes: string[];
  disclaimer: string;
}

export const FALLO_ANALYSIS_DISCLAIMER =
  'ANÁLISIS AUTOMATIZADO sujeto a revisión humana -- NO es un diagnóstico certero de las causas de no adjudicación ni una opinión legal. Las "posibles causas" listadas son hipótesis derivadas mecánicamente de (a) lo que el usuario ya declaró que dijo el acta de fallo real y (b) requisitos obligatorios de la matriz propia sin marcar "cumplido" -- NUNCA una lectura del acta de fallo real hecha por el sistema. Un requisito pendiente en la matriz propia puede no tener relación alguna con el motivo real de la no adjudicación (o el fallo puede no haberse debido a ningún incumplimiento documental). Revise el acta de fallo real antes de tomar cualquier decisión.';

function describeRequirement(r: FalloAnalysisRequirementInput): string {
  const location = r.clauseRef ? `cláusula ${r.clauseRef}` : r.sourcePage != null ? `página ${r.sourcePage}` : 'sin referencia de página/cláusula';
  return `"${r.description}" (categoría ${r.category}, ${location})`;
}

/**
 * Deriva las "posibles causas de no adjudicación" (REQ-054). Función pura
 * (sin acceso a base de datos ni red) -- el llamador (`fallo-autopsy.routes.ts`)
 * es responsable de cargar `autopsy`/`requirements` desde Postgres.
 */
export function analyzeFalloCauses(input: {
  autopsy: FalloAnalysisAutopsyInput | null;
  /** Ítems ACTIVOS (no invalidados) de la matriz de requisitos de esta convocatoria. */
  requirements: readonly FalloAnalysisRequirementInput[];
}): FalloAnalysisResult {
  const missingDataNotes: string[] = [];
  const possibleCauses: FalloPossibleCause[] = [];

  const hasAutopsy = input.autopsy !== null;
  if (!hasAutopsy) {
    missingDataNotes.push(
      'No se ha registrado una autopsia del fallo para esta convocatoria (POST /expediente/tenders/:tenderId/fallo-autopsy) -- sin ese registro no hay confirmación de que la convocatoria se perdió, ni el motivo declarado del acta de fallo real. Este análisis no puede generar causas hasta que se registre.'
    );
  }

  const ownProposalStatus = input.autopsy?.ownProposalStatus ?? null;
  const applicable = hasAutopsy && ownProposalStatus !== 'ganadora';

  if (hasAutopsy && ownProposalStatus === 'ganadora') {
    missingDataNotes.push('La autopsia registrada indica que la propuesta propia fue GANADORA -- el análisis de "posibles causas de no adjudicación" no aplica a esta convocatoria.');
  }
  if (hasAutopsy && ownProposalStatus === 'desconocido') {
    missingDataNotes.push('El resultado de la propuesta propia se registró como "desconocido": las causas listadas abajo son hipótesis condicionadas a que la convocatoria en efecto no se haya adjudicado al cliente, no una confirmación de ese hecho.');
  }
  if (hasAutopsy && ownProposalStatus === 'no_presentada') {
    missingDataNotes.push(
      'La autopsia registrada indica que la propuesta NO se llegó a presentar -- no hay una propuesta evaluada que comparar contra la matriz de requisitos; solo se incluye, si existe, el motivo declarado en la autopsia.'
    );
  }

  const hasFalloReasonDeclared = hasAutopsy && input.autopsy!.disqualificationReason !== null;
  if (hasAutopsy && !hasFalloReasonDeclared) {
    missingDataNotes.push(
      'La autopsia registrada NO tiene capturado un motivo de desechamiento del acta de fallo real (se guardó como "no disponible") -- posiblemente el acta de fallo todavía no se ha cargado/leído. Sin ese dato, este reporte solo puede ofrecer hipótesis derivadas de la matriz de requisitos propia, nunca el motivo real declarado por la convocante.'
    );
  }

  if (hasFalloReasonDeclared) {
    possibleCauses.push({
      origin: 'fallo_declarado',
      description: `El acta de fallo, según lo capturado en la autopsia registrada, señaló como motivo respecto a la propuesta propia: "${input.autopsy!.disqualificationReason}".`,
      requirementItemId: null,
      category: null,
      sourcePage: null,
      clauseRef: null,
    });
  }

  const mandatoryRequirements = input.requirements.filter((r) => r.obligatoriedad === 'obligatorio');
  const hasRequirementMatrix = mandatoryRequirements.length > 0;
  if (!hasRequirementMatrix) {
    missingDataNotes.push(
      'La matriz de requisitos (E6) no tiene ítems OBLIGATORIOS activos para esta convocatoria (no se ha construido con POST /expediente/tenders/:tenderId/matrix/build, todos los ítems fueron invalidados, o ninguno es obligatorio) -- no se puede comparar el cumplimiento propio contra los criterios de evaluación conocidos.'
    );
  }

  // REQ-054: comparación mecánica contra la matriz -- solo para
  // convocatorias donde en efecto hubo una propuesta propia evaluada
  // (nunca para 'no_presentada', donde no existe nada que comparar).
  if (applicable && ownProposalStatus !== 'no_presentada') {
    for (const r of mandatoryRequirements) {
      if (r.matrixStatus === 'bloqueado') {
        possibleCauses.push({
          origin: 'requisito_bloqueado',
          description: `Requisito obligatorio ${describeRequirement(r)}: la matriz propia lo registra como "bloqueado".`,
          requirementItemId: r.requirementItemId,
          category: r.category,
          sourcePage: r.sourcePage,
          clauseRef: r.clauseRef,
        });
      } else if (r.matrixStatus === 'pendiente' || r.matrixStatus === 'en_progreso') {
        possibleCauses.push({
          origin: 'requisito_pendiente',
          description: `Requisito obligatorio ${describeRequirement(r)}: la matriz propia lo registra como "${r.matrixStatus}" (nunca se marcó "cumplido" antes del fallo).`,
          requirementItemId: r.requirementItemId,
          category: r.category,
          sourcePage: r.sourcePage,
          clauseRef: r.clauseRef,
        });
      }
      // 'cumplido' -> cumplido; 'no_evaluable' -> el propio equipo lo marcó
      // fuera de evaluación: ninguno de los dos es una causa candidata.
    }
  }

  return {
    applicable,
    hasAutopsy,
    hasFalloReasonDeclared,
    hasRequirementMatrix,
    possibleCauses,
    missingDataNotes,
    disclaimer: FALLO_ANALYSIS_DISCLAIMER,
  };
}
