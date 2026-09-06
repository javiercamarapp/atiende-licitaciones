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
import { ForbiddenError, ValidationAppError } from './errors.js';

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
   * R5-05: organización activa de la acción que está consumiendo el
   * step-up (`request.orgId`, ya verificado por `app.requireOrg`). Si la
   * sesión fue creada CON un `orgId` explícito (ver `modules/twofa/routes.ts`),
   * debe coincidir -- si la sesión es "genérica" (orgId null, comportamiento
   * previo a esta ronda), no se exige coincidencia.
   */
  orgId?: string | null;
  /**
   * R5-05: propósito/acción que se está autorizando (p.ej.
   * "company.rate_approval"). Si la sesión fue creada CON un `purpose`
   * explícito, debe coincidir exactamente -- si la sesión es "genérica"
   * (purpose null), cualquier acción puede consumirla (comportamiento
   * previo a esta ronda, preservado para no romper clientes existentes que
   * nunca declaran `purpose` al pedir el step-up).
   */
  purpose?: string | null;
}

/**
 * Exige una sesión de step-up VIGENTE para el usuario actual. Debe llamarse
 * dentro de una transacción con `SET LOCAL ROLE app_role` +
 * `app.current_user_id` ya fijados (mismo patrón que el resto de
 * apps/api) -- las políticas RLS de `step_up_sessions`/`user_totp_secrets`
 * ya limitan la consulta al propio usuario, pero además se filtra
 * explícitamente por `user_id` para que el mensaje de error distinga
 * "no enrolado" de "sesión vencida/inexistente".
 *
 * R5-05 (docs/auditoria-2/api-ronda5.md, BAJA-MEDIA): además valida que la
 * sesión, si fue creada con un `orgId`/`purpose` explícitos, corresponda a
 * la MISMA organización/acción que se está autorizando ahora -- cierra
 * (para el cliente que decida declararlos) el hueco de que un mismo
 * `stepUpToken` sirviera, dentro de la ventana, para aprobar cualquier
 * número de tarifas/expedientes distintos en cualquier organización.
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

  const session = await tx.query<{ user_id: string; expires_at: string | Date; org_id: string | null; purpose: string | null }>(
    'select user_id, expires_at, org_id, purpose from step_up_sessions where id = $1',
    [header]
  );
  if (session.rows.length === 0 || session.rows[0].user_id !== params.userId) {
    throw new ForbiddenError('El encabezado X-Step-Up no corresponde a una sesión de verificación en dos pasos válida para este usuario. Vuelva a verificar con POST /auth/2fa/step-up.');
  }
  const expiresAtMs = new Date(session.rows[0].expires_at).getTime();
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new ForbiddenError('La sesión de verificación en dos pasos expiró. Vuelva a verificar con POST /auth/2fa/step-up.');
  }

  const sessionOrgId = session.rows[0].org_id;
  if (sessionOrgId !== null && sessionOrgId !== (params.orgId ?? null)) {
    throw new ForbiddenError('El encabezado X-Step-Up corresponde a una sesión de verificación en dos pasos atada a OTRA organización. Vuelva a verificar con POST /auth/2fa/step-up para esta organización.');
  }
  const sessionPurpose = session.rows[0].purpose;
  if (sessionPurpose !== null && sessionPurpose !== (params.purpose ?? null)) {
    throw new ForbiddenError('El encabezado X-Step-Up corresponde a una sesión de verificación en dos pasos emitida para OTRA acción. Vuelva a verificar con POST /auth/2fa/step-up para esta acción.');
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
