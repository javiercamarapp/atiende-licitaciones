import { z } from "zod";

/**
 * Esquema INFERIDO (no confirmado con una respuesta 200 real, ver README
 * §ComprasMX) de un registro de "expediente" del endpoint público
 * `POST https://upcp-cnetservicios.buengobierno.gob.mx/whitney/sitiopublico/expedientes`.
 * Los nombres de campo (`codigo_expediente`, `titulo_expediente`,
 * `tipo_expediente`, `tipo_contratacion`, `entidad_federativa_...`) se
 * extrajeron el 2026-09-05 de las plantillas Angular compiladas en
 * `sitiopublico/main.*.js` de la SPA pública real de ComprasMX (grep de
 * cadenas `e.codigo_expediente`, `e.titulo_expediente`, etc.), NO de un
 * payload de respuesta real (el endpoint exige cabeceras de reCAPTCHA
 * `grc/igrc/xgrc` que este proyecto no intenta eludir, ver REQ-079).
 * Todos los campos son opcionales/permisivos a propósito: es un esquema de
 * mejor esfuerzo que debe ajustarse en cuanto se obtenga acceso real.
 */
export const ComprasMxApiRecordSchema = z.object({
  codigo_expediente: z.string().optional(),
  cod_expediente: z.string().optional(),
  titulo_expediente: z.string().optional(),
  tipo_expediente: z.string().optional(),
  tipo_contratacion: z.string().optional(),
  entidad_federativa_contratacion: z.string().optional(),
  dependencia_entidad: z.string().optional(),
  unidad_compradora: z.string().optional(),
  caracter: z.string().optional(),
  fecha_publicacion: z.string().optional(),
  fecha_junta_aclaraciones: z.string().optional(),
  fecha_apertura_proposiciones: z.string().optional(),
  fecha_fallo: z.string().optional(),
  monto_estimado: z.number().optional(),
  moneda: z.string().optional(),
  estatus: z.string().optional(),
  id_proceso: z.union([z.string(), z.number()]).optional(),
});
export type ComprasMxApiRecord = z.infer<typeof ComprasMxApiRecordSchema>;

export const ComprasMxApiResponseSchema = z.object({
  data: z.array(z.object({ registros: z.array(ComprasMxApiRecordSchema).default([]) })).default([]),
  total: z.number().optional(),
});
export type ComprasMxApiResponse = z.infer<typeof ComprasMxApiResponseSchema>;

/**
 * Columnas REALES verificadas del CSV histórico
 * "contratos_expedientes_sistema_historico_compranet" publicado por la
 * Secretaría Anticorrupción y Buen Gobierno (SABG) en datos.gob.mx
 * (descargado y confirmado 2026-09-05, HTTP 200, ver README §ComprasMX).
 * Cubre contratos de 2010-2022; es un dataset de CONTRATOS ya concluidos
 * (no de convocatorias abiertas), útil para benchmark de precios/huella de
 * proveedores, no para "descubrimiento" de oportunidades nuevas.
 */
export const ComprasMxHistoricoCsvRowSchema = z.object({
  codigo_contrato: z.string(),
  codigo_expediente: z.string(),
  proveedor: z.string(),
  titulo_contrato: z.string(),
  descripcion_contrato: z.string().optional(),
  contract_type: z.string().optional(),
  work_category_id: z.string().optional(),
  tipo_contratacion: z.string().optional(),
  tipo_expediente: z.string().optional(),
  importe: z.string().optional(),
  moneda: z.string().optional(),
  fecha_inicio: z.string().optional(),
  fecha_fin: z.string().optional(),
  project_code: z.string().optional(),
  ff_fecha_inicio: z.string().optional(),
  ff_fecha_fin: z.string().optional(),
});
export type ComprasMxHistoricoCsvRow = z.infer<typeof ComprasMxHistoricoCsvRowSchema>;
