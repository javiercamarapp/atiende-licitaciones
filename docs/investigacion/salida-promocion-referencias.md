# Referencias para "salida a promoción" — Google OAuth, correos, onboarding, landing y despliegue

Investigación de solo lectura sobre dos repos de referencia, para alimentar la Ampliación 2
(`docs/AMPLIACION-2-SALIDA.md`, requisitos REQ-172 a REQ-210 en `docs/REQUISITOS.md`, sección 34).
No se copiaron `.env`, secretos, claves, tokens ni IDs de despliegue. Dos direcciones de correo
personales hardcodeadas en el código de Atiende Restaurantes se mencionan como *patrón* sin
reproducir la dirección completa.

Repos fuente:
- **Atiende Restaurantes**: `/Users/javiercamaraportepetit/Documents/Codex/atiende-restaurantes`
  (Vite + React + TypeScript + shadcn/ui, Supabase, Vercel). Es el **panel de operación** con
  login — no tiene landing pública en este repo.
- **Likida** (principal): `/Users/javiercamaraportepetit/Documents/Codex/2026-08-30/haz-x20/work/repo`
  (Next.js 16 + React 19, Supabase, Vercel). Secundario (solo para complementar puntualmente):
  `/Users/javiercamaraportepetit/Documents/Codex/2026-08-23/realtime-voice-chat/audit-likida`.
  Likida tampoco tiene landing comercial en el repo (vive en `likida.ai`, sitio estático aparte);
  sí tiene piezas públicas con backend (calculadora, demo, blog, avisos legales).

---

## 1. Autenticación con Google

### 1.1 Atiende Restaurantes

- **Mecanismo**: Supabase Auth nativo. OAuth Google (`signInWithOAuth({provider:"google"})`) +
  magic link (`signInWithOtp`) como alternativa sin contraseña. Sin NextAuth ni OIDC propio.
- **Archivo clave**: `src/pages/AdminLogin.tsx` (ruta completa:
  `/Users/javiercamaraportepetit/Documents/Codex/atiende-restaurantes/src/pages/AdminLogin.tsx`).
- **Flujo**: `handleGoogle()` llama `signInWithOAuth({provider:"google", options:{redirectTo:
  origin + BASE_URL + "admin/login"}})`. No hay ruta de callback separada: `/admin/login` es el
  propio retorno; el componente detecta `access_token`/`refresh_token` en el hash de la URL y
  llama `supabase.auth.setSession(...)` a mano. Tras login, `routeAfterAuth()` lee `user_roles` y
  navega a `/admin/superadmin` (rol `superadmin`) o `/admin`.
- **Vinculación/creación de perfil**: no hay un flujo manual de "vincula tu cuenta". Ocurre por
  trigger de base de datos sobre `auth.users`:
  - `supabase/migrations/20251204073618_9392873b-9d3e-47a3-844c-29c5246939a5.sql` — trigger
    `on_auth_user_created`.
  - `supabase/migrations/20251204072058_9fd40c54-bd7a-420c-bd43-80f99281c240.sql` — función
    `handle_new_user_profile()`, inserta `profiles(user_id,email,nombre,telefono)`.
  - `supabase/migrations/20251204074017_de010357-736f-4afe-802c-c34499f37b0e.sql` — trigger
    `on_auth_user_role_assignment` + `handle_new_user_role()` (rol `'user'` por defecto).
  - No hay self-signup de tenant: el alta de staff de un restaurante ya existente se hace vía
    Edge Function `crear-cuenta-staff` (ver §3).
- **Pantallas y textos literales** (`AdminLogin.tsx`):
  - Kicker: *"Acceso al panel"*; título: *"Bienvenido a atiende"*; subtítulo: *"El panel de
    operación de tu restaurante."*
  - Botón Google: **"Continuar con Google"**; separador **"o"**; botón email: **"Continuar con
    correo"** (cargando: *"Enviando…"*).
  - Tras enviar magic link: *"Te mandamos un enlace a tu correo."* / *"Ábrelo desde este mismo
    dispositivo."* / *"¿No llega? Revisa spam, o vuelve a escribir tu correo."*
  - Pie: *"¿Tu correo no tiene acceso? Pídele a tu restaurante que te dé de alta."*
  - Legal: *"Al continuar, aceptas los Términos de Servicio y el Aviso de Privacidad de
    atiende.ai."*
- **Manejo de errores**: enlace caducado/usado → toast *"El enlace ya no sirve"* (con
  `error_description` decodificado del hash); fallo `setSession` → *"No se pudo iniciar sesión"*;
  fallo al iniciar OAuth → *"No se pudo continuar con Google"*; fallo al enviar magic link → *"No
  se pudo enviar el enlace"*; email sin permisos → *"Acceso denegado"* / *"No tienes permisos de
  administrador"*. No hay caso explícito de "usuario ya existe con otro proveedor" — Supabase
  vincula por email automáticamente. **Patrón a evitar**: el formulario de correo compara contra
  un email admin hardcodeado en el código (constante `ADMIN_EMAIL`), y hay una función SQL legacy
  (`handle_new_user_admin()` en `supabase/migrations/20251204004242_remix_migration_from_pg_dump.sql`,
  líneas 44-77) con otro email hardcodeado — ambos son deuda del piloto original, no un patrón a
  reproducir en Licitaciones (usar tabla/roles, nunca un email fijo en código).
- **Variables de entorno (solo nombres)**: `VITE_SUPABASE_PROJECT_ID`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
  `VITE_SUPABASE_URL`. Client ID/Secret de Google viven en el dashboard de Supabase Auth, nunca en
  el repo (confirmado en el README). Documentado en `docs/deployment-domains.md`: Site URL =
  `https://app.useatiende.ai/restaurantes`; único callback autorizado =
  `https://app.useatiende.ai/restaurantes/admin/login`.

### 1.2 Likida

- **Mecanismo**: Supabase Auth (GoTrue), proveedor `google` como segunda vía junto al magic
  link/OTP por correo (vía principal). Existe además un servidor OAuth 2.0 propio **no
  relacionado con Google** (RFC 8414/9728 + PKCE) para clientes MCP tipo Claude.ai/ChatGPT —
  rutas `.well-known/oauth-authorization-server`, `.well-known/oauth-protected-resource`,
  `src/app/mcp/autorizar/page.tsx`, `src/lib/mcp/oauth.ts` — no aplica a Licitaciones salvo que
  se planee exponer un MCP propio.
- **Flujo Google**: `src/app/login/page.tsx`, server action `entrarConGoogle`:
  `sb.auth.signInWithOAuth({provider:'google', options:{redirectTo: siteUrl()+'/auth/callback?next=...'}})`.
  Botón con SVG de Google inline, texto **"Continuar con Google"**; separador **"o"**; segunda
  vía **"Continuar con correo"**. Rate-limit compartido (`login:google`, 10/5min).
- **Callback compartido**: `src/app/auth/callback/route.ts` — misma ruta `GET
  /auth/callback?code=...` para magic link y Google; `exchangeCodeForSession` intercambia el code
  por sesión real. El destino post-login varía por **rol**, no por proveedor.
- **Vinculación/creación de tenant**: **nunca hay autoregistro**, ni por Google ni por correo.
  Único punto de alta: `src/lib/auth/provisionar.ts`,
  `provisionarUsuario(tenantId,email,nombre?,rol,telefono?)` — crea el usuario vía Admin API
  (`createUser({email_confirm:true})`) e inserta `app_user` con el mismo `id`; el primer login
  real (Google o magic link) es la confirmación.
  - **Compuerta si Google crea sesión sin fila en `app_user`**: rol cae a marcador `SIN_ROL`
    (`src/lib/auth/session.ts`, línea ~34), niega todos los permisos; guard
    (`src/lib/auth/guard.ts`, línea 63) redirige a `/sin-acceso`
    (`src/app/sin-acceso/page.tsx`): *"Tu cuenta aún no tiene flota"* / *"Iniciaste sesión, pero
    esta cuenta no está vinculada a ninguna flota en Likida. Pídele a tu administrador que te dé
    de alta desde su panel."*
  - **Hallazgo de seguridad documentado** (repo secundario,
    `docs/auditoria-18/hallazgos.md` líneas 2922-2933): `signInWithOAuth` no acepta un equivalente
    a `shouldCreateUser:false`; si el proveedor Google está encendido en Supabase sin la compuerta
    `SIN_ROL`, cualquiera con cuenta de Google puede obtener un JWT `authenticated` sin fila de
    negocio. **Lección explícita para Licitaciones**: no basta con "apagar" Google en el
    dashboard de Supabase — hay que replicar la compuerta `SIN_ROL` + pantalla `/sin-acceso` como
    defensa en profundidad.
