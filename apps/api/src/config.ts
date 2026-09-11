export interface AppConfig {
  port: number;
  jwtSecret: string;
  databaseUrl?: string;
  nodeEnv: string;
  autoMigrate: boolean;
  /** Directorio local donde se guardan los archivos subidos (documentos de empresa, etc.). Nunca S3/objeto remoto en esta ronda. */
  storageDir: string;
  /** Orígenes permitidos para CORS, separados por coma. `*` deshabilita la restricción (solo recomendable en desarrollo). */
  corsOrigins: string[];
  /** Clave de API de plataforma para autenticar servicios internos (p.ej. apps/worker) contra `POST /internal/tenders/ingest`. */
  platformApiKey?: string;
  /**
   * Perfil de límites de tasa (`@fastify/rate-limit`, ver `lib/rate-limit-settings.ts`).
   * SIEMPRE `'default'` salvo que `RATE_LIMIT_PROFILE=e2e` esté definido
   * EXACTAMENTE así -- ronda 4 (docs/logs/api-ronda4.log): cualquier otro
   * valor (incluido no definir la variable, o `NODE_ENV=test`/`development`)
   * cae en `'default'`, nunca en `'e2e'`, para que una fuga de configuración
   * jamás relaje límites de producción por accidente. `'e2e'` existe
   * exclusivamente para que un harness de pruebas end-to-end (p.ej.
   * `apps/web` `scripts/e2e-full.mjs`) levante esta API con límites más
   * altos y no confunda un 429 real de una suite intensiva con un fallo de
   * producto (ver apps/web/README.md, bug de rate limit en
   * `docs/logs/web-ronda3.log`).
   */
  rateLimitProfile: 'default' | 'e2e';
  /**
   * REQ-044/064 (2FA/step-up en aprobaciones económicas): clave usada para
   * cifrar en reposo el secreto TOTP de cada usuario (`user_totp_secrets.secret_ciphertext`,
   * AES-256-GCM, ver `lib/step-up.ts`). Se deriva con SHA-256 de este valor
   * (acepta cualquier longitud de entrada) para obtener siempre 32 bytes --
   * limitación documentada: en producción real debería venir de un KMS, no
   * de una variable de entorno plana; fuera de alcance de esta ronda.
   */
  totpEncryptionKey: string;
  /** REQ-044/064: minutos de vigencia de una sesión de verificación en dos pasos (`step_up_sessions`) tras validar el TOTP. */
  stepUpWindowMinutes: number;
  /**
   * REQ-181..195 (docs/AMPLIACION-2-SALIDA.md §2): correo transaccional vía
   * `@atiende/mail` (`lib/mail/env.ts`). `MAIL_LINK_SECRET` firma los
   * enlaces de verificación/invitación/restablecimiento/baja
   * (`createLinkSigner`, ≥16 caracteres, mismo criterio que `jwtSecret`/
   * `totpEncryptionKey`). `publicUrl` es la base de esos enlaces (nunca la
   * URL de esta API -- es donde vive `apps/web`). `supportEmail` alimenta
   * `BaseVariablesSchema.supportEmail` de TODA plantilla; `contactInbox` es
   * a quién llega `contact-received` (`POST /public/contact`) -- por
   * defecto, el mismo `supportEmail`.
   */
  mailLinkSecret: string;
  publicUrl: string;
  supportEmail: string;
  contactInbox: string;
  /**
   * REQ-181..195: compuerta de verificación de correo en
   * `POST /auth/login`. Activada por DEFECTO (`REQUIRE_EMAIL_VERIFICATION`
   * distinto de `'false'`): una cuenta creada con email+contraseña no
   * inicia sesión hasta confirmar su correo. Se deja configurable porque
   * un despliegue SIN proveedor de correo real (el estado actual: las
   * credenciales son un bloqueo externo, ver packages/mail/README.md)
   * dejaría a todo mundo fuera -- ahí la compuerta se apaga
   * explícitamente, nunca por accidente ni por "no había proveedor".
   */
  requireEmailVerification: boolean;
  /**
   * REQ-181..195: secreto Svix del webhook de entrega/rebote del proveedor
   * (`RESEND_WEBHOOK_SECRET`). SIN él, `POST /webhooks/mail/:provider`
   * responde 503 y NUNCA aplica ningún efecto -- jamás se procesa un
   * webhook sin verificar su firma (falla cerrado, mismo criterio que
   * `platformApiKey`).
   */
  mailWebhookSecret: string | undefined;
  /**
   * REQ-090/074/080 (WhatsApp interactivo de doble vía): App Secret de la
   * app de Meta usado para verificar `X-Hub-Signature-256` en
   * `POST /webhooks/whatsapp` (ver `@atiende/whatsapp` `verifyMetaWebhookSignature`,
   * esquema real de Meta, distinto del Svix de `mailWebhookSecret`). SIN
   * él, el webhook responde 503 y NUNCA procesa nada -- mismo criterio de
   * "falla cerrado" que `mailWebhookSecret`. **PENDIENTE del usuario**
   * (bloqueo externo, ver docs/BLOQUEOS.md B-04/REQ-140: no hay app de Meta
   * ni plantillas con botones aprobadas todavía).
   */
  whatsappWebhookAppSecret: string | undefined;
  /**
   * REQ-090: `hub.verify_token` que Meta exige en el handshake `GET
   * /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=...` al dar de
   * alta la URL del webhook en el panel de la app -- un valor elegido por
   * Javier al configurar el webhook en Meta, no un secreto criptográfico.
   * **PENDIENTE del usuario**, mismo bloqueo que `whatsappWebhookAppSecret`.
   */
  whatsappWebhookVerifyToken: string | undefined;
  /**
   * REQ-067 (ChatGPT App / MCP, `modules/chatgpt-app/`): base pública de
   * ESTA API (nunca la de `apps/web` -- para eso está `publicUrl`), usada
   * solo para componer `mcp_endpoint` en `GET /chatgpt-app/manifest.json`.
   * `undefined` por defecto a propósito: un despliegue serverless (Vercel)
   * no conoce su propio host público de forma fiable, así que sin esta
   * variable el manifiesto declara el endpoint como ruta relativa en vez
   * de fabricar una URL absoluta que podría ser la equivocada.
   */
  apiPublicUrl: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 16) {
    throw new Error(
      'JWT_SECRET no definido o demasiado corto (mínimo 16 caracteres). Ver apps/api/.env.example.'
    );
  }
  const corsOriginsRaw = env.CORS_ORIGINS?.trim();
  const corsOrigins = corsOriginsRaw ? corsOriginsRaw.split(',').map((o) => o.trim()).filter(Boolean) : [];

  const totpEncryptionKey = env.TOTP_ENCRYPTION_KEY;
  if (!totpEncryptionKey || totpEncryptionKey.length < 16) {
    throw new Error(
      'TOTP_ENCRYPTION_KEY no definido o demasiado corto (mínimo 16 caracteres). Ver apps/api/.env.example.'
    );
  }

  const mailLinkSecret = env.MAIL_LINK_SECRET;
  if (!mailLinkSecret || mailLinkSecret.length < 16) {
    throw new Error(
      'MAIL_LINK_SECRET no definido o demasiado corto (mínimo 16 caracteres). Ver apps/api/.env.example y packages/mail/README.md.'
    );
  }
  const supportEmail = env.MAIL_FROM ?? 'soporte@atiende.mx';

  return {
    port: Number(env.PORT ?? 3000),
    jwtSecret,
    databaseUrl: env.DATABASE_URL,
    nodeEnv: env.NODE_ENV ?? 'development',
    autoMigrate: env.SKIP_MIGRATIONS !== 'true',
    storageDir: env.STORAGE_DIR ?? '.data/storage',
    corsOrigins,
    platformApiKey: env.PLATFORM_API_KEY,
    // Comparación estricta: solo el literal 'e2e' activa el perfil elevado.
    rateLimitProfile: env.RATE_LIMIT_PROFILE === 'e2e' ? 'e2e' : 'default',
    totpEncryptionKey,
    stepUpWindowMinutes: Number(env.STEP_UP_WINDOW_MINUTES ?? 5),
    mailLinkSecret,
    publicUrl: env.PUBLIC_URL ?? 'https://app.atiende.mx',
    supportEmail,
    contactInbox: env.CONTACT_INBOX ?? supportEmail,
    requireEmailVerification: env.REQUIRE_EMAIL_VERIFICATION !== 'false',
    mailWebhookSecret: env.RESEND_WEBHOOK_SECRET,
    whatsappWebhookAppSecret: env.WHATSAPP_WEBHOOK_APP_SECRET,
    whatsappWebhookVerifyToken: env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    apiPublicUrl: env.API_PUBLIC_URL,
  };
}
