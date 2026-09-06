import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { ValidationAppError } from './errors.js';

/**
 * Almacenamiento de archivos EN DISCO LOCAL, configurable vía `STORAGE_DIR`
 * (nunca S3/objeto remoto en esta ronda — ver apps/api/README.md). Los
 * archivos se guardan por organización y por hash de contenido
 * (`<STORAGE_DIR>/<orgId>/<sha256>`), así que subir el mismo contenido dos
 * veces nunca duplica el archivo en disco (dedupe natural por hash).
 *
 * El contenido llega en la petición HTTP codificado en base64 dentro del
 * cuerpo JSON (no se usa `multipart/form-data` en esta ronda, para no sumar
 * una dependencia adicional solo para esto); esto es una limitación
 * documentada y honesta en el README, no un intento de simular soporte de
 * multipart.
 */
export interface StoredFile {
  /** Ruta relativa a `STORAGE_DIR`, la que se persiste en `storage_ref`. */
  relativePath: string;
  sha256: string;
  sizeBytes: number;
}

// AE-15 (docs/auditoria-2/api-expediente-reverificacion.md, BAJA): exportada
// (antes privada de este archivo) para que `app.ts` configure el `bodyLimit`
// real de Fastify de forma COHERENTE con este límite -- antes, el
// `bodyLimit` por defecto de Fastify (1 MiB) rechazaba con 413 cualquier
// subida bastante antes de llegar aquí, muy por debajo del límite "~22MB"
// que esta constante (y el README) documentan como soportado.
export const MAX_BASE64_LENGTH = 30_000_000; // ~22MB decodificado, límite defensivo de esta ronda.

export function decodeBase64Content(contentBase64: string): Buffer {
  if (contentBase64.length > MAX_BASE64_LENGTH) {
    throw new ValidationAppError({ contentBase64: 'Archivo demasiado grande para esta ronda (límite ~22MB)' });
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(contentBase64, 'base64');
  } catch {
    throw new ValidationAppError({ contentBase64: 'No es base64 válido' });
  }
  if (buffer.length === 0) {
    throw new ValidationAppError({ contentBase64: 'El archivo decodificado está vacío' });
  }
  return buffer;
}

/**
 * API-11 (docs/auditoria-1/db-api-reverificacion.md, MEDIA; REQ-024 lado
 * API): antes, cualquier binario podía subirse bajo cualquier
 * `documentType` sin validar tipo/magic bytes. Esta comprobación es
 * DELIBERADAMENTE independiente del `documentType` declarado (el esquema
 * de subida no trae ni siquiera un nombre de archivo/extensión propios,
 * solo `contentBase64`): rechaza firmas que NUNCA son legítimas para un
 * documento de negocio en este dominio (ejecutables, llaves privadas y
 * certificados en bruto, y formatos comprimidos genéricos), sin importar
 * qué categoría se haya declarado. No pretende ser una lista blanca
 * completa de "tipos permitidos" (eso exigiría saber el tipo esperado por
 * `documentType`, que aquí es texto libre) -- es una lista negra mínima y
 * fail-closed de lo más peligroso.
 *
 * AE-03 (docs/auditoria-2/api-expediente.md, MEDIA): la versión anterior
 * solo comparaba estas firmas contra el OFFSET 0 del buffer
 * (`startsWithSignature`), trivialmente evadible con (a) unos pocos bytes
 * de padding antes de la firma, o (b) un archivo "envoltorio" legítimo
 * (p. ej. un PDF con header `%PDF-` real) que además contiene una firma
 * peligrosa completa EN CUALQUIER OTRO PUNTO del buffer (políglota:
 * "es un PDF válido" Y "es un ejecutable válido" a la vez, dependiendo de
 * qué lector lo interprete). Ahora se busca cada firma en TODO el buffer
 * (`containsSignatureAnywhere`), no solo al inicio.
 */
const EXECUTABLE_SIGNATURES: readonly (readonly number[])[] = [
  [0x4d, 0x5a], // MZ (PE/EXE de Windows)
  [0x7f, 0x45, 0x4c, 0x46], // ELF (Linux)
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32-bit
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64-bit
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32-bit (endian invertido)
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64-bit (endian invertido)
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O fat binary / class de Java
];

/**
 * AE-05 (docs/auditoria-2/api-expediente.md, BAJA-MEDIA): ningún documento
 * de bases/anexo/acuse de este dominio es legítimamente un ZIP (todo el
 * flujo espera PDF o texto plano, ver `text-extraction.ts`) -- el único ZIP
 * real del sistema es el que `apps/api` GENERA (paquete del expediente,
 * `package-storage.ts`), nunca uno que un cliente suba. En vez de intentar
 * poner límites de ratio/tamaño descomprimido (que exigirían descomprimir
 * primero, exactamente el vector de una zip-bomb), se rechaza cualquier
 * firma de ZIP de forma fail-closed -- elimina el vector por completo en
 * vez de mitigarlo parcialmente.
 */
const ZIP_SIGNATURES: readonly (readonly number[])[] = [
  [0x50, 0x4b, 0x03, 0x04], // ZIP local file header
  [0x50, 0x4b, 0x05, 0x06], // ZIP vacío / end of central directory
  [0x50, 0x4b, 0x07, 0x08], // ZIP spanned archive
];

function containsSignatureAnywhere(buffer: Buffer, signature: readonly number[]): boolean {
  return buffer.indexOf(Buffer.from(signature)) !== -1;
}