- **Mecanismo principal (correo/OTP)** para contraste: `entrarConEmail` usa
  `signInWithOtp({email, options:{emailRedirectTo, shouldCreateUser:false}})`, con anti-enumeración
  (mismo mensaje de éxito exista o no la cuenta) y un "piso de tiempo" mínimo de 1500ms para
  igualar tiempos de respuesta (`src/app/login/respuesta_otp.ts`).
- **Textos literales** (`src/app/login/page.tsx`): *"Bienvenido a Likida"*, kicker *"Acceso al
  panel"*, subtítulo *"El panel de liquidación de tu flota."*; confirmación *"Te mandamos un
  enlace a tu correo."* / *"Ábrelo desde este mismo dispositivo."*; placeholder *"tu@flota.com"*;
  *"¿Tu correo no tiene acceso? Pídele a tu flota que te dé de alta."*; legal *"Al continuar,
  aceptas los Términos de Servicio y el Aviso de Privacidad de Likida."*
- **Errores** (`src/lib/auth/motivo_login.ts`): *"Ese enlace ya se usó o ya caducó. Pide uno
  nuevo con tu correo."*; *"Ese enlace se pidió desde otro navegador. Ábrelo en el navegador
  donde escribiste tu correo, o pide uno nuevo desde aquí."*; *"Algo falló. Intenta otra vez."*
- **Variables de entorno (solo nombres)**: `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_AUTH_HOOK_SECRET`,
  `AUTH_CORREO_CADUCIDAD_MIN`. Sin `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` en el repo — se
  configuran en el dashboard del proyecto Supabase.

### 1.3 Conclusión combinada

Ambos repos usan **Supabase Auth + OAuth Google nativo**, nunca un flujo OIDC propio. El patrón
común y reutilizable: (a) botón "Continuar con Google" junto a un método sin contraseña por
correo, nunca reemplazándolo; (b) una única ruta de callback compartida entre proveedores; (c)
**no autoregistro real de tenant vía Google** — el alta de la organización/rol la hace un admin
de antemano o el propio flujo de registro por email+contraseña, y Google solo autentica; (d) una
compuerta explícita (`SIN_ROL` / `/sin-acceso` en Likida) para el caso borde en que Google emite
sesión sin fila de negocio asociada — esto coincide exactamente con REQ-179/REQ-180 de
`docs/REQUISITOS.md` (rechazo de `email_verified=false`, verificación de conflicto de
organización antes de vincular).

---

## 2. Correos transaccionales

### 2.1 Atiende Restaurantes

- **Proveedor**: Resend, vía `fetch` HTTP directo a `https://api.resend.com/emails` (sin SDK).
  Archivo: `supabase/functions/send-order-notification/index.ts`. Los correos de auth (magic
  link, cambio de correo) usan las plantillas nativas de Supabase Auth (`{{ .ConfirmationURL
  }}`), configuradas en el dashboard/`config.toml`, no vía Resend.
- **Motor de plantillas**: HTML plano hecho a mano (tablas `<table role="presentation">` para
  compatibilidad de clientes de correo), sin React Email/MJML/Handlebars.
  - `supabase/functions/_shared/emails/plantilla.ts` — `renderCorreo(s)` genera el layout común
    (wordmark de texto, tarjeta blanca, etiqueta de estado con punto de color, tabla de datos,
    botón píldora, caja de nota, pie de tres líneas) + helper `moneda(n)` (MXN).
  - `supabase/functions/_shared/emails/plantillas.ts` — catálogo concreto sobre ese layout.
- **Catálogo de plantillas**:

  | Función | Asunto (patrón) | Disparador | Variables |
  |---|---|---|---|
  | `correoPedidoNuevo` | `Pedido nuevo · {sucursal} · {total}` | Pedido nuevo por voz/WhatsApp/web | cliente, teléfono, dirección, sucursal, total, fuente, ítems |
  | `correoPedidoPreparando` | `En preparación · {sucursal} · {cliente}` | Pedido confirmado a cocina | ídem |
  | `correoPedidoEnCamino` | `En camino · {sucursal} · {cliente}` | Sale a entrega | ídem |
  | `correoPedidoEntregado` | `Entregado · {sucursal} · {total}` | Marcado entregado | ídem |
  | `correoPedidoCancelado` | `Cancelado · {sucursal} · {cliente}` | Cancelación | ídem + `motivo` |
  | `correoPedidoProblema` | `Incidencia · {sucursal} · {cliente}` | Incidencia genérica | ídem + `nota` |
  | `correoBienvenida` | `Ya tienes acceso a {nombreRestaurante} en atiende.ai` | Alta de cuenta staff | `nombreRestaurante`, `rol` |

- **Plantillas de referencia de Supabase Auth** (HTML versionado para pegar en el dashboard):
  `docs/correo-auth/magic-link.html`, `docs/correo-auth/cambio-de-correo.html`.
- **Plantilla de prospección** (fuera del flujo transaccional): `docs/correo-ventas/prospeccion.html`.
- **Estructura visual**: sin logo-imagen — wordmark de texto **"atiende"** en azul `#1D4ED8`
  (Inter Tight/Inter), justificado en comentario del código porque Gmail bloquea imágenes
  externas por default. Fondo `#f7f9fc`, tarjeta blanca `#ffffff` borde `#e2e8f0`
  `border-radius:16px`. Etiqueta de estado con punto de color (azul/ámbar/cian/verde/rojo/magenta
  según evento). Botón píldora azul `#1D4ED8`. Caja de nota gris `#eef3f9`. Pie de tres líneas:
  *"atiende.ai · Pedidos por voz y WhatsApp para restaurantes"* + motivo de envío. Preheader
  oculto con `&zwnj;` repetido.
- **Copia literal — Pedido nuevo**: título *"Nuevo pedido por atender"*; preheader *"{cliente}
  pidió por {fuente} — {total}"*; etiqueta *"Pedido nuevo"*; cuerpo *"El agente de {fuente} acaba
  de tomar un pedido nuevo para **{sucursal}**."*; CTA *"Ver pedido en el panel"*; pie *"Recibes
  este correo porque activaste las notificaciones de pedido nuevo en tu cuenta de atiende.ai."*
- **Copia literal — Magic link** (`docs/correo-auth/magic-link.html`): título pestaña *"Tu acceso
  a atiende.ai"*; preheader *"Entra sin contraseña. El enlace sirve una vez y caduca en 1 hora."*;
  H1 *"Entra a atiende.ai"*; *"atiende.ai no usa contraseña: este enlace es la llave. Ábrelo desde
  el mismo dispositivo donde quieres trabajar."* / *"Sirve UNA sola vez y caduca en 1 hora. Si se
  te pasa, pide otro desde la pantalla de inicio de sesión."*; botón *"Entrar a atiende.ai"*;
  *"¿El botón no abre? Copia esta liga en tu navegador:"*; nota de seguridad *"Si no fuiste tú,
  ignora este correo: sin abrir el enlace nadie entra. atiende.ai jamás te va a pedir este enlace
  ni un código por WhatsApp, por teléfono ni por correo."*; pie *"Recibes este correo porque
  alguien pidió este acceso a atiende.ai con esta dirección."*
- **Copia literal — Bienvenida**: título *"Ya tienes acceso a {nombreRestaurante}"*; etiqueta
  *"Cuenta nueva"*; cuerpo *"Te dieron de alta en el panel de operación de **{nombreRestaurante}**
  en atiende.ai, con el rol de **{rol}**."* / *"No necesitas contraseña: entra con tu correo y te
  llega un enlace de acceso de un solo uso, o con tu cuenta de Google."*; CTA *"Entrar a
  atiende.ai"*; pie *"Recibes este correo porque alguien de tu restaurante te dio de alta en
  atiende.ai con esta dirección."*
- **Registro/reintentos — patrón outbox transaccional**:
  - Tabla `messaging_outbox` (`supabase/migrations/20260904059000_messaging_outbox.sql`):
    `channel`, `event_type`, `dedupe_key` (único por tenant+canal), `status`
    (pending/processing/sent/failed/dead), `attempts`, `available_at`, `lease_until`,
    `fence_token`, `last_error`, `sent_at`.
  - RPCs: `enqueue_messaging_outbox`, `claim_messaging_outbox_batch` (`FOR UPDATE SKIP LOCKED`),
    `complete_messaging_outbox` (backoff hasta `max_attempts=8`, luego `dead`).
  - Trigger `enqueue_order_email_outbox` encola automáticamente al cambiar `status` de `orders`.
  - Dispatcher: `supabase/functions/messaging-dispatcher/index.ts`, invocado cada 5 min por
    `.github/workflows/messaging-dispatcher.yml`.
  - Envío usa `Idempotency-Key: order/{order_id}/{evento}` (Resend la retiene 24h).
  - **No hay webhooks de bounce/delivery de Resend implementados** en este repo.
