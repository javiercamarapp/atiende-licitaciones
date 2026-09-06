// WI-02 (docs/auditoria-2/web-integrado.md / REQ-098): el servidor SÍ valida
// en profundidad (magic bytes en todo el buffer, estructura mínima de PDF,
// límite de ~22MB decodificado -- ver apps/api/src/lib/storage.ts), pero
// antes de esta corrección la UI no rechazaba nada: el usuario descubría un
// archivo inválido o demasiado grande solo DESPUÉS de que el navegador ya
// hubiera codificado el archivo completo a base64 y lo hubiera enviado por
// red. Esta validación es deliberadamente ligera (extensión/MIME + tamaño):
// no pretende reemplazar la validación real del servidor (magic bytes en
// todo el buffer, estructura de PDF), solo dar un mensaje honesto e
// inmediato antes de leer/subir el archivo.

/** ~22MB, alineado con el límite real del servidor (`MAX_BASE64_LENGTH` en
 * apps/api/src/lib/storage.ts equivale a ~22MB decodificados). */
export const MAX_DOCUMENT_SIZE_BYTES = 22 * 1024 * 1024;

export const ACCEPTED_DOCUMENT_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png", ".doc", ".docx"] as const;

export const ACCEPTED_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

/**
 * REQ-098 (tolerancia cero): un archivo de e.firma nunca es un documento de
 * negocio legítimo en este dominio. Se comprueba explícitamente por
 * extensión ANTES que el allowlist de arriba (si por error algún día
 * coincidieran, esta lista gana) -- el mensaje nombra el motivo exacto en
 * vez de un genérico "tipo no admitido".
 */
const FORBIDDEN_EFIRMA_EXTENSIONS = [".cer", ".key", ".pfx", ".p12", ".der", ".pem"] as const;

/** Valor listo para el atributo `accept` del `<input type="file">`. */
export const DOCUMENT_ACCEPT_ATTR = [...ACCEPTED_DOCUMENT_EXTENSIONS, ...ACCEPTED_DOCUMENT_MIME_TYPES].join(",");

export interface FileValidationResult {
  ok: boolean;
  /** Mensaje honesto para mostrar en un toast cuando `ok` es `false`. */
  message?: string;
}

function getExtension(fileName: string): string {
  const idx = fileName.lastIndexOf(".");
  return idx === -1 ? "" : fileName.slice(idx).toLowerCase();
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** Solo necesita `name`/`size`/`type` -- acepta un `File` real del navegador
 * o cualquier objeto con esa forma (facilita pruebas unitarias sin DOM). */
export function validateDocumentFile(file: Pick<File, "name" | "size" | "type">): FileValidationResult {
  const extension = getExtension(file.name);

  if ((FORBIDDEN_EFIRMA_EXTENSIONS as readonly string[]).includes(extension)) {
    return {
      ok: false,
      message: `Los archivos de e.firma (.cer/.key/.pfx/.p12/.der/.pem) nunca se aceptan (REQ-098). "${file.name}" tiene la extensión "${extension}".`,
    };
  }

  if (file.size > MAX_DOCUMENT_SIZE_BYTES) {
    return {
      ok: false,
      message: `"${file.name}" pesa ${formatMb(file.size)} MB; el límite es 22 MB.`,
    };
  }

  const extensionOk = (ACCEPTED_DOCUMENT_EXTENSIONS as readonly string[]).includes(extension);
  const mimeOk = Boolean(file.type) && (ACCEPTED_DOCUMENT_MIME_TYPES as readonly string[]).includes(file.type);
  if (!extensionOk && !mimeOk) {
    return {
      ok: false,
      message: `"${file.name}" no tiene un tipo admitido. Formatos aceptados: ${ACCEPTED_DOCUMENT_EXTENSIONS.join(", ")}.`,
    };
  }

  return { ok: true };
}