function looksLikePemKeyOrCertificate(buffer: Buffer): boolean {
  // AE-03: se busca el marcador PEM en TODO el buffer (como texto latin1),
  // no solo en el encabezado -- un políglota podría anteponer contenido
  // legítimo (p. ej. un PDF real) antes de una llave/certificado PEM
  // completo incrustado más adelante.
  return /-----BEGIN (ENCRYPTED )?(RSA |EC |DSA )?(PRIVATE KEY|CERTIFICATE|CERTIFICATE REQUEST)-----/.test(buffer.toString('latin1'));
}

function looksLikeDerKeyOrCertificate(buffer: Buffer): boolean {
  // Prefijo ASN.1 "SEQUENCE, longitud de 2 bytes" (0x30 0x82): el patrón
  // estándar con el que empiezan tanto un certificado X.509 como una llave
  // PKCS#8, ambos en formato DER binario (.cer/.der/.key sin envoltura PEM).
  // Se deja como comprobación de OFFSET 0 (a diferencia de las demás):
  // es el formato COMPLETO del archivo, no una firma dentro de un
  // contenedor -- buscar 2 bytes cualesquiera en todo un buffer de hasta
  // 22MB produciría falsos positivos inaceptables.
  return buffer.length >= 4 && buffer[0] === 0x30 && buffer[1] === 0x82;
}

const PDF_HEADER_SEARCH_WINDOW = 1024;
const PDF_HEADER_MARKER = '%PDF-';
const PDF_EOF_MARKER = '%%EOF';

/**
 * AE-03 (docs/auditoria-2/api-expediente.md, MEDIA): valida la ESTRUCTURA
 * mínima de un PDF cuando el buffer se presenta como tal (firma `%PDF-`
 * dentro de los primeros 1024 bytes, el margen que el propio formato PDF
 * permite para basura/comentarios previos al header): también debe
 * contener el marcador de fin de archivo `%%EOF`. Un PDF real de
 * `pdfjs-dist`/cualquier generador siempre lo tiene; su ausencia es señal de
 * un archivo corrupto o de un políglota que solo IMITA el header PDF para
 * pasar una heurística superficial.
 */
function validatePdfStructureIfClaimed(buffer: Buffer): void {
  const headWindow = buffer.subarray(0, PDF_HEADER_SEARCH_WINDOW).toString('latin1');
  if (!headWindow.includes(PDF_HEADER_MARKER)) return; // no se presenta como PDF -- no aplica esta validación.
  if (!buffer.toString('latin1').includes(PDF_EOF_MARKER)) {
    throw new ValidationAppError({
      contentBase64: 'Contenido rechazado: el archivo tiene firma de PDF ("%PDF-") pero no contiene el marcador de fin de archivo ("%%EOF") -- PDF corrupto o polígloto.',
    });
  }
}

export function assertSafeFileContent(buffer: Buffer): void {
  if (EXECUTABLE_SIGNATURES.some((sig) => containsSignatureAnywhere(buffer, sig))) {
    throw new ValidationAppError({ contentBase64: 'Contenido rechazado: el archivo parece ser (o contener) un ejecutable/binario de sistema, no un documento.' });
  }
  if (ZIP_SIGNATURES.some((sig) => containsSignatureAnywhere(buffer, sig))) {
    throw new ValidationAppError({ contentBase64: 'Contenido rechazado: el archivo parece ser (o contener) un ZIP/formato comprimido genérico, no soportado como documento en esta ronda (protección anti zip-bomb, AE-05).' });
  }
  if (looksLikePemKeyOrCertificate(buffer) || looksLikeDerKeyOrCertificate(buffer)) {
    throw new ValidationAppError({ contentBase64: 'Contenido rechazado: el archivo parece ser (o contener) una llave privada o un certificado en bruto (.key/.cer), no un documento de negocio.' });
  }
  validatePdfStructureIfClaimed(buffer);
}

export async function storeFile(storageDir: string, orgId: string, buffer: Buffer): Promise<StoredFile> {
  assertSafeFileContent(buffer);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const relativePath = join(orgId, `${sha256}.bin`);
  const absolutePath = resolveStoragePath(storageDir, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, buffer);
  return { relativePath, sha256, sizeBytes: buffer.length };
}

export async function readStoredFile(storageDir: string, relativePath: string): Promise<Buffer> {
  return readFile(resolveStoragePath(storageDir, relativePath));
}

function resolveStoragePath(storageDir: string, relativePath: string): string {
  const base = isAbsolute(storageDir) ? storageDir : join(process.cwd(), storageDir);
  return join(base, relativePath);
}

export type DocumentLifecycleStatus = 'valid' | 'expiring_soon' | 'expired' | 'pending_verification';

/**
 * Calcula el estado de vigencia de un documento comparando `validUntil`
 * contra la fecha de referencia dada (por defecto "hoy"). Documento sin
 * fecha de vigencia queda `pending_verification` (nunca se asume vigente
 * sin dato -- REQ-166: ausencia de dato nunca se traduce en "cumple").
 */
export function computeDocumentStatus(
  validUntil: string | null,
  referenceDate: Date = new Date(),
  expiringSoonDays = 30
): DocumentLifecycleStatus {
  if (!validUntil) return 'pending_verification';
  const until = new Date(validUntil);
  const diffDays = (until.getTime() - referenceDate.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays < 0) return 'expired';
  if (diffDays <= expiringSoonDays) return 'expiring_soon';
  return 'valid';
}
