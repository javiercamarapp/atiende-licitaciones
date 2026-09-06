/**
 * REQ-044/064: 2FA/step-up (TOTP, `otplib`) para aprobaciones económicas
 * sensibles (aprobar una tarifa, aprobar un expediente) -- distinto del rol
 * que aprueba. Este módulo concentra:
 *  - cifrado en reposo del secreto TOTP (AES-256-GCM, clave derivada de
 *    `config.totpEncryptionKey` con SHA-256 -- ver limitación documentada
 *    en `config.ts`: en producción real debería venir de un KMS).
 *  - generación/enrolamiento de un secreto TOTP + códigos de respaldo
 *    (hasheados con SHA-256, nunca en claro tras mostrarse una vez).
 *  - verificación de un código TOTP con protección de REPLAY: un código de
 *    un `timeStep` menor o igual al último aceptado para ese usuario se
 *    rechaza SIEMPRE, incluso si sigue siendo válido dentro de la ventana
 *    de tolerancia de `otplib`.
 *  - `requireStepUp`: exige el encabezado `X-Step-Up` (id de una fila
 *    vigente de `step_up_sessions`) para una acción sensible; sin 2FA
 *    enrolado responde con una instrucción explícita, nunca un 403 mudo.
 */
import { randomBytes, createCipheriv, createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { generateSecret, generate, verify, generateURI } from 'otplib';
import type { DbExecutor } from '@atiende/db';
import { BadRequestError, ForbiddenError, ValidationAppError } from './errors.js';

/**
 * R5-09 (docs/auditoria-2/api-ronda5-reverificacion.md, BAJA-MEDIA): lista
 * CERRADA de propósitos válidos para una sesión de step-up -- reforzada
 * ADEMÁS a nivel de esquema (CHECK, migración 0063) como defensa en
 * profundidad. Cualquier acción sensible nueva que exija step-up debe
 * declarar aquí su propio propósito explícito ANTES de poder usarlo (ver
 * `requireStepUp`) -- nunca un string libre inventado por el cliente.
 */
export const STEP_UP_PURPOSES = [
  'company.rate_approval',
  'expediente.approval',
  'tool_call.approval',
  'admin.action',
  // Ronda 6 (REQ-051/REQ-053, migración 0066 -- R6-06: el comentario decía
  // "0065" por un resto de la renumeración tras la colisión de subagentes
  // documentada en apps/api/docs/e11-cobertura.md; el archivo real es
  // 0066_r6_step_up_purposes_contract_inconformidad.sql): transiciones de contrato con
  // impacto económico/legal (rescindir/penalizar/en_inconformidad/modificar)
  // y marcar un borrador de inconformidad como revisado por abogado.
  'expediente.contract_transition',
  'expediente.inconformidad_review',
] as const;
export type StepUpPurpose = (typeof STEP_UP_PURPOSES)[number];

const ORG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * R5-09: `purpose` es OBLIGATORIO al pedir un step-up (antes era opcional,
 * R5-05/0061 -- pero ningún cliente real lo declaraba nunca, así que toda
 * sesión quedaba "genérica" y el alcance nunca se aplicaba en la práctica,
 * ver docs/auditoria-2/api-ronda5-reverificacion.md#R5-09). 400 explícito
 * (no 422): esto se valida a mano, fuera del `schema.body` de Fastify, para
 * poder distinguir "falta un campo obligatorio de la request" (400) de "el
 * campo vino con una forma inválida" (422, resto de la validación zod).
 */
export function assertStepUpPurpose(purpose: unknown): StepUpPurpose {
  if (typeof purpose !== 'string' || !(STEP_UP_PURPOSES as readonly string[]).includes(purpose)) {
    throw new BadRequestError(
      `El campo "purpose" es obligatorio para pedir una sesión de verificación en dos pasos y debe ser uno de: ${STEP_UP_PURPOSES.join(', ')}.`
    );
  }
  return purpose as StepUpPurpose;
}

/**
 * R5-09: `X-Org-Id` es OBLIGATORIO al pedir un step-up (antes opcional,
 * R5-05/0061) -- toda sesión queda atada a una organización concreta desde
 * que se crea, nunca "genérica". 400 explícito si falta o no es un UUID.
 */
export function assertStepUpOrgId(headerValue: string | string[] | undefined): string {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!raw || !ORG_UUID_RE.test(raw)) {
    throw new BadRequestError(
      'El encabezado X-Org-Id es obligatorio (UUID válido) para pedir una sesión de verificación en dos pasos: toda sesión de step-up queda atada a una organización concreta.'
    );
  }
  return raw;
}

const AES_ALGORITHM = 'aes-256-gcm';
const AES_IV_LENGTH = 12;
const AES_AUTH_TAG_LENGTH = 16;

function deriveKey(rawKey: string): Buffer {
  return createHash('sha256').update(rawKey, 'utf8').digest();
}

/** Cifra `plaintext` con AES-256-GCM; el resultado es `base64(iv || authTag || ciphertext)`. */
export function encryptSecret(plaintext: string, rawKey: string): string {
  const key = deriveKey(rawKey);
  const iv = randomBytes(AES_IV_LENGTH);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/** Descifra un valor producido por {@link encryptSecret}. */
export function decryptSecret(payloadBase64: string, rawKey: string): string {
  const key = deriveKey(rawKey);
  const raw = Buffer.from(payloadBase64, 'base64');
  const iv = raw.subarray(0, AES_IV_LENGTH);
  const authTag = raw.subarray(AES_IV_LENGTH, AES_IV_LENGTH + AES_AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(AES_IV_LENGTH + AES_AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function hashBackupCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase(), 'utf8').digest('hex');
}

/** Códigos legibles tipo "XXXX-XXXX" (sin 0/O/1/I para evitar ambigüedad visual). */
const BACKUP_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateBackupCode(): string {
  const chars = Array.from(randomBytes(8), (b) => BACKUP_CODE_ALPHABET[b % BACKUP_CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

export function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () => generateBackupCode());
}

export interface TotpEnrollment {
  secretBase32: string;
  otpauthUrl: string;
}

export function generateTotpEnrollment(accountEmail: string): TotpEnrollment {
  const secretBase32 = generateSecret();
  const otpauthUrl = generateURI({ issuer: 'Atiende Licitaciones', label: accountEmail, secret: secretBase32 });
  return { secretBase32, otpauthUrl };
}

export interface TotpVerification {
  valid: boolean;
  /** Contador de "time step" (30s) del código verificado -- usado para detectar replay. */
  timeStep: number;
}

export async function verifyTotpCode(secretBase32: string, code: string): Promise<TotpVerification> {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) {
    return { valid: false, timeStep: -1 };
  }
  const result = await verify({ secret: secretBase32, token: trimmed });
  return { valid: result.valid, timeStep: 'timeStep' in result ? Number(result.timeStep) : -1 };
}

/** Solo para pruebas/QR de referencia -- nunca se usa en un flujo de verificación real (el código lo genera SIEMPRE el usuario en su app autenticadora). */
export async function generateTotpCodeForTesting(secretBase32: string): Promise<string> {
  return generate({ secret: secretBase32 });
}

export interface StepUpCheckParams {
  userId: string;
  /** Valor crudo del encabezado `X-Step-Up` (id de `step_up_sessions`), si vino. */
  stepUpHeader: string | string[] | undefined;
  /**
   * Organización activa de la acción que está consumiendo el step-up
   * (`request.orgId`, ya verificado por `app.requireOrg`). R5-09: la
   * sesión SIEMPRE fue creada con un `orgId` explícito (obligatorio desde
   * esta ronda) -- debe coincidir exactamente, sin excepción.
   */
  orgId: string;
  /**
   * Propósito/acción que se está autorizando (p.ej.
   * "company.rate_approval", ver `STEP_UP_PURPOSES`). R5-09: la sesión
   * SIEMPRE fue creada con un `purpose` explícito (obligatorio desde esta
   * ronda) -- debe coincidir exactamente, sin excepción.
   */
  purpose: string;
}

/**
 * Exige una sesión de step-up VIGENTE, NO CONSUMIDA, y atada a la MISMA
 * organización/acción que se está autorizando ahora, para el usuario
 * actual. Debe llamarse dentro de una transacción con
 * `SET LOCAL ROLE app_role` + `app.current_user_id` ya fijados (mismo
 * patrón que el resto de apps/api) -- las políticas RLS de
 * `step_up_sessions`/`user_totp_secrets` ya limitan la consulta al propio
 * usuario, pero además se filtra explícitamente por `user_id` para que el
 * mensaje de error distinga "no enrolado" de "sesión vencida/inexistente".
 *
 * R5-09 (docs/auditoria-2/api-ronda5-reverificacion.md, BAJA-MEDIA):
 * reemplaza el alcance OPCIONAL de R5-05 (org/purpose nullable, nunca
 * ejercido en la práctica porque ningún cliente los declaraba) -- ahora
 * org/purpose son obligatorios en TODA sesión (ver
 * `assertStepUpOrgId`/`assertStepUpPurpose`, `modules/twofa/routes.ts`) y
 * la coincidencia se exige sin excepción, nunca con un "bypass genérico".
 * Además, la sesión se consume atómicamente (columna `consumed_at`,
 * migración 0062) la primera vez que autoriza una acción -- un
 * `stepUpToken` reutilizado responde 403, aunque siga vigente y el
 * org/purpose coincidan (mismo patrón de "UPDATE ... WHERE condición
 * RETURNING" que `app.rotate_refresh_token` usa para la rotación atómica
 * de refresh tokens).
 */
export async function requireStepUp(tx: DbExecutor, params: StepUpCheckParams): Promise<void> {
  const totp = await tx.query<{ verified_at: string | Date | null }>(
    'select verified_at from user_totp_secrets where user_id = $1',
    [params.userId]
  );
  if (totp.rows.length === 0 || totp.rows[0].verified_at === null) {
    throw new ForbiddenError(
      'Esta acción exige verificación en dos pasos (2FA/TOTP) y este usuario no tiene una app autenticadora enrolada. Enrole primero con POST /auth/2fa/enroll y confirme con POST /auth/2fa/verify-enrollment.'
    );
  }

  const header = Array.isArray(params.stepUpHeader) ? params.stepUpHeader[0] : params.stepUpHeader;
  if (!header) {
    throw new ForbiddenError(
      'Esta acción exige verificación en dos pasos reciente: incluya el encabezado X-Step-Up con el id devuelto por POST /auth/2fa/step-up (código TOTP válido en los últimos minutos).'
    );
  }

  const session = await tx.query<{
    user_id: string;
    expires_at: string | Date;
    org_id: string;
    purpose: string;
    consumed_at: string | Date | null;
  }>('select user_id, expires_at, org_id, purpose, consumed_at from step_up_sessions where id = $1', [header]);
  if (session.rows.length === 0 || session.rows[0].user_id !== params.userId) {
    throw new ForbiddenError('El encabezado X-Step-Up no corresponde a una sesión de verificación en dos pasos válida para este usuario. Vuelva a verificar con POST /auth/2fa/step-up.');
  }
  const row = session.rows[0];
  const expiresAtMs = new Date(row.expires_at).getTime();
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new ForbiddenError('La sesión de verificación en dos pasos expiró. Vuelva a verificar con POST /auth/2fa/step-up.');
  }
  if (row.consumed_at !== null) {
    throw new ForbiddenError('El encabezado X-Step-Up ya fue utilizado -- una sesión de verificación en dos pasos es de un solo uso. Vuelva a verificar con POST /auth/2fa/step-up.');
  }
  if (row.org_id !== params.orgId) {
    throw new ForbiddenError('El encabezado X-Step-Up corresponde a una sesión de verificación en dos pasos atada a OTRA organización. Vuelva a verificar con POST /auth/2fa/step-up para esta organización.');
  }
  if (row.purpose !== params.purpose) {
    throw new ForbiddenError('El encabezado X-Step-Up corresponde a una sesión de verificación en dos pasos emitida para OTRA acción. Vuelva a verificar con POST /auth/2fa/step-up para esta acción.');
  }

  // Consumo atómico: si otra request concurrente ya consumió esta MISMA
  // sesión entre el SELECT de arriba y este UPDATE, `consumed_at is null`
  // ya no aplica y 0 filas se actualizan -- se rechaza igual que un reuso
  // secuencial (nunca hay una ventana en la que dos requests concurrentes
  // consuman la misma sesión).
  const consumed = await tx.query('update step_up_sessions set consumed_at = now() where id = $1 and consumed_at is null', [header]);
  if (consumed.rowCount === 0) {
    throw new ForbiddenError('El encabezado X-Step-Up ya fue utilizado -- una sesión de verificación en dos pasos es de un solo uso. Vuelva a verificar con POST /auth/2fa/step-up.');
  }
}

/** Comparación en tiempo constante para códigos de respaldo (evita oráculo de timing sobre el hash). */
export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function assertSixDigitCode(code: unknown): string {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
    throw new ValidationAppError({ code: 'code debe ser un código TOTP de 6 dígitos.' });
  }
  return code.trim();
}
