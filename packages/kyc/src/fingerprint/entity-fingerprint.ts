/**
 * Fingerprint de entidad y detección de candidatos a interpósita persona
 * ENTRE tenants (REQ-111). Fundamento legal ya VERIFICADO en
 * `docs/legal/verificacion-legal.md`: LGRA Art. 67 tipifica la
 * "participación ilícita" por interpósita persona; LAASSP nueva Art. 90-V
 * prohíbe actuar "como interpósita persona en los procedimientos de
 * contratación". Ninguna de las dos normas define un algoritmo de
 * detección -- el que sigue es una regla de negocio de este producto
 * (documentada, no inventada como "verificada legalmente"): cuando dos
 * ORGANIZACIONES DISTINTAS (RFC distinto) comparten domicilio y/o
 * representante legal y/o socio, es evidencia razonable de que una pueda
 * estar actuando en interés de la otra -- exactamente el patrón que ambas
 * normas buscan capturar. Este módulo solo produce CANDIDATOS con su
 * evidencia (`matchedFields`) para revisión humana de compliance -- NUNCA
 * suspende ni decide nada por sí solo (a diferencia del KYC negativo de
 * 69-B, donde "Definitivo" sí es una señal binaria con fundamento legal
 * directo).
 */
import { normalizeAddress, normalizeEntityName, normalizeRfc } from "./normalize.js";
import type { EntityFingerprint, EntityFingerprintInput, FingerprintMatchResult, FingerprintMatchedField } from "./types.js";

/** Un RFC mexicano de persona física mide 13 caracteres, de moral 12. Se usa como heurística para decidir si `idDocumentRef`/`rfc` de un socio/representante es en verdad un RFC (y no, p.ej., un número de INE/pasaporte) antes de usarlo como clave. */
function looksLikeRfc(value: string): boolean {
  const cleaned = normalizeRfc(value);
  return cleaned !== null && cleaned.length >= 12 && cleaned.length <= 13;
}

function personKey(fullName: string, idOrRfc?: string | null): string | null {
  if (idOrRfc && looksLikeRfc(idOrRfc)) {
    return `rfc:${normalizeRfc(idOrRfc)}`;
  }
  const name = normalizeEntityName(fullName);
  return name ? `name:${name}` : null;
}

function dedupSortedKeys(keys: Array<string | null>): string[] {
  return [...new Set(keys.filter((k): k is string => k !== null))].sort();
}

export function buildEntityFingerprint(input: EntityFingerprintInput): EntityFingerprint {
  return {
    orgId: input.orgId,
    orgName: input.orgName,
    rfc: normalizeRfc(input.rfc),
    domicilioKey: normalizeAddress(input.domicilio ?? undefined),
    representanteKeys: dedupSortedKeys(input.representantes.map((r) => personKey(r.fullName, r.idDocumentRef))),
    socioKeys: dedupSortedKeys(input.socios.map((s) => personKey(s.fullName, s.rfc))),
  };
}

/**
 * Pesos de cada señal compartida. Un RFC idéntico entre dos tenants
 * distintos es, por sí solo, ya suficiente para el umbral por defecto (es
 * imposible por accidente); domicilio/representante/socio compartido
 * individualmente también alcanzan el umbral por defecto (0.30) -- el
 * criterio de este producto es que UNA sola señal de identidad compartida
 * entre dos RFC distintos ya amerita revisión humana, no que hagan falta
 * varias señales acumuladas para "confirmar" el patrón.
 */
export const FINGERPRINT_WEIGHTS = {
  rfc: 1.0,
  domicilio: 0.4,
  representante: 0.35,
  socio: 0.35,
} as const;

export const DEFAULT_FINGERPRINT_THRESHOLD = 0.3;

function intersect(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  return a.filter((k) => setB.has(k));
}

/** Compara dos fingerprints; `null` si son de la misma organización o no comparten ninguna señal. */
export function compareEntityFingerprints(a: EntityFingerprint, b: EntityFingerprint): FingerprintMatchResult | null {
  if (a.orgId === b.orgId) return null;

  const matchedFields: FingerprintMatchedField[] = [];
  let score = 0;

  if (a.rfc && b.rfc && a.rfc === b.rfc) {
    matchedFields.push({ field: "rfc", value: a.rfc });
    score += FINGERPRINT_WEIGHTS.rfc;
  }
  if (a.domicilioKey && b.domicilioKey && a.domicilioKey === b.domicilioKey) {
    matchedFields.push({ field: "domicilio", value: a.domicilioKey });
    score += FINGERPRINT_WEIGHTS.domicilio;
  }
  for (const key of intersect(a.representanteKeys, b.representanteKeys)) {
    matchedFields.push({ field: "representante", value: key });
    score += FINGERPRINT_WEIGHTS.representante;
  }
  for (const key of intersect(a.socioKeys, b.socioKeys)) {
    matchedFields.push({ field: "socio", value: key });
    score += FINGERPRINT_WEIGHTS.socio;
  }

  if (matchedFields.length === 0) return null;

  const [orgIdA, orgIdB, orgNameA, orgNameB] =
    a.orgId < b.orgId ? [a.orgId, b.orgId, a.orgName, b.orgName] : [b.orgId, a.orgId, b.orgName, a.orgName];

  return { orgIdA, orgIdB, orgNameA, orgNameB, score: Math.min(1, score), matchedFields };
}

/**
 * Compara TODOS los pares de fingerprints (O(n²) -- aceptable para el
 * número de tenants de esta plataforma; documentado, no un descuido: si el
 * número de tenants creciera a decenas de miles esto necesitaría un índice
 * por señal en vez de fuerza bruta, pero hoy sería optimización prematura).
 * Devuelve solo los pares con `score >= threshold`, ordenados por score
 * descendente.
 */
export function findInterpositaPersonaCandidates(
  fingerprints: EntityFingerprint[],
  options: { threshold?: number } = {},
): FingerprintMatchResult[] {
  const threshold = options.threshold ?? DEFAULT_FINGERPRINT_THRESHOLD;
  const results: FingerprintMatchResult[] = [];
  for (let i = 0; i < fingerprints.length; i += 1) {
    for (let j = i + 1; j < fingerprints.length; j += 1) {
      const match = compareEntityFingerprints(fingerprints[i], fingerprints[j]);
      if (match && match.score >= threshold) results.push(match);
    }
  }
  return results.sort((x, y) => y.score - x.score);
}
