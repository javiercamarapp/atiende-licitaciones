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

const MAX_BASE64_LENGTH = 30_000_000; // ~22MB decodificado, límite defensivo de esta ronda.

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
 * certificados en bruto), sin importar qué categoría se haya declarado.
 * No pretende ser una lista blanca completa de "tipos permitidos" (eso
 * exigiría saber el tipo esperado por `documentType`, que aquí es texto
 * libre) -- es una lista negra mínima y fail-closed de lo más peligroso.
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

function startsWithSignature(buffer: Buffer, signature: readonly number[]): boolean {
  if (buffer.length < signature.length) return false;
  return signature.every((byte, i) => buffer[i] === byte);
}

function looksLikePemKeyOrCertificate(buffer: Buffer): boolean {
  // Solo se decodifica como texto el encabezado (barato, sin riesgo de
  // interpretar binario arbitrario como texto para el resto del archivo).
  const head = buffer.subarray(0, 100).toString('latin1');
  if (!head.startsWith('-----BEGIN ')) return false;
  return /-----BEGIN (ENCRYPTED )?(RSA |EC |DSA )?(PRIVATE KEY|CERTIFICATE|CERTIFICATE REQUEST)-----/.test(head);
}

function looksLikeDerKeyOrCertificate(buffer: Buffer): boolean {
  // Prefijo ASN.1 "SEQUENCE, longitud de 2 bytes" (0x30 0x82): el patrón
  // estándar con el que empiezan tanto un certificado X.509 como una llave
  // PKCS#8, ambos en formato DER binario (.cer/.der/.key sin envoltura PEM).
  return buffer.length >= 4 && buffer[0] === 0x30 && buffer[1] === 0x82;
}

export function assertSafeFileContent(buffer: Buffer): void {
  if (EXECUTABLE_SIGNATURES.some((sig) => startsWithSignature(buffer, sig))) {
    throw new ValidationAppError({ contentBase64: 'Contenido rechazado: el archivo parece ser un ejecutable/binario de sistema, no un documento.' });
  }
  if (looksLikePemKeyOrCertificate(buffer) || looksLikeDerKeyOrCertificate(buffer)) {
    throw new ValidationAppError({ contentBase64: 'Contenido rechazado: el archivo parece ser una llave privada o un certificado en bruto (.key/.cer), no un documento de negocio.' });
  }
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