- **Preferencias de notificación**: por **restaurante** (no por usuario individual) — toggles
  booleanos (`notify_nuevo`, `notify_preparando`, `notify_en_camino`, `notify_entregado`,
  `notify_cancelado`, y en preparación `notify_entrega_tardia`, etc.) en
  `src/components/admin/NotificacionesSection.tsx` /
  `supabase/migrations/20260903041514_orders_delivered_at_and_staff_notify_prefs.sql`.

### 2.2 Likida

- **Proveedor**: Resend, HTTP directo con `fetch` (sin SDK: no hay `resend`/`nodemailer` en
  `package.json`). Archivo: `src/lib/correo/enviar.ts` — timeout propio de 5s, remitente `Likida
  <avisos@${RESEND_EMAIL_DOMAIN}>` (o `acceso@` para correos de Auth), **logo adjunto inline**
  (`content_disposition:'inline'`, `cid:likida-logo`, nunca URL externa), soporta
  `Idempotency-Key` y cabeceras `List-Unsubscribe`/`List-Unsubscribe-Post: One-Click`. **Decisión
  de producto explícita**: nunca reintenta automáticamente ni lanza excepción — devuelve
  `{ok:true,id}` o `{ok:false,motivo:'sin_configurar'|'rechazado'|'red'}` ("un aviso duplicado
  por retry ciego enseña a ignorar las alertas").
- **Motor de plantillas**: `src/lib/correo/plantilla.ts` — HTML plano con tablas de 600px, CSS
  100% inline (justificado: Gmail borra `<style>` del `<head>`, Outlook usa el motor de Word).
  Contrato único tipado `Correo = {asunto, avance(preheader), titulo, parrafos[],
  datos?[etiqueta,valor], boton?, codigo?, nota?, tono?, porQueLoRecibes, bajaHref?}`; cada evento
  es una función que arma ese objeto (no hay "archivo de plantilla" por evento). Expone también
  `armarHtml`, `aTextoPlano`, `esc()`/`hrefSeguro()` (sanitización).
- **Catálogo de plantillas**:

  **A. Avisos operativos** (`src/lib/correo/avisos.ts`, disparados desde
  `src/lib/likida/agentes/notificaciones.ts`, con lógica anti-ruido por marcas 1/5/20):

  | Función | Disparador | Asunto literal |
  |---|---|---|
  | `avisoVigencias` | Papeles/verificación por vencer | `"${pendientes} unidad(es) necesita(n) papeles"` |
  | `avisoCorridaFallida` | Agente dejó de correr | `"${agente} no pudo completar su corrida"` |
  | `avisoHuerfanos` | Comprobantes sin viaje | `"${cuantos} comprobante(s) sin viaje"` |
  | `avisoEscalados` | Viajes escalados a humano | `"${cuantos} viaje(s) escalado(s)"` |
  | `avisoColaAtorada` | Cola sin avanzar | `"${agente}: ${cuantos} pendiente(s) sin avanzar"` |
  | `avisoInvitacion` | Alta de usuario | `"Ya tienes acceso a ${flota} en Likida"` |
  | `avisoDePrueba` | Botón "mándate una prueba" | `"[Likida] Prueba de avisos — ${agente}"` |

  **B. Correos de Auth** (`src/lib/correo/auth.ts`, vía Supabase Send Email Hook, sustituyen las
  plantillas nativas): magiclink (*"Tu acceso a Likida"*), signup (*"Confirma tu correo —
  Likida"*), invite (*"Te dieron acceso a Likida"*), recovery (*"Recupera tu acceso a Likida"*),
  email_change (*"Confirma el cambio de tu correo — Likida"*), reauthentication (*"Tu código de
  confirmación — Likida"*), más 7 avisos de seguridad no desactivables (`email_changed`,
  `password_changed`, `phone_changed`, `mfa_enrolled`/`unenrolled`, `identity_linked`/`unlinked`).

  **C. Correo frío de prospección** (redactado por LLM): asunto fijo *"Automatizar la
  liquidación de viajes, antes de contratar para el puesto"*, máx. 5 líneas, placeholder
  `{{NOMBRE}}`, siempre con CTA de agenda, aprobado por humano antes de enviarse, liga de baja
  obligatoria (falla en modo cerrado si falta el secreto de firma de baja).

  **D. Alertas internas**: `alertarOperador` (*"[Likida] Falló ${evento}"*),
  `alertarHuecoConfiguracion` (*"[Likida] Pendiente de configurar: ${evento}"*).

  **E. Aviso de pago**: `correoDePropuesta` — *"${cliente} registró un pago de ${monto}"*.

  **F. Decisión de producto explícita**: no existe correo de "todo salió bien" — solo se avisa lo
  que requiere acción humana.

- **Estructura visual**: paleta neutra de correo (no el naranja de marketing): `marca:#18181b`,
  `tinta:#17100d`, `muted:#6b7280`, `linea:#ececef`, `lienzo:#f9f9fa`. Tipografía *Inter Tight*
  (títulos), *Inter* (cuerpo), *IBM Plex Mono* (código OTP). Cabecera con logo LIKIDA adjunto
  inline (`cid:`), tarjeta blanca borde 16px, título H1, párrafos, bloque de datos, botón negro
  en píldora, **liga literal visible** (para escáneres corporativos), nota de seguridad, pie con
  "por qué te llegó este correo" + enlace de baja de un clic (solo en campaña fría).
- **Copia literal — Magic link** (*"Tu acceso a Likida"*): preheader *"Entra sin contraseña. El
  enlace sirve una vez y caduca en 1 hora."*; H1 *"Entra a Likida"*; *"Likida no usa contraseña:
  este enlace es la llave. Ábrelo desde el mismo dispositivo donde quieres trabajar."* / *"Sirve
  UNA sola vez y caduca en 1 hora. Si se te pasa, pide otro desde la pantalla de inicio de
  sesión."*; botón *"Entrar a Likida"*; *"¿El botón no abre? Copia esta liga en tu navegador:"*;
  nota *"Si no fuiste tú, ignora este correo: sin abrir el enlace nadie entra. Likida jamás te va
  a pedir este enlace ni un código por WhatsApp, por teléfono ni por correo."*; pie *"Likida ·
  Liquidación de viajes por WhatsApp"* / *"Recibes este correo porque alguien pidió este acceso a
  Likida con esta dirección."*
- **Copia literal — Invitación**: asunto *"Te dieron acceso a Likida"*; H1 *"Ya tienes acceso a
  Likida"*; *"Alguien de tu empresa te dio de alta en Likida, donde se liquidan los viajes de la
  flota. Tu cuenta ya existe: solo falta que entres la primera vez."*; botón *"Entrar por primera
  vez"*.
- **Copia literal — Corrida fallida** (código fuente real): `titulo: 'La plataforma de Likida
  tuvo un problema'`, `parrafos: ['La corrida no se pudo completar por un problema de la
  plataforma de Likida — no de tu información. Tus datos están bien y no tienes nada que
  corregir: reintentamos solos en la siguiente corrida.']`.
- **Copia literal — Pago registrado**: asunto `"${cliente} registró un pago de ${monto}"`; título
  *"Un cliente registró un pago en tu portal"*; *"Todavía NO está aplicado a la factura: el saldo
  de tu cartera no se movió. Es lo que tu cliente afirma haber pagado, y queda esperando a que lo
  cruces contra tu estado de cuenta."*; botón *"Conciliarlo en Likida"*.
- **Registro de envíos/reintentos/webhooks**:
  - Tabla `cola_aprobacion` (campaña fría): `estado`, `provider_message_id`, `envio_error`,
    `entrega_estado` (entregado/rebotado/queja).
  - Tabla `correo_suprimido` (lista de supresión, deny-all, solo `service_role`), consultada
    antes de cada envío de campaña (fail-closed).
  - Webhooks: `POST /api/correo/eventos` (entrega/bounce de Resend, firma Svix HMAC, dispara
    supresión automática ante rebote/queja); `POST /api/correo/entrante` (intake de facturas por
    correo + respuestas de campaña); `POST /api/correo/baja` (liga de baja HMAC, soporta
    one-click RFC 8058); `POST /api/auth/correo` (Send Email Hook de Supabase, firma Standard
    Webhooks).
  - **Sin reintentos automáticos** — decisión de producto documentada explícitamente (igual
    filosofía que "sin correo de todo salió bien": menos ruido, más señal).
- **Preferencias de usuario**: pantalla `/dashboard/agentes` → pestaña "Notificaciones"
  (`src/app/dashboard/agentes/seccion-notificaciones.tsx`) — configurable por agente/evento/rol,
  con botón "Mándate una prueba".
- **Variables de entorno (solo nombres)**: `RESEND_API_KEY`, `RESEND_EMAIL_DOMAIN`,
  `LIKIDA_TIMEOUT_CORREO_MS`, `RESEND_WEBHOOK_SECRET`, `RESEND_EVENTOS_WEBHOOK_SECRET`,
  `SUPABASE_AUTH_HOOK_SECRET`, `LIKIDA_BAJA_SECRET`, `ALERTA_EMAIL`.

### 2.3 Conclusión combinada

Ambos usan **Resend vía `fetch` HTTP directo** (sin SDK), HTML plano con tablas y CSS inline
(nunca React Email/MJML en producción), logo como texto/imagen inline (nunca URL externa), y un
"contrato" único de datos de plantilla en vez de un archivo HTML por evento. Likida es más
maduro: tiene lista de supresión, webhooks de bounce/queja, decisión explícita de **no reintentar
automáticamente**, y un patrón anti-ruido (avisar solo en las marcas 1/5/20, nunca "todo bien").
Atiende Restaurantes en cambio sí implementa un **outbox transaccional con reintento/backoff**
(tabla `messaging_outbox` + dispatcher periódico) pero no tiene webhooks de bounce ni lista de
supresión. **Para Licitaciones (REQ-181 a REQ-190), lo recomendable es combinar ambos**: el
outbox con reintentos de Atiende Restaurantes + los webhooks/supresión/preferencias de Likida.

---

## 3. Onboarding

### 3.1 Atiende Restaurantes

- **No existe un wizard/checklist de onboarding de usuario nuevo** (confirmado por búsqueda
  exhaustiva). El modelo es **provisioning por administrador**, no self-signup:
  - Edge Function `supabase/functions/crear-cuenta-staff/index.ts`: crea el usuario vía
    `auth.admin.createUser({email_confirm:true})` (sin contraseña), inserta `profiles`, asigna
    `user_roles` (`admin`/`repartidor`/`superadmin`), lo vincula a `restaurant_staff`. Si falla
    cualquier insert, revierte borrando el usuario huérfano (`limpiarYFallar`).
  - UI de alta: `src/components/ModalCuenta.tsx` — roles disponibles: *Administrador* ("Panel
    completo de este restaurante."), *Repartidor* ("Solo la app de entregas."),
    *Superadministrador* ("Acceso a todos los restaurantes de atiende."). Toast de éxito:
    *"¡Cuenta creada!"* / *"{nombre} {apellidos} ya puede iniciar sesión con Google o un enlace
    mágico a {email}."*
  - No hay checklist de activación de tenant (ej. "conecta tu WhatsApp", "sube tu menú").
- **Estados vacíos** — patrón "honesto" (nunca inventa datos), documentado como filosofía en
  comentarios del código:
  - `src/pages/AdminDashboard.tsx`: caja de "no hay datos todavía" con `GraficaFantasma` (línea
    plana punteada en vez de cifras falsas), comparado explícitamente con el patrón de ElevenLabs.
  - `src/components/admin/ClientesSection.tsx`: *"Todavía no hay clientes reales guardados. Se
    registran solos cuando alguien pide por voz o WhatsApp — o impórtalos ahora desde un
    archivo."*
  - `src/components/admin/PedidosSection.tsx`: *"No hay pedidos por despachar"*, *"No hay pedidos
    en camino"*, *"No hay pedidos programados"*.
  - `src/components/admin/NotificacionesSection.tsx`: *"No hay notificaciones pendientes en esta
    categoría."*
  - `src/pages/SuperAdminDashboard.tsx`: *"Todavía no hay clientes registrados."*, *"Todavía no
    hay restaurantes dados de alta."*, y sobre métricas ausentes: *"Todavía no rastreamos MRR,
    gastos ni costo de IA en este panel [...] En cuanto haya una fuente real [...] se agrega
    aquí."*
- **Email de bienvenida**: `correoBienvenida` (§2.1) está definido pero no se confirmó una
  invocación real desde `crear-cuenta-staff` (posible gap del piloto).

### 3.2 Likida

- **Naturaleza del flujo**: **entrevista conversacional**, no wizard clásico de pasos fijos.
  Ruta `src/app/dashboard/onboarding/`:
  - `page.tsx` (Server Component): resuelve tenant, lee `perfil` (jsonb en `tenant.perfil`),
    calcula la pregunta pendiente.
  - `chat.tsx`: chat cliente con adjuntar fotos, chips de respuesta rápida, panel "Consulta" de
    FAQ por categoría.
  - `forma.tsx`: formulario tradicional plegado bajo `<details>`, texto *"Prefiero el
    formulario"* como alternativa para quien no quiere chatear.
  - Backend: catálogo de 24 preguntas (`src/lib/likida/perfil/entrevista.ts`, constante
    `CATALOGO`), cada una con título, pregunta, "porQué" (justificación) y "sustento" (cita
    normativa); un LLM interpreta la respuesta libre y la mapea a campos declarados.
- **Compuerta de onboarding** (`src/app/dashboard/page.tsx`): si el rol es `flota_admin` y el
  tenant existe, se calcula `faltaOnboarding = !onboardingFiscalListo(perfil)` y se redirige a
  `/dashboard/onboarding` si falta. `onboardingFiscalListo()`
  (`src/lib/likida/perfil/preguntas.ts`) exige **solo 2 de las 24 preguntas** como obligatorias
  — todo lo demás se completa después; solo aplica al rol dueño; si la lectura falla, no se
  redirige ("mejor el panel a medias que el dueño encerrado fuera"). Nota de riesgo documentada
  en `src/app/dashboard/onboarding_gate.test.tsx`: hubo un bug real donde un `catch` desnudo se
  tragaba la excepción `NEXT_REDIRECT` de Next.js, dejando la compuerta sin efecto — vigilar este
  patrón si se replica en Next.js.
- **Checklist de activación real — "Tu primera liquidación"**
  (`src/app/dashboard/primera-liquidacion.tsx` + `src/lib/likida/primeros-pasos.ts`): visible
  solo mientras no exista la primera transacción de cierre; 4 pasos, cada uno palomeado por
  **conteo real en Supabase** (nunca "de cortesía"):
  1. *"Da de alta a tu primer operador"* — *"Nombre y teléfono — con eso Likida ya sabe de quién
     es cada comprobante."* → CTA "Ir a Operadores"
  2. *"Crea un viaje con su anticipo"* — *"Ruta, operador y anticipo. El viaje es la carpeta donde
     cae todo lo demás."* → CTA "Crear viaje"
  3. *"Que el operador mande una foto del ticket por WhatsApp"* — *"Una foto real desde su
     teléfono — Likida la lee, la clasifica y la cuelga del viaje."* → CTA "Cómo conectar
     WhatsApp"
  4. *"Cierra la liquidación"* — *"El motor cuadra gastos contra anticipo y política; tú revisas
     solo las excepciones."* → CTA "Ver liquidación"
  - Título *"Tu primera liquidación"*, contador *"X de 4"*, subtítulo *"Así se aprende Likida: no
    con un manual, con un viaje real. Cada paso se palomea solo cuando de verdad sucede."*, pie
    *"¿Prefieres preguntar? El chat de tus datos te lleva de la mano — y por WhatsApp también."*
- **Estados vacíos** (componente compartido `EstadoVacio`, `src/app/admin/ui/kit.tsx`):
  - Sin flota: *"No hay ninguna flota dada de alta."*
  - Sin operadores: *"Aún no hay operadores dados de alta — el alta rápida vive en Despacho."*
  - Sin viajes: *"Aún no hay viajes registrados — el primero que despaches aparece aquí."*
  - Sin unidades: *"Todavía no hay unidades dadas de alta. Cuando registres tus tractocamiones
    con su póliza, permiso SICT y verificación, aquí se ve cuál está por vencer antes de que te
    pare un inspector."*
  - Sin clientes: *"Todavía no hay un solo cliente dado de alta, y por eso Likida ve lo que tu
    flota **gasta** pero no lo que **cobra**."*
  - Sin tarifas: *"No hay tarifas capturadas. [...] Sin catálogo no se sugiere un precio: se dice
    que no hay."*
  - Mensaje de bienvenida de la entrevista: *"Soy el configurador de Likida. Voy a dejar el
    software listo para operar: fiscal, con qué sistemas trabajan y la operación (choferes,
    unidades, topes). No supongo nada: si no lo sabes, queda pendiente. Lo que los tickets
    revelan [...] NO te lo pregunto — el motor lo infiere."*
- **Correo de bienvenida**: no existe uno dedicado de producto (sin resultados). Lo más cercano es
  el correo de **invitación** (§2.2-B), que recibe un usuario nuevo dado de alta por un admin.
- **Puerta de sesión vs. onboarding**: `src/app/dashboard/layout.tsx` solo verifica sesión
  (redirect a `/login`); deliberadamente **no** resuelve tenant/rol/onboarding ahí — cada página
  lo hace por separado porque necesita sus propios `searchParams`.

### 3.3 Conclusión combinada

Atiende Restaurantes no tiene onboarding de usuario nuevo (modelo B2B "te doy de alta yo"); su
patrón fuerte y reutilizable son los **estados vacíos honestos** (nunca inventar datos, siempre
explicar cuándo aparecerá algo real). Likida sí tiene un onboarding real de dos capas: (1) una
**compuerta mínima obligatoria** (solo 2 de 24 preguntas bloquean el panel) resuelta por
entrevista conversacional con opción de formulario tradicional, y (2) un **checklist de
activación de producto** ("Tu primera liquidación") con pasos palomeados por hechos reales en la
base de datos, nunca por clic de "marcar como hecho". Esto mapea directo a REQ-191/REQ-192/REQ-193
de `docs/REQUISITOS.md` (flujo guiado navegable, checklist de activación, estados vacíos con
guía de siguiente acción).

---

## 4. Landing y páginas públicas

### 4.1 Atiende Restaurantes

- **No hay landing pública en este repo** — es el panel de operación, arranca en login. Cita
  literal de `src/App.tsx`: *"Este es el software (panel de operación), no el sitio público del
  restaurante [...] El storefront de cada negocio vive en su propio repo."* La landing
  (`useatiende.ai`) está **pendiente**, según `docs/deployment-domains.md`, y vive en otro
  proyecto/dominio distinto del software (`app.useatiende.ai/restaurantes`).
- **Rutas reales**: `/`, `/admin/login`, `/terminos`, `/privacidad`, `/admin/superadmin`,
  `/admin`, `/admin/repartidor/:userId`, `/repartidor`, `*` (404). Sin `/pricing`, `/demo`,
  `/features`, `/contacto`.
- **Precios/demo**: no hay página de precios ni botón "solicitar demo". `Terminos.tsx` dice que
  las condiciones comerciales *"se acuerdan directamente con el equipo de atiende.ai al momento
  de contratar"*. El único CTA de demo real está en el correo de prospección: *"Agendar una demo
  de 15 minutos"*.
- **Widget de demo de WhatsApp** (`src/components/WidgetWhatsApp.tsx`): burbuja flotante
  ("Iniciar chat") que conecta con el agente real de producción (no un mockup) vía Edge Function
  `whatsapp-widget-chat`. Texto: *"Escríbele al agente de WhatsApp de {restaurante} — puede tomar
  tu pedido real de principio a fin, igual que si mandaras un WhatsApp de verdad."*
- **Páginas legales** (completas, útiles como base):
  - `src/pages/Terminos.tsx` — 15 secciones (qué es el servicio, cuentas y acceso, cómo decide el
    agente de IA, uso aceptable, suscripción y pagos, terceros —cita Twilio/ElevenLabs/
    OpenRouter/OpenAI/Google/Supabase/Vercel—, disponibilidad, propiedad de datos, propiedad
    intelectual, límite de responsabilidad, vigencia, cambios, ley aplicable México, contacto).
  - `src/pages/Privacidad.tsx` — 9 secciones (responsable/encargado dual: atiende.ai para staff,
    restaurante para clientes finales; datos recabados incluyendo transcripciones/grabaciones de
    voz; con quién se comparte; retención; derechos ARCO bajo LFPDPPP; borrado; contacto).
  - `src/pages/legal/LegalPage.tsx` — layout compartido reutilizable (`LegalPage`, `FaltaDato`,
    tipo `SeccionLegal`); patrón de honestidad `FaltaDato` para marcar campos legales aún sin
    completar (razón social, domicilio fiscal) en vez de inventarlos.
- **SEO**: `index.html` con meta description/author/Open Graph, y **`<meta name="robots"
  content="noindex, nofollow">` explícito a propósito** (comentario: *"Esto es el software [...]
  no una landing pública. Se le pide a los buscadores que no lo indexen a propósito"*).
  `public/robots.txt`: `Disallow: /` para todos. Sin `sitemap.xml`.
- **Analítica**: ninguna (sin GA/Plausible/PostHog/Segment/Mixpanel) — coherente con ser panel
  interno no indexado.
- **Contacto público**: no existe formulario tradicional. Lo más cercano son las
  `callback_requests` (`supabase/migrations/20260903010000_callback_requests.sql`), que registran
  cuando un cliente pide que le regresen la llamada durante una conversación con el agente de
  voz/WhatsApp — no un formulario web de ventas.

### 4.2 Likida

- **No hay landing en el repo**: `src/app/page.tsx` es una puerta de redirect (`/login` sin
  sesión; dashboard/admin con sesión). La landing comercial vive en `likida.ai` (sitio estático
  fuera de ambos repos). Solo quedan en `app.likida.ai` las piezas públicas que necesitan backend.
- **Páginas públicas con backend**:

  | Ruta | Archivo | Función |
  |---|---|---|
  | `/calculadora` | `src/app/calculadora/page.tsx` (+`calc.tsx`, `pulso.tsx`) | Lead magnet: calculadora fiscal |
  | `/demo` | `src/app/demo/page.tsx` | Simulador interactivo de chat WhatsApp |
  | `/blog` | `src/app/blog/page.tsx` | Índice de artículos |
  | `/blog/[slug]` | `src/app/blog/[slug]/page.tsx` | Artículo individual |
  | `/seguridad` | `src/app/seguridad/page.tsx` | Página de confianza/seguridad |
  | `/privacidad` | `src/app/privacidad/page.tsx` | Política de privacidad |
  | `/terminos` | `src/app/terminos/page.tsx` | Términos de servicio |
  | `/aviso/[tenant]` | `src/app/aviso/[tenant]/page.tsx` | Aviso LFPDPPP por flota cliente (no indexable) |
  | `/aviso/prospectos` | `src/app/aviso/prospectos/page.tsx` | Aviso LFPDPPP para contactos comerciales |

  Layout legal compartido: `src/app/legal/marco.tsx` (`PaginaLegal`).

- **Textos clave**:
  - Calculadora: *"Calculadora de recuperación fiscal"*, H1 *"Likida"*, *"Tres datos que tu flota
    sí tiene a la mano. El resultado sale aquí mismo, con cada supuesto junto a su cifra y la
    advertencia que casi todos omiten. Sin RFC, sin registro."*; botón *"Calcular con mis
    números"*; CTA *"¿Quieres tu copia y que la revisemos contigo? Nada de secuencias infinitas:
    máximo tres toques."*; botón *"Quiero mi copia"*; éxito *"Listo. Te buscamos hoy mismo con tu
    estimación y la fecha de la cuota usada. Gracias."*
  - Demo: H1 *"Demo — Likida por WhatsApp"*, *"Simula al operador mandando sus comprobantes. El
    cuadre es real."*; mensaje del bot *"¡Hola! Soy Likida. Ya casi cierras tu viaje Silao →
    Laredo (anticipo $10,600). Mándame las fotos de tus comprobantes."*
  - Blog: *"Fiscal de transporte sin inflar cifras. Cada pieza cita su fundamento; lo que el
    corpus no cubre, se manda al contador."* (títulos de ejemplo sobre casetas, diésel, Carta
    Porte).
  - Seguridad: H1 *"Los datos de tu flota, tratados como dinero — porque lo son"*; bloques *"Cada
    flota vive aislada"*, *"La IA no decide sobre tus datos"*, *"Un efecto, una sola vez"*, *"Los
    datos personales, con base legal"*, *"Lo fiscal, bajo candado"*, *"Tus credenciales, cifradas
    y de ida"*, *"Verificado, no supuesto"*.
- **Precios y demo**: **no existe página de precios**. `terminos/page.tsx` dice explícitamente:
  *"🔴 Precios, periodicidad y condiciones de pago: pendientes de definir. Esta sección se
  completa cuando exista la lista de precios vigente. Hasta entonces, lo que rige es lo pactado
  por escrito en cada caso."* `/demo` **no captura leads** — es un simulador puro
  (`POST /api/demo`, sin sesión/DB/LLM, corre el motor de cuadre real sobre datos sintéticos, con
  rate-limit 30/min y tope de 64KB).
- **Páginas legales**: `/privacidad` (título "Política de privacidad", secciones responsable,
  datos tratados, finalidad, con quién se comparte, plazo de conservación, derechos ARCO, cómo
  borrar cuenta, cambios a la política); `/terminos` (21 secciones, incluyendo *"7. Inteligencia
  artificial: qué decide el modelo y qué no"* y *"16. Naturaleza fiscal de lo que Likida
  entrega"*); `/aviso/[tenant]` (aviso LFPDPPP de cada flota hacia sus operadores, `robots:
  {index:false}`); `/aviso/prospectos` (aviso para contactos comerciales).
- **SEO**: `src/app/robots.ts` — `allow:['/blog','/calculadora','/privacidad','/terminos',
  '/aviso/prospectos']`, `disallow:['/admin','/dashboard','/api','/login','/auth','/cuenta',
  '/vendedor']`. `src/app/sitemap.ts` — solo `/blog`, `/calculadora` y cada artículo.
  `src/app/layout.tsx` — `title:"Likida — Liquidación de viajes"`,
  `description:"Automatiza el cierre diario de operaciones logísticas por WhatsApp."`; Open Graph
  dinámico solo en artículos de blog.
- **Analítica propia, sin PII**: `src/app/calculadora/pulso.tsx` (`PulsoSitio`) hace
  `fetch('/api/marketing/evento',{keepalive:true})` con `{pagina, evento:'pageview'}` — sin
  IP/UA/cookies — a la tabla `sitio_evento`
  (`src/app/api/marketing/evento/route.ts`), con lista blanca cerrada de páginas. **Sin
  GA/GTM/Meta Pixel/PostHog/Plausible.**
- **Formularios de contacto/lead** (ambos a tabla `prospecto`):
  - `src/app/api/lead/route.ts` — para el formulario de la landing externa `likida.ai` (CORS
    cerrado a ese dominio), captura empresa/nombre/correo/whatsapp/unidades/urgencia + atribución
    UTM/fbclid/gclid, con deduplicación que solo rellena huecos.
  - `src/app/api/marketing/prospecto/route.ts` — para el formulario dentro de `/calculadora`, con
    honeypot, rate-limit 5/10min, y alerta inmediata al operador vía `alertarOperador`.
  - Consumidor interno: `src/app/vendedor/` (CRM kanban con sesión).
- **Blog sin CMS**: artículos hardcodeados en `src/lib/likida/marketing/articulos.ts` (array
  tipado `ARTICULOS`); flujo editorial: agente IA redacta a cola de aprobación → humano aprueba →
  publicación real vía PR que edita el archivo (nunca INSERT directo a producción).

### 4.3 Conclusión combinada

Ninguno de los dos repos tiene una landing tradicional dentro del repositorio de la app — ambos
la separan del software (panel/dashboard). Sin embargo Likida sí modela, dentro de su repo,
piezas públicas con backend real y útiles de imitar: una calculadora/lead-magnet, un simulador de
demo sin capturar datos, un blog editorial sin CMS, página de "seguridad/confianza", y avisos
legales LFPDPPP diferenciados por audiencia (cliente final vs. prospecto comercial). Atiende
Restaurantes aporta el patrón de **páginas legales completas y bien estructuradas** con el layout
compartido `LegalPage`/`FaltaDato`, y el widget de WhatsApp como demo interactiva real (no
mockup). Ninguno tiene analítica de terceros con PII — ambos usan analítica propia mínima o
ninguna, lo que encaja directo con REQ-198 (analítica sin PII).

---

## 5. Despliegue

### 5.1 Atiende Restaurantes

- **Sin Dockerfile ni docker-compose** (verificado).
- **Plataforma**: Vercel. `vercel.json`:
  - Base path `/restaurantes/` compartido por Vite (`base:"/restaurantes/"` en `vite.config.ts`)
    y React Router.
  - Headers `Cache-Control: no-cache, no-store, must-revalidate` en `/` y `/restaurantes/:path*`.
  - Redirects: `*.vercel.app` → `https://app.useatiende.ai/:path*` (permanent); rutas legacy
    (`/admin`, `/repartidor`, `/terminos`, `/privacidad`) → equivalentes bajo `/restaurantes`.
  - Rewrites: assets servidos desde raíz aunque la ruta pública sea `/restaurantes/...`;
    catch-all `/restaurantes/:path*` → `/index.html` (SPA).
  - Backend serverless: Supabase Edge Functions (Deno), no funciones Vercel.
- **Dominios de producción** (`docs/deployment-domains.md`): software en
  `https://app.useatiende.ai/restaurantes`; landing pendiente en `https://useatiende.ai`; patrón
  general `useatiende.ai/<solucion>` (landing) y `app.useatiende.ai/<solucion>` (app) para
  futuras verticales — **relevante como convención de dominios para Licitaciones**.
- **Variables de entorno (solo nombres)**:
  - Frontend (`VITE_*`): `VITE_SUPABASE_PROJECT_ID`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
    `VITE_SUPABASE_URL`.
  - Edge Functions (`Deno.env.get`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
    `SUPABASE_ANON_KEY`, `APP_URL`, `ALLOWED_ORIGINS`, `INTERNAL_WEBHOOK_SECRET`,
    `VOICE_TOOL_SECRET`, `RESEND_API_KEY`, `RESEND_FROM`, `OPENROUTER_API_KEY`,
    `OPENROUTER_MODEL`, `OPENROUTER_MODEL_ESCALADO`, `OPENROUTER_MODEL_RESPALDO`.
  - Secretos de WhatsApp/Meta en **Supabase Vault** (no env plano): `WHATSAPP_VERIFY_TOKEN`,
    `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`.
  - CI/GitHub Actions: `ATIENDE_SUPABASE_URL`, `ATIENDE_INTERNAL_WEBHOOK_SECRET`.
- **Migraciones**: `supabase/migrations/`, 45 archivos, patrón `YYYYMMDDHHMMSS_descripcion.sql`;
  arranca con dump inicial, evoluciona a "fundación multitenant"
  (`20260901000000_multitenant_foundation.sql`) y una serie de hardening de seguridad/
  observabilidad (aislamiento de tenant, rate limiting, idempotencia de pedidos, outbox de
  mensajería, DSAR de privacidad, matriz de roles).
- **Healthcheck/observabilidad**: tabla `operational_events` y funciones de snapshot de salud
  (`supabase/migrations/20260904064000_operational_observability.sql`). Runbook
  (`docs/runbooks/operacion.md`) documenta señales mínimas a monitorear (latencia/error por
  función, mensajes WhatsApp envejecidos, outbox `dead`/backlog, rechazos por rate limit,
  retraso de notificaciones), aclarando explícitamente que *"la alerta y el canal on-call todavía
  requieren configuración fuera del repositorio"*.
- **Backups**: sin scripts en el repo; runbook documenta procedimiento *manual* de restauración
  (RPO/RTO **no definidos**), dependiente de copias administradas por Supabase, con pasos de
  verificación (restaurar a proyecto aislado, comparar conteos/invariantes por tenant, nunca
  sobrescribir producción durante el simulacro).
- **CI/CD** (`.github/workflows/`):
  1. `quality.yml` — en PR y push a `main`: job `application` (Node 22 + Deno 2.9.5 → `npm ci
     --ignore-scripts` → `npm audit --omit=dev --audit-level=high` → `npm run quality` [lint +
     typecheck + tests Deno de edge functions + `deno check` + build con presupuesto de bundle]);
     job `database` (Supabase CLI → `supabase start` → `supabase db reset --local --no-seed` →
     `bash supabase/tests/run-local.sh`, pruebas SQL de aislamiento/rate limiting/idempotencia).
     Sin job de deploy explícito — el deploy a Vercel ocurre por integración nativa Git-Vercel.
  2. `messaging-dispatcher.yml` — cron cada 5 minutos, `curl` autenticado (header
     `x-atiende-internal-secret`) al endpoint del dispatcher de outbox, con reintentos de curl y
     `concurrency` para evitar solapamiento.
- **Gate previo a release** (`docs/runbooks/operacion.md`): árbol limpio → `npm ci` → `npm run
  quality` → `supabase db reset --local --no-seed` + `npm run test:db` → escaneo de secretos y
  auditoría de dependencias → validar en staging contratos de proveedores externos → aplicar
  migraciones primero en staging → verificar que el dispatcher de outbox está activo.

### 5.2 Likida

- **Sin Dockerfile ni docker-compose** en ninguno de los dos repos. El único contenedor de todo
  el proyecto es un *service container* efímero de Postgres en CI
  (`.github/workflows/ci-postgres.yml`). Despliegue 100% Vercel, sin contenerización propia.
- **`vercel.json`** (raíz): patrón *"build opt-in"* — `ignoreCommand` solo construye si el
  asunto del commit contiene `[deploy]` (ahorro documentado de ~$26/mes en builds
  innecesarios). 11 `crons` hacia `/api/cron/*`: `wa-pendientes`/`wa-outbox` (cada minuto),
  `runner` (c/4h), `escalar` (c/hora), `facturar` (c/15min), `purgar` (diario), `gps`/
  `asistencia` (c/5min), `descarga-sat` (c/6h), `jornada` (c/hora), `portales-vivos` (semanal).
- **Variables de entorno (solo nombres, agrupadas, 104 en total en `.env.example`)**:
  - Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
    `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_AUTH_HOOK_SECRET`, `AUTH_CORREO_CADUCIDAD_MIN`.
  - WhatsApp/Meta: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN`,
    `WHATSAPP_APP_SECRET`.
  - IA/LLM: `OPENROUTER_API_KEY`, `LLM_RAZONAMIENTO_OCR`.
  - App/legal: `NEXT_PUBLIC_APP_URL`, `LEGAL_ENTITY_NAME`, `LEGAL_ENTITY_ADDRESS`,
    `LEGAL_JURISDICTION`, `LEGAL_CONTACT_EMAIL`, `LEGAL_DPA_VERSION`, `LEGAL_SLA_VERSION`,
    `LEGAL_ENFORCE_PRODUCTION`, `LEGAL_ENFORCE_DOCS`, `DEMO_TENANT_ID`.
  - Observabilidad: `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`, `ALERTA_EMAIL`.
  - Correo: `RESEND_API_KEY`, `RESEND_EMAIL_DOMAIN`, `RESEND_WEBHOOK_SECRET`,
    `RESEND_EVENTOS_WEBHOOK_SECRET`.
  - Pagos: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
  - Colas (Upstash): `UPSTASH_QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`,
    `QSTASH_NEXT_SIGNING_KEY`, `QSTASH_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
  - Secretos internos: `LIKIDA_COFRE_LLAVE`, `LIKIDA_FLOTA_COOKIE_LLAVE`, `LIKIDA_BAJA_SECRET`.
  - CRM/otros: `CALCOM_API_URL`, `CALCOM_API_KEY`, `CALCOM_WEBHOOK_SECRET`, `META_ADS_TOKEN`,
    `GITHUB_TOKEN`. Cron: `CRON_SECRET`. (Se omiten variables de facturación/CFDI/portales
    fiscales mexicanos por no ser relevantes a Licitaciones.)
- **Migraciones**: `supabase/migrations/`, **255 archivos** numerados 0001-0274 (con huecos).
  Núcleo inicial (tenant, RLS, storage) → hardening de negocio (roles, CRM, cobranza,
  SaaS/Stripe) → escala (índices, agentes IA, chat) → integridad fiscal/RPCs atómicas → módulo de
  agentes → OAuth MCP, ARCO/privacidad, eventos de producto. **Patrón reutilizable**: aislamiento
  multi-tenant estricto vía RLS desde la primera migración, migraciones pequeñas e incrementales
  con nombres descriptivos en español, y batería de pruebas de aislamiento
  (`supabase/verificaciones.sql`, ~88 bloques de ataques de aislamiento) corrida en CI sobre base
  virgen.
- **Healthcheck**: `src/app/api/health/route.ts` — endpoint público sin auth, rate-limit 30/min.
  Verifica DB (`count head` sobre `tenant`) y latidos de crons (`cron_latido`); devuelve
  `ok|degraded|config_ausente|unknown`; status 200 solo si todo ok, 503 en cualquier otro caso;
  cuerpo `{ok, status, checks:{db,crons}, version (SHA corto de Vercel), hora}`, sin datos de
  negocio. Consumido por un workflow de salud programado.
- **Backups**: sistema **manual/documentado**, no administrado (plan Supabase FREE, sin PITR).
  Tres scripts en `scripts/`: `respaldo.sh` (dump vía `supabase db dump`), `respaldo-storage.sh`
  (backup verificable de Storage con manifiesto SHA-256, sync opcional a S3/R2),
  `restore-storage-drill.sh` (dry-run por defecto). Documentación de RPO/RTO en
  `docs/operacion/RESILIENCIA-DEPLOY.md` (DB: RPO 24h/RTO 4h). El workflow de backup automático
  (`.github/workflows/backup-storage.yml`) está **apagado a propósito** (solo manual) hasta
  configurar secretos/bucket remoto — patrón documentado de "tubería lista pero no activada".
- **CI/CD** (`.github/workflows/`, 9 workflows):
  1. `ci.yml` — npm audit, typecheck, lint, tests, build con placeholders, smoke Playwright.
  2. `ci-postgres.yml` — Postgres efímero, aplica las 255 migraciones sobre base virgen, corre
     pgTAP + batería de aislamiento multi-tenant.
  3. `codeql.yml` — SAST manual, con preflight que verifica que Advanced Security esté habilitado.
  4. `e2e-navegador.yml` — Supabase local completo + Playwright (login, dashboards por rol, rutas
     admin bloqueadas).
  5. `salud-produccion.yml` — cron cada 30min consumiendo `/api/health`, valida que el SHA de
     deploy coincida tras un push `[deploy]`.
  6. `backup-storage.yml` — schedule apagado, solo manual.
  7. `deploy-preview-promote.yml` — pipeline manual: preview de Vercel → smoke → migraciones con
     dry-run → promoción, exige escribir literalmente `APPLY_MIGRATIONS_AND_PROMOTE`.
  8. `rollback-production.yml` — manual, exige URL explícita y escribir `ROLLBACK_PRODUCTION`.
  9. `auto-merge-rutina.yml` — squash-merge automático solo si todos los checks pasan, solo en
     ramas `mejora/*`, solo si no es un fork.
  - **Nota de gobierno documentada** (`.github/workflows/NOTAS-SEGURIDAD.md`): la protección de
    rama `master` **no existe hoy** por limitación de plan de GitHub — riesgo a resolver desde el
    día 1 en un proyecto nuevo.
- **Seguridad en `next.config.ts`**: `outputFileTracingExcludes` — patrón **muy reutilizable**:
  excluye explícitamente `.env*`, `**/*.md`, `docs/**`, `supabase/**`, `scripts/**` y código
  fuente sin compilar del bundle de funciones serverless, tras un incidente real donde 348
  archivos ajenos (incluido `.env.local` con secretos) se colaron a una función por lectura de
  `process.cwd()`. Headers de seguridad limitados a `/api/:path*` (CSP restrictiva
  `default-src 'none'`, X-Frame-Options DENY, HSTS); la CSP de páginas HTML vive aparte en
  `src/proxy.ts` (middleware de Next 16, excluye `/api` de su matcher) — patrón de separar CSP de
  API vs. páginas para evitar cabeceras `Content-Security-Policy` duplicadas que se intersectan
  de forma impredecible.

### 5.3 Conclusión combinada

Ninguno de los dos repos usa Docker en absoluto — ambos despliegan **serverless en Vercel** con
backend en Supabase (Edge Functions Deno en Restaurantes; Route Handlers de Next.js + Postgres
RPCs en Likida). Ambos evitan builds/costos innecesarios (Restaurantes con
`Cache-Control: no-cache` explícito documentado como decisión; Likida con el patrón `[deploy]` en
el commit). Ambos documentan backups **manuales**, sin automatización real en producción, con
RPO/RTO declarados solo en Likida. Likida aporta patrones más maduros y directamente aplicables:
`/api/health` con contrato claro, `outputFileTracingExcludes` de higiene de secretos, pipeline
manual de promoción/rollback con confirmación textual explícita, y la nota de gobierno sobre
protección de rama. **Como Atiende Licitaciones sí requiere Docker/compose (REQ-199/REQ-200,
a diferencia de ambas referencias)**, no hay patrón que copiar literal de ninguno de los dos
repos para esa pieza — deberá construirse desde cero, tomando de Likida el contrato de
healthcheck y el runbook de despliegue, y de Restaurantes el catálogo explícito de variables por
servicio.

---

## 6. Plan de adaptación a Licitaciones

### 6.1 Qué reproducir tal cual (estructura y estilo)

- **Auth**: Supabase Auth + `signInWithOAuth({provider:'google'})` junto a un método sin
  contraseña por email, nunca reemplazándolo — botón **"Continuar con Google"** + separador
  **"o"** + **"Continuar con correo"**, una sola ruta de callback compartida
  (`/auth/callback`), sin crear tenant automáticamente vía Google (alta de organización queda
  ligada al registro por email o al provisioning por admin, igual que ambos repos).
- **Compuerta de seguridad tipo Likida**: si Google produce una sesión sin fila de negocio
  (usuario/organización), redirigir a una pantalla `/sin-acceso` explícita en vez de dejar pasar
  con rol vacío — esto ya está capturado en REQ-179/REQ-180.
- **Motor de plantillas de correo**: HTML plano con tablas de 600px y CSS inline (nunca depender
  de que el cliente cargue `<style>` externo), wordmark de texto o logo `cid:` inline (nunca URL
  externa), un "contrato" tipado único (`asunto, preheader, titulo, parrafos, datos, boton, nota,
  porQueLoRecibes, bajaHref`) del que cuelgan todas las plantillas — igual que
  `packages/mail/src/templates` ya scaffoldeado en este monorepo
  (`/Users/javiercamaraportepetit/Documents/Codex/atiende-licitaciones-staging/packages/mail`,
  con `@react-email/components` + `nodemailer`, catálogo vacío en `src/templates/catalog/` listo
  para poblarse).
- **Outbox transaccional + webhooks + supresión**: combinar el patrón de outbox con
  reintento/backoff de Atiende Restaurantes (`messaging_outbox`, `claim_..._batch`,
  `complete_...`) con los webhooks de entrega/bounce y la lista de supresión de Likida
  (`correo_suprimido`, `POST /api/correo/eventos` con firma HMAC) — esto ya es exactamente
  REQ-188/REQ-189/REQ-190.
- **Estados vacíos honestos**: nunca inventar cifras ni datos — cada módulo vacío explica cuándo y
  cómo aparecerá información real, con una acción concreta sugerida (REQ-193). Reproducir
  el patrón `GraficaFantasma`/línea plana en vez de datos falsos donde haya gráficas.
  Componente compartido tipo `EstadoVacio` de Likida.
  (`src/app/admin/ui/kit.tsx`).
- **Checklist de activación con conteo real**: pasos palomeados por hechos verificables en base de
  datos (nunca un checkbox manual), con CTA a la pantalla correspondiente — patrón "Tu primera
  liquidación" de Likida, adaptado a "Tu primera convocatoria" (ver REQ-192).
  cada paso apuntando a `crear organización → perfil de empresa → invitar equipo → primera
  convocatoria` (REQ-191).
- **Landing separada del panel**: seguir el patrón de ambos repos de mantener la landing pública
  fuera del flujo autenticado, con `robots.txt`/meta `noindex` estrictos en todo lo que sea panel
  (`/admin`, `/dashboard`, `/api`) y solo indexar páginas públicas reales.
- **Páginas legales con layout compartido y marcador de borrador**: reproducir el patrón
  `LegalPage`/`FaltaDato` de Atiende Restaurantes para marcar explícitamente qué campos legales
  (razón social, domicilio) están pendientes de validación jurídica — esto es exactamente
  REQ-195 (`borrador_pendiente_validacion_juridica`).
- **Despliegue serverless + healthcheck con contrato claro**: adoptar el endpoint `/api/health`
  de Likida (`{ok, status, checks, version, hora}`, 200 solo si todo ok) como base del healthcheck
  de REQ-202, y su `outputFileTracingExcludes` de higiene de `.env`/`docs`/`supabase` en el bundle
  serverless.
- **Backups documentados, no automáticos por defecto**: reproducir el patrón de runbook con
  RPO/RTO explícitos (Likida: 24h/4h) y scripts de dump/verificación en `scripts/`, con el
  workflow de automatización presente pero **apagado hasta que el usuario aporte credenciales**
  — igual filosofía que REQ-203 y el bloqueo externo ya declarado en `docs/AMPLIACION-2-SALIDA.md`.

### 6.2 Qué adaptar (no copiar literal)

- **Docker/compose son obligatorios en Licitaciones** (REQ-199/REQ-200) y **ninguno de los dos
  repos de referencia los usa** — construir desde cero, tomando de Likida el contrato de
  `/api/health` para el healthcheck del compose y de Restaurantes el catálogo exhaustivo de
  variables por servicio como plantilla de documentación.
- **Preferencias de notificación**: Restaurantes las modela por tenant/restaurante; Licitaciones
  necesita preferencias **por usuario individual** dentro de una organización (más cerca del
  modelo de Likida por agente/evento/rol) — adaptar la pantalla de `seccion-notificaciones.tsx`
  a nivel de miembro de organización, no de tenant completo.
  necesita preferencias **por usuario**, no por tenant completo.
- **Tono y dominio de las plantillas**: cambiar "pedidos"/"flota" por "convocatorias"/
  "expediente"/"organización"; el wordmark y paleta deben ser los de **Atiende** (azul/celeste
  documentado en `docs/investigacion/frontend-restaurantes.md`), nunca el naranja de marketing ni
  el negro/blanco de Likida.
- **Onboarding**: ninguno de los dos flujos de referencia encaja tal cual — Restaurantes no tiene
  self-signup y Likida usa entrevista conversacional de 24 preguntas fiscales/logísticas, que no
  aplican a licitaciones. Adaptar la **mecánica** (compuerta mínima + checklist con conteo real)
  al **contenido** de REQ-191 (registro → verificación → crear organización → perfil de empresa →
  invitar equipo → primera convocatoria).
- **Analítica**: ambos repos evitan PII; para Licitaciones replicar el patrón de evento propio
  sin terceros (tabla `sitio_evento` de Likida) en vez de integrar Google Analytics/Meta Pixel
  directamente, salvo que el usuario apruebe explícitamente un proveedor de analítica con
  configuración de anonimización — coincide con REQ-198.
- **Autenticación de 2FA/step-up**: ya existe en este monorepo (`apps/api/src/lib/step-up.ts`);
  Google debe integrarse **respetando** ese mecanismo existente (REQ-176), no reemplazarlo —
  ninguno de los dos repos de referencia tiene 2FA, así que este punto no tiene patrón que copiar
  y requiere diseño propio.

### 6.3 Plantillas de correo propuestas para Licitaciones (10, según REQ-181)

Basadas en el motor de plantillas combinado (contrato tipado + outbox + webhooks) y en el tono ya
usado por ambas referencias (directo, en español de México, sin inflar):

| # | Plantilla | Asunto propuesto | Disparador |
|---|---|---|---|
| 1 | Verificación de email | `Confirma tu correo — Atiende Licitaciones` | Registro nuevo por email+contraseña |
| 2 | Invitación a organización | `Te dieron acceso a {organizacion} en Atiende Licitaciones` | Alta de miembro por un admin de la organización |
| 3 | Restablecimiento de contraseña | `Recupera tu acceso a Atiende Licitaciones` | Solicitud de "olvidé mi contraseña" |
| 4 | Código de respaldo / activación 2FA | `Tu código de confirmación — Atiende Licitaciones` | Activación o uso de código de respaldo de 2FA |
| 5 | Alerta de nueva convocatoria / cambio | `Nueva convocatoria: {titulo}` / `Cambio en convocatoria: {titulo}` | Ingesta detecta convocatoria nueva o modificada que matchea criterios guardados |
| 6 | Matching relevante | `{n} convocatoria(s) nueva(s) que coinciden con tu perfil` | Motor de matching encuentra convocatorias por encima de umbral de relevancia |
| 7 | Aprobación pendiente | `Una acción espera tu aprobación en {convocatoria}` | Un paso del expediente requiere validación humana antes de continuar |
| 8 | Paquete listo | `Tu paquete de licitación para {convocatoria} está listo` | Generación del expediente/paquete de entrega finaliza sin errores |
| 9 | Recordatorio / vencimiento post-adjudicación | `Vence en {dias} día(s): {obligacion} de {convocatoria}` | Fecha límite de entrega, garantía o entregable post-adjudicación próxima a vencer |
| 10 | Resumen diario/semanal | `Tu resumen {periodo} de Atiende Licitaciones` | Job programado (diario o semanal, configurable por el usuario) |

Todas comparten estructura: cabecera con wordmark/logo Atiende, tarjeta blanca, etiqueta de estado
con color por severidad, bloque de datos, botón CTA en píldora, nota de seguridad cuando aplique
(enlaces firmados), pie con "por qué te llegó este correo" y enlace de baja/preferencias
(excepto los de seguridad no desactivables, igual que en Likida).

### 6.4 Variables de entorno que el usuario deberá aportar (solo nombres)

**Google OAuth**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (ya declaradas en REQ-178).

**Proveedor de correo** (elegir uno, patrón adaptador único por REQ-182):
`RESEND_API_KEY`, `RESEND_EMAIL_DOMAIN`, `RESEND_WEBHOOK_SECRET` — o los equivalentes de
Postmark/SMTP si se elige otro proveedor. Adicionalmente: `MAIL_FROM_ADDRESS` (remitente),
`MAIL_UNSUBSCRIBE_SIGNING_SECRET` (firma de enlaces de baja, equivalente a `LIKIDA_BAJA_SECRET`).

**Dominio/hosting**: `NEXT_PUBLIC_APP_URL` (o `VITE_APP_URL`/`APP_URL` según el paquete),
`ALLOWED_ORIGINS`, dominio verificado con SPF/DKIM para el proveedor de correo.

**Supabase / base de datos gestionada**: `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_ANON_KEY` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_AUTH_HOOK_SECRET` (si se usa Send Email Hook al estilo Likida para reemplazar las
plantillas nativas de Supabase Auth).

**Legal** (patrón de Likida, útil aunque los textos definitivos dependan de abogado):
`LEGAL_ENTITY_NAME`, `LEGAL_ENTITY_ADDRESS`, `LEGAL_JURISDICTION`, `LEGAL_CONTACT_EMAIL`.

**Observabilidad/alertas** (opcional pero recomendado, patrón de ambos repos):
`SENTRY_DSN`, `ALERTA_EMAIL` (correo interno al que llegan las alertas operativas y las
notificaciones del formulario de contacto, cubriendo REQ-196).

**Backups** (cuando se automaticen, hoy documentados como manuales por REQ-203): credenciales del
bucket remoto de respaldo (S3/R2) si se decide activar el workflow análogo a
`backup-storage.yml` de Likida — hoy deliberadamente apagado hasta tener esas credenciales.

Ninguna de estas variables tiene valor por defecto seguro para producción: como en ambos repos de
referencia, su ausencia debe degradar a modo "captura local"/simulado (REQ-183, REQ-190), nunca
fallar silenciosamente ni bloquear el desarrollo.
