# Informe de estado — Atiende Licitaciones

**Actualizado**: 2026-09-06 ~17:3x CST (versiones previas: 05:5x y 11:4x). **HEAD auditado**: `9a12173`. Repositorio: `/Users/javiercamaraportepetit/Documents/Codex/atiende-licitaciones-staging` (staging; ruta definitiva pendiente, B-01). Remoto privado: `https://github.com/javiercamarapp/atiende-licitaciones`.

## Lo esencial en un párrafo

El producto está **construido y probado de punta a punta a nivel de código**: 2.232 pruebas unitarias y de integración en verde más 137 de navegador real, incluyendo login con Google, correos transaccionales con 16 plantillas, onboarding, landing pública, términos y aviso de privacidad, y los archivos de despliegue. **Lo que impide promocionarlo hoy no es el código: son cinco decisiones o credenciales del usuario.** Y lo que impide declararlo formalmente cerrado no es tampoco el código: es que **la mitad del trabajo de la Ampliación 2 todavía no ha pasado por la auditoría adversarial y la reverificación independiente** que este proyecto exige para marcar cualquier cosa como CUMPLIDO (REQ-210).

## Tablero de aceptación (`docs/TABLERO.md`, escala estricta)

**237 criterios** (210 REQ + 15 pruebas mínimas A1–A15 + 12 pruebas mínimas S1–S12):

| Estado | Ahora (`9a12173`) | Antes de este pase (`a644803`) |
|---|---:|---:|
| CUMPLIDO | **57** | 54 |
| EN_EVIDENCIA | **101** | 54 |
| PENDIENTE | **65** | 117 |
| BLOQUEADO_EXTERNO | **6** | 4 |
| LÍMITE_ACEPTADO | **5** | 5 |
| NO_APLICA_A_PAQUETE | **3** | 3 |

**El salto de −52 en PENDIENTE no es trabajo nuevo**: es deuda de trazabilidad saldada. La tabla de la Ampliación 2 se había escrito por la mañana declarando «Sin código» para casi todo y nunca se actualizó tras las rondas 6, 7, 8a y K — era el hallazgo abierto **ML-07**, que este pase cierra. Solo 3 filas suben realmente a CUMPLIDO.

## Qué está listo para promoción

- **Autenticación completa**: email+contraseña con 2FA/TOTP y step-up por organización y propósito, **más login y registro con Google (OIDC)** con PKCE S256, `state` firmado, `nonce`, consumo atómico de un solo uso, verificación del `id_token` contra JWKS real, vinculación por email verificado, compuerta `sin_acceso` con onboarding explícito (decisión D-09) y segundo factor exigido también tras el login con Google.
- **Correos transaccionales**: 16 plantillas en español de México con marca Atiende, adaptadores Resend/Postmark/SMTP tras un único punto de decisión, bandeja de captura como valor por defecto seguro, enlaces firmados con expiración y token de un solo uso consumido atómicamente en base, preferencias y baja de un clic (RFC 8058), lista de supresión por rebote/queja, `outbox` con historial de intentos y webhook con firma Svix y guardia anti-replay.
- **Producto**: descubrimiento, matching, Go/No-Go, expediente completo (bases, matriz, propuestas, checklist, aprobaciones, paquete descargable), seguimiento post-adjudicación con máquina de estados de contrato, inconformidades, autopsia del fallo y radar de renovaciones; back office completo; panel con KPIs reales y checklist de activación.
- **Páginas públicas**: landing con propuesta de valor, cómo funciona, seguridad y solicitud de demo; demo de solo lectura; términos y aviso de privacidad publicados como borrador marcado.
- **Base y seguridad**: 74 migraciones idempotentes con checksum (numeradas hasta `0086`; las 0087/0088 aún sin commitear), RLS en toda tabla con `org_id`, funciones `SECURITY DEFINER` auditadas contra lista blanca, aislamiento cross-org verificado por ataque en 18/18 endpoints post-adjudicación y en las 8 herramientas de agentes.
- **Regla dura intacta**: el sistema **nunca** envía ofertas, firma, actúa en portales ni contacta a terceros. Verificado por ausencia de cliente HTTP saliente hacia cualquier portal.

**Gates reales, reproducibles hoy:**

| Comando | Resultado |
|---|---|
| `npm run -w apps/api test` | 74 archivos / **350 tests**, dos pasadas idénticas |
| `npm run -w apps/worker test` | 22 archivos / **383 tests**, dos pasadas, 0 timeouts |
| `npm run -w packages/mail test` | 26 archivos / **252 tests**, dos pasadas |
| `npm run -w packages/db test` | 27 archivos / **205 tests** |
| `npm run -w apps/web test` | 39 archivos / **162 tests**, cuatro pasadas |
| `npm run -w apps/web test:e2e:full` | **137/137** en navegador real contra `apps/api` real |

## Qué falta, sin adornos

**Credenciales que solo puede aportar el usuario** (sin ellas el producto no funciona para una persona real, por mucho que el código esté probado):
1. **Google OAuth** — `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` de Google Cloud + dominio autorizado. Hoy el flujo solo se ha ejercitado contra un proveedor OIDC falso.
2. **Proveedor de correo** — Resend, Postmark o SMTP transaccional, con dominio remitente verificado (SPF/DKIM), **más el `RESEND_WEBHOOK_SECRET`** para el webhook de rebotes y quejas. Sin esto no hay verificación de correo ni recuperación de contraseña reales.
3. **Host de `apps/api` y `apps/worker` + Postgres gestionado** — `apps/web` ya está en Vercel; el backend y la base no tienen destino decidido.

