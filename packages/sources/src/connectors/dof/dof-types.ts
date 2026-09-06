import { z } from "zod";

/**
 * Representación intermedia de un aviso/convocatoria extraído de una nota
 * del DOF. El DOF no publica una API/JSON de convocatorias (verificado en
 * vivo el 2026-09-05, ver README §DOF): las convocatorias viven como texto
 * dentro de notas HTML (`nota_detalle.php?codigo=&fecha=`) en la Sección de
 * Avisos. Este esquema es el resultado de un parser de texto (heurística de
 * bloques "CONVOCATORIA" / "LICITACIÓN PÚBLICA"), ejecutado sobre fixtures
 * porque no se confirmó en vivo el formato exacto de una nota con
 * convocatorias reales dentro de la ventana de tiempo disponible.
 */
export const DofNoticeSchema = z.object({
  codigo: z.string(),
  fecha: z.string(), // DD/MM/YYYY, formato real de la URL del DOF
  dependencia: z.string(),
  numeroConvocatoria: z.string().optional(),
  titulo: z.string(),
  fechaJuntaAclaraciones: z.string().optional(),
  fechaPresentacionApertura: z.string().optional(),
  fechaFallo: z.string().optional(),
});
export type DofNotice = z.infer<typeof DofNoticeSchema>;
