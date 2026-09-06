/**
 * Almacenamiento del ZIP del expediente (`PackageAssembler.assemble`) y de
 * los documentos de bases subidos, en disco local bajo `STORAGE_DIR` (mismo
 * patrón que `lib/storage.ts` para documentos de empresa -- ninguna ronda de
 * este proyecto usa S3/objeto remoto).
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';

function resolveStoragePath(storageDir: string, relativePath: string): string {
  const base = isAbsolute(storageDir) ? storageDir : join(process.cwd(), storageDir);
  return join(base, relativePath);
}

export async function writePackageZip(storageDir: string, orgId: string, proposalId: string, zip: Uint8Array): Promise<string> {
  const relativePath = join(orgId, 'packages', `${proposalId}-${Date.now()}.zip`);
  const absolutePath = resolveStoragePath(storageDir, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, zip);
  return relativePath;
}

export async function readPackageZip(storageDir: string, relativePath: string): Promise<Buffer> {
  return readFile(resolveStoragePath(storageDir, relativePath));
}