**Decisiones pendientes del usuario:**
- **B-07 — Deployment Protection de Vercel** *(lo más urgente)*: el despliegue está Ready en `https://atiende-licitaciones.vercel.app` pero responde con la pantalla de login de Vercel; el equipo tiene la protección activa y **el sitio no es público**. Sin desactivarla (Settings → Deployment Protection → Vercel Authentication, al menos para Production) no hay nada que promocionar.
- **B-06 — facturación de GitHub Actions**: ningún job de CI ha llegado a arrancar («recent account payments have failed or your spending limit needs to be increased»). Es facturación de la cuenta, no el workflow: `actionlint` está limpio. Mientras siga así, los gates formales de CI y el job con Postgres real nunca se ejecutan.
- **B-04 — modelo comercial**: no está decidido si el producto es B2B directo o autoservicio con planes, prueba gratuita y cobro. Determina si la landing lleva precios y checkout o se queda en «Solicitar demo».
- **B-01 — ruta definitiva del repositorio**: la carpeta destino nunca se localizó; se sigue trabajando en un staging separado.
- **INC-10 — el repositorio vive dentro de iCloud Drive** (`~/Documents`): explica la carga de CPU de los demonios de sincronización, las copias «archivo 2.ts» y parte de los timeouts de las suites largas. La recomendación es moverlo fuera de `~/Documents` o pausar la sincronización durante las pruebas; es un cambio de ajustes del sistema que no se hace sin instrucción del usuario. Está ligado a B-01: la ruta definitiva debería quedar fuera de iCloud.
- **Validación por abogado mexicano** de los términos de servicio y el aviso de privacidad, ambos publicados hoy como `borrador_pendiente_validacion_juridica`. Ninguna cifra legal debe afirmarse a un cliente real sin esa validación.

**Trabajo interno que falta para cerrar formalmente la Ampliación 2** (sin dependencias externas):
- **No existe auditoría adversarial de `apps/web` rondas 7/8a ni de `infra/`.** Sin ellas, ni el onboarding, ni la landing, ni los Dockerfiles pueden pasar de EN_EVIDENCIA.
- **Falta reverificación independiente de dos hallazgos ALTA ya reparados**: **GO-10** (el login repetido con Google no fijaba el contexto de usuario, lo que producía `sin_acceso` indebido y **saltaba el segundo factor**) y **R6-11** (los límites anti «PDF bomb» se evaluaban después del trabajo: 263 KB de entrada = 42 s de CPU).
- **La auditoría de la integración de correos en `apps/api` está en curso.**
- **El handler `mail_retry` de `apps/worker` no está commiteado**: hoy la API encola el job de reintento y nadie lo consume, así que el escenario S7 no está realmente verde.
- **WK6-04 (MEDIA, abierto)**: el `correlationId` no se sanea en `apps/worker` — 10 KB pasan íntegros a cada línea de log y a la base, y un byte NUL rompe el encolado. No es alcanzable desde fuera hoy porque la API filtra el encabezado a UUID en su frontera.

**Huecos funcionales concretos, medidos contra la letra de su propio criterio:** ningún estado vacío ofrece la siguiente acción (REQ-193); no hay analítica (REQ-198); el formulario de contacto de la landing está deshabilitado aunque el endpoint de la API ya existe y está probado (REQ-196); el onboarding tiene 5 pasos en vez de 6; no existe `sitemap.xml`; `apps/worker` no expone healthcheck y el compose no condiciona ningún servicio de aplicación a salud.

**Sin construir, declarado:** OCR real; firma electrónica del lado del cliente; WhatsApp y voz; pgvector; capa de juicio por modelo del guardrail anticolusión; calendario oficial de días inhábiles cargado con fechas reales. **Por diseño, nunca:** envío de ofertas, firma, actuación en portales, contacto con terceros.

**Bloqueo externo de datos (B-02):** ComprasMX responde 401 tras reCAPTCHA, OCDS-SHCP está inalcanzable, PDN-S6 tiene detección de bots y los portales estatales no exponen API localizable. La única fuente con dato real verificado sigue siendo el CSV histórico de la SABG. No se intenta eludir ninguna protección.

## Resumen del pase de trazabilidad (≤10 líneas)

1. Se abrió el test, log o commit de cada fila de la Ampliación 2 y de las filas afectadas por las rondas 6–8a; se cierra el hallazgo **ML-07**.
2. Conteo antes (`a644803`): 54 CUMPLIDO · 54 EN_EVIDENCIA · 117 PENDIENTE · 4 BLOQUEADO_EXTERNO · 5 LÍMITE · 3 NO_APLICA (237 filas).
3. Conteo después (`9a12173`): **57 · 101 · 65 · 6 · 5 · 3** (237 filas).
4. Los −52 de PENDIENTE son deuda de trazabilidad saldada, **no trabajo hecho hoy**.
5. Solo **3 filas nuevas llegan a CUMPLIDO**, todas de `packages/mail`, el único paquete con cadena auditoría→corrección→reverificación completa.
6. Siguen genuinamente sin código **2 filas**: REQ-193 (estados vacíos sin siguiente acción) y REQ-198 (sin analítica).
7. **2 ALTAS reparadas sin reverificar**: GO-10 (bypass de 2FA con Google) y R6-11 (bomba de PDF); **1 MEDIA abierta**: WK6-04.
8. Nuevos BLOQUEADO_EXTERNO: REQ-199, REQ-200 y S11 — **Docker no está instalado** (`which docker` → *not found*).
9. Para promocionar faltan credenciales (Google OAuth, proveedor de correo + secreto de webhook, host de API/Postgres) y decisiones B-04/B-06/**B-07**.
10. Para cerrar la ampliación falta auditar `apps/web` r7/8a e `infra/`, reverificar GO-10 y R6-11, y commitear el handler `mail_retry`.
