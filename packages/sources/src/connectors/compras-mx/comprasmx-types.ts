import { z } from "zod";
import { optionalNullish } from "../../util/schema.js";

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
 *
 * Los campos opcionales usan `optionalNullish()` en vez de `.optional()` a
 * secas (SR-13): un payload real de gobierno que devuelva `null` explícito
 * para un campo (patrón muy común en APIs JSON, distinto de omitir la
 * llave) no debe tumbar el registro completo con un `ZodError` clasificado
 * como `interface_changed` -- una falsa alarma cuando la estructura real no
 * cambió, solo el valor es `null`.
 */
export const ComprasMxApiRecordSchema = z.object({
  codigo_expediente: optionalNullish(z.string()),
  cod_expediente: optionalNullish(z.string()),
  titulo_expediente: optionalNullish(z.string()),
  tipo_expediente: optionalNullish(z.string()),
  tipo_contratacion: optionalNullish(z.string()),
  entidad_federativa_contratacion: optionalNullish(z.string()),
  dependencia_entidad: optionalNullish(z.string()),
  unidad_compradora: optionalNullish(z.string()),
  caracter: optionalNullish(z.string()),
  fecha_publicacion: optionalNullish(z.string()),
  fecha_junta_aclaraciones: optionalNullish(z.string()),
  fecha_apertura_proposiciones: optionalNullish(z.string()),
  fecha_fallo: optionalNullish(z.string()),
  monto_estimado: optionalNullish(z.number()),
  moneda: optionalNullish(z.string()),
  estatus: optionalNullish(z.string()),
  id_proceso: optionalNullish(z.union([z.string(), z.number()])),
});
export type ComprasMxApiRecord = z.infer<typeof ComprasMxApiRecordSchema>;

/**
 * SR-19 (residual de la ronda 2 de corrección): `data` YA NO usa
 * `.default([])`. Un cuerpo 200 sintácticamente válido pero sin la llave
 * `data` (p.ej. `{}`, o un soft-block de aplicación como
 * `{"success":false,"error":"captcha"}`) pasaba esta validación zod SIN
 * lanzar -- el `.default([])` absorbía la ausencia de la llave como "0
 * expedientes", indistinguible de una corrida real sin novedades (la MISMA
 * violación de REQ-148 que SR-14 debía cerrar, solo que vía un JSON válido
 * en vez de HTML). Ahora, la ausencia de `data` (o un valor no-array, p.ej.
 * `{"data":null}`) hace fallar `.parse()` con `ZodError` ->
 * `classifySourceFailure` lo clasifica como `interface_changed`. Un
 * `{"data":[]}` explícito (colección presente y vacía) sigue siendo válido
 * y se interpreta como "0 expedientes nuevos" legítimo -- la distinción que
 * importa es "la fuente respondió con la FORMA esperada" vs. "la fuente
 * respondió con OTRA cosa", no "hubo 0 registros".
 */
export const ComprasMxApiResponseSchema = z.object({
  data: z.array(z.object({ registros: z.array(ComprasMxApiRecordSchema).default([]) })),
  total: optionalNullish(z.number()),
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
  descripcion_contrato: optionalNullish(z.string()),
  contract_type: optionalNullish(z.string()),
  work_category_id: optionalNullish(z.string()),
  tipo_contratacion: optionalNullish(z.string()),
  tipo_expediente: optionalNullish(z.string()),
  importe: optionalNullish(z.string()),
  moneda: optionalNullish(z.string()),
  fecha_inicio: optionalNullish(z.string()),
  fecha_fin: optionalNullish(z.string()),
  project_code: optionalNullish(z.string()),
  ff_fecha_inicio: optionalNullish(z.string()),
  ff_fecha_fin: optionalNullish(z.string()),
});
export type ComprasMxHistoricoCsvRow = z.infer<typeof ComprasMxHistoricoCsvRowSchema>;
