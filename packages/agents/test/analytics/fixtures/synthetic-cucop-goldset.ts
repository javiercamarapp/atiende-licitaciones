import type { CucopGoldCase } from "../../../src/analytics/cucop-classifier.js";

/**
 * GOLD SET SINTÉTICO -- NO SON PROCEDIMIENTOS REALES.
 *
 * 12 textos de convocatoria inventados a mano para casar (por diseño) con
 * el catálogo sintético (`synthetic-cucop-catalog.ts`). Sirve para probar
 * `runCucopBenchmark()` de punta a punta, no para certificar el
 * precision@5 ≥0.6 real de REQ-002 (que exige 300-500 procedimientos
 * reales anotados a mano, pendiente).
 */
export const SYNTHETIC_CUCOP_GOLDSET: CucopGoldCase[] = [
  { id: "1", text: "Contratación de servicio de limpieza integral para las oficinas centrales", expectedCodes: ["TEST-10101"] },
  { id: "2", text: "Adquisición de computadoras portátiles para el personal administrativo", expectedCodes: ["TEST-20201"] },
  { id: "3", text: "Servicio de vigilancia y seguridad privada para instalaciones del organismo", expectedCodes: ["TEST-10102"] },
  { id: "4", text: "Obra de pavimentación de la calle principal del municipio", expectedCodes: ["TEST-30301"] },
  { id: "5", text: "Desarrollo de software a la medida para el sistema de nómina", expectedCodes: ["TEST-40402"] },
  { id: "6", text: "Suministro de medicamentos y material de curación para el hospital general", expectedCodes: ["TEST-50501"] },
  { id: "7", text: "Vales de despensa de fin de año para trabajadores sindicalizados", expectedCodes: ["TEST-60601"] },
  { id: "8", text: "Consultoría en tecnologías de la información para modernización institucional", expectedCodes: ["TEST-40401"] },
  { id: "9", text: "Servicio de alimentación y comedor industrial para la planta", expectedCodes: ["TEST-60602"] },
  { id: "10", text: "Construcción y remodelación de un edificio público municipal", expectedCodes: ["TEST-30302"] },
  { id: "11", text: "Adquisición de impresoras multifuncionales y consumibles de impresión", expectedCodes: ["TEST-20202"] },
  { id: "12", text: "Servicios médicos y de salud especializados de segundo nivel", expectedCodes: ["TEST-50502"] },
];
