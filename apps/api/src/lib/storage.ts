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

export async function storeFile(storageDir: string, orgId: string, buffer: Buffer): Promise<StoredFile> {
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
