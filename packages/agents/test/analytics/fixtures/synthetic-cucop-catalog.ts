import type { CucopCatalogEntry, CucopCatalogPort } from "../../../src/analytics/cucop-classifier.js";

/**
 * CATÁLOGO SINTÉTICO -- NO ES EL CATÁLOGO OFICIAL CUCoP/COG.
 *
 * Cada código lleva el prefijo "TEST-" a propósito para que sea imposible
 * confundirlo con un código real del catálogo oficial de la autoridad
 * (hoy SABG). Se usa ÚNICAMENTE para probar que `classifyCucop()` y
 * `runCucopBenchmark()` funcionan de punta a punta (ranking correcto,
 * cálculo de precision@k) -- ningún número que este fixture produzca
 * certifica el criterio de aceptación real de REQ-002, que exige el
 * catálogo oficial vigente + un gold set de 300-500 procedimientos reales
 * anotados a mano (pendiente, ver packages/agents/README.md §Pendientes).
 */
export const SYNTHETIC_CUCOP_CATALOG: CucopCatalogEntry[] = [
  { code: "TEST-10101", description: "Servicios de limpieza y mantenimiento de oficinas" },
  { code: "TEST-10102", description: "Servicios de vigilancia y seguridad privada" },
  { code: "TEST-20201", description: "Adquisición de equipo de cómputo y computadoras portátiles" },
  { code: "TEST-20202", description: "Adquisición de impresoras multifuncionales y consumibles de impresión" },
  { code: "TEST-30301", description: "Obra pública de pavimentación de calles y carreteras" },
  { code: "TEST-30302", description: "Construcción y remodelación de edificios públicos" },
  { code: "TEST-40401", description: "Servicios de consultoría en tecnologías de la información" },
  { code: "TEST-40402", description: "Desarrollo de software y sistemas de información a la medida" },
  { code: "TEST-50501", description: "Suministro de medicamentos y material de curación" },
  { code: "TEST-50502", description: "Servicios médicos y de salud especializados" },
  { code: "TEST-60601", description: "Vales de despensa y prestaciones para empleados" },
  { code: "TEST-60602", description: "Servicios de alimentación y comedor industrial" },
];

export function createSyntheticCucopCatalog(): CucopCatalogPort {
  return { entries: () => SYNTHETIC_CUCOP_CATALOG };
}
