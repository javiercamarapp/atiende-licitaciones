# Paridad de producto: Atiende Restaurantes / Likida vs. Atiende Licitaciones

Investigación de solo lectura. Fuentes: inventario de código de `/Users/javiercamaraportepetit/Documents/Codex/atiende-restaurantes` (Vite+React+Supabase), `/Users/javiercamaraportepetit/Documents/Codex/2026-08-30/haz-x20/work/repo` (Likida, Next.js App Router + Supabase), y el propio repo `atiende-licitaciones-staging` (`apps/web/src/config/navigation.ts`, `apps/{api,web,worker}`, `packages/{agents,db,expediente,sources}`, `docs/TABLERO.md`, commit `071263a`, ronda 5, 2026-09-06). Todas las rutas citadas son relativas a la raíz de cada repo respectivo. No se abrieron ni copiaron `.env`, claves ni `.git`.

Nota de encuadre: Restaurantes y Likida son SaaS de consumo/PYME con landing, precios, checkout y trial. Licitaciones es hoy un back office B2B interno (sin landing ni checkout) para gestión de licitaciones públicas. La matriz de brechas no asume que todo lo "comercial" de los otros dos deba copiarse literal — para cada fila se razona la acción propuesta.

---

## 1. Mapa de rutas/pantallas por producto

### 1.1 Atiende Restaurantes (`atiende-restaurantes`)
Router en `src/App.tsx` (React Router 7, `basename="/restaurantes"`), todo lazy-loaded. Solo 8 rutas: `/` (redirect a login), `/admin/login` (login), `/terminos`, `/privacidad` (legal público), `/admin/superadmin` (back office plataforma), `/admin` (panel del tenant, 4378 líneas — núcleo del producto), `/admin/repartidor/:userId`, `/repartidor` (panel de repartidor), `*` 404. **No hay landing comercial, pricing, blog, demo pública ni checkout en este repo** (el storefront de cada negocio vive en otro repo, según su README). Layouts: `AdminSidebar.tsx` (acordeón por grupos + bloque cuenta con botones "Centro de ayuda"/"Mi perfil"/"Plan y facturación" **no funcionales**), `RepartidorSidebar.tsx`, sidebar propio en `SuperAdminDashboard.tsx`. Sin breadcrumbs reales.

### 1.2 Likida (`work/repo`)
Next.js App Router, ~90 rutas reales bajo `src/app`. Públicas: `/`, `/login`, `/auth/callback`, `/demo`, `/calculadora` (lead magnet), `/blog(/[slug])`, `/terminos`, `/privacidad`, `/aviso/[tenant]`, `/seguridad` (página comercial, no panel 2FA), `/sin-acceso`, `/pago/[token]` (portal de cobro a clientes finales), `/mcp/autorizar`. Autenticadas `/dashboard/*` (~50 páginas: viajes, clientes, unidades, operadores, cotizaciones, rentabilidad, despacho, mapa GPS, carta-porte, timbrado, facturación, descarga-SAT, jornada, asistencia, emergencias, agentes especializados, chat, soporte, configuración, mi-perfil, usuarios, suscripción, llaves-api, notificaciones, conexiones, integraciones, onboarding, sesiones-mcp, arco). Superadmin `/admin/*` (~45 páginas: ejecutivo, analítica, crecimiento, marketing, mapa-prospectos, cobranza, costos-facturación, consumo, capacidad-forecast, agentes, corridas, copiloto, conversaciones, playground, model-ops, qa, calidad-evals, evals, observabilidad, salud-sistema, crons, trust-safety, compliance, escalaciones, aprobaciones, dev, vendedores, equipo, flotas, soporte, comunicación, notificaciones, configuración, conocimiento-rag, integraciones, whatsapp-infra, mi-perfil, actividad-código). `/vendedor` (zona comercial). API interna extensa (`src/app/api/*`: cron ×10, webhooks WhatsApp/Stripe/Cal.com/correo, exportaciones, API pública v1 con OpenAPI, MCP/OAuth). **La landing/pricing pública de marketing vive en un repo separado (`likida.ai`), fuera de este código.**

### 1.3 Atiende Licitaciones (estado actual)
`apps/web/src/config/navigation.ts`: 8 grupos, 27 items — Análisis (Panel), Empresa (perfil-capacidades, documentos-vigencias, firmantes-autorizados, tarifas-aprobadas), Convocatorias (descubrimiento, matching, fuentes-frescura), Evaluación (go-no-go, análisis-bases), Preparación (cumplimiento, redacción, revisión, expediente, aprobaciones), Entrega (entregas, paquete-descargable, seguimiento), Back office (organizaciones, usuarios-roles, agentes-herramientas, auditoría, conectores, jobs, costos, incidentes, aprobaciones tool_calls), Configuración (configuración, privacidad). Todos los módulos de dominio están conectados a datos reales excepto **Panel** (`PanelPage.tsx`, usa la fábrica genérica `createModulePage.tsx` — `EmptyState` sin KPIs, REQ-169 pendiente). `Configuración` (`ConfiguracionPage.tsx`) solo tiene 2FA/TOTP — no hay perfil, organización, facturación, notificaciones ni integraciones ahí (gestión de miembros vive aparte en `backoffice/UsuariosRolesPage.tsx`). Auth: solo login por contraseña (`LoginPage.tsx`); sin registro en UI, sin recuperación, sin magic link, sin Google. **No hay landing pública** (`/` redirige a `/panel`), no hay onboarding, no hay soporte/contacto/changelog. Único contenido público: `/privacidad` (borrador sin validar legalmente). `robots.txt` bloquea indexación total (`Disallow: /`).

---

## 2. Funcionalidad transversal — resumen comparativo

| Capacidad | Restaurantes | Likida | Licitaciones |
|---|---|---|---|
| Password + recuperación | No (solo magic link/Google) | No (solo magic link/Google) | Sí, sin recuperación de contraseña |
| Google OAuth | Sí (`AdminLogin.tsx`) | Sí (`login/page.tsx`) | No |
| Magic link | Sí | Sí + reenvío (`auth/reenvio_enlace.ts`) | No (retirado a propósito) |
| 2FA/step-up | No | Sí, TOTP AAL2 (`lib/auth/mfa.ts`) | Sí, TOTP + step-up (`twofa` module, `StepUpDialog.tsx`) |
| Multi-tenant | Sí (restaurants→branches, RLS) | Sí (tenant→app_user, RLS por tenant) | Sí (organizations, RLS por GUC) |
| Invitaciones | Sí (`crear-cuenta-staff`) | Sí (`lib/auth/invitar.ts`) | Sí (`organizations` module) |
| Roles/permisos | admin/user/repartidor/superadmin, RLS granular | superadmin/flota_admin/contador/operador/encargado | owner/admin/analyst/writer/reviewer/viewer |
| Auditoría visible al usuario | Parcial (observability interno) | Parcial (solo superadmin `/admin/observabilidad`, no en dashboard cliente) | **Sí, visible en backoffice con traza por correlationId** |
| Notificaciones in-app | Sí (`NotificacionesSection.tsx`, leído por usuario) | Sí (duplicado por panel, localStorage) | No |
| Notificaciones por correo | Sí (Resend, `send-order-notification`) | Sí (Resend HTTP directo, `lib/correo`) | No |
| Búsqueda global | No (búsqueda puntual por sección) | No (búsqueda puntual) | No |
| Exportación CSV | Sí (clientes, historial) | Sí (`lib/likida/export.ts`) | No |
| Exportación PDF | Sí (jsPDF, historial, respuesta IA) | Sí (liquidación, informes) | Solo ZIP de expediente, no PDF/CSV genérico |
| Importación de datos | Sí (clientes CSV/XLSX) | Sí (viajes Excel/CSV) | No (solo subir documentos individuales) |
| Archivos/adjuntos | Sí (KB del agente, adjuntos en preguntas) | Sí (comprobantes WhatsApp, storage Supabase) | Sí (disco local, base64 en JSON) |
| Comentarios/menciones | No | No (solo chat de soporte) | Parcial (solo en Revisión de expediente) |
| Actividad reciente (feed) | Parcial (auditoría interna) | Sí (`dashboard/actividad.tsx`) | No |
| Dashboards/KPIs/gráficas | Sí (recharts, KPIs agente voz) | Sí (múltiples paneles, `analytics.ts`) | **No** (Panel es EmptyState) |
| Filtros guardados | No | No | No |
| Paginación | Sí (RPC server-side) | Sí | Parcial (cursor solo en tenders) |
| Accesibilidad | Básica (aria disperso) | Prueba de contraste puntual | Fuerte (axe-core en 17 specs E2E) |
| PWA/móvil | No (responsive, sin manifest) | No (responsive, sin manifest) | Parcial (responsive, sin manifest/SW) |
| i18n | No (todo en español) | No (todo en español) | No (todo en español) |
| Feature flags | No | No (solo kill-switch operativo de agentes) | No |
| Analítica de producto | No | No (tracking propio de eventos comerciales) | No |
| Monitoreo de errores (Sentry) | No | **Sí** (`@sentry/nextjs`) | No |
| Rate limits | Sí (`api_rate_limits` tabla+RPC) | Sí (Upstash Redis) | Sí (`rate-limit-settings.ts`) |
| Webhooks entrantes | Sí (WhatsApp Meta, firma verificada) | Sí (WhatsApp, Stripe, Cal.com, correo) | No |
| API pública/docs | No (solo edge functions internas) | **Sí**, `/v1/*` + OpenAPI público | Parcial (OpenAPI existe pero requiere sesión, no es pública) |
| Agentes/IA nombrados | Sí (voz ElevenLabs + WhatsApp/OpenRouter, con herramientas reales) | Sí (14+ agentes de back office, copiloto, analista, evals LLM-as-judge) | Parcial (motor genérico real en `packages/agents`, sin agentes de negocio nombrados desplegados, sin LLM real en producción) |
| Automatizaciones/jobs visibles | Sí (outbox de mensajería, cron GH Actions) | Sí (runner de agentes, 10 crons Vercel) | Parcial (`discover_tenders` real pero fuentes sin verificar en vivo; `run_agent` es esqueleto) |
| Back office/superadmin | Sí (tenants, KPIs, "ver cuenta"; sin costos IA ni incidentes) | Sí, muy completo (costos IA, SLO, trust&safety, escalaciones) | Sí (organizaciones, agentes/tool_calls, auditoría, conectores, jobs, costos estimados, incidentes) — falta panel de métricas de negocio |

---

## 3. Comercial/salida — resumen comparativo

| Capacidad | Restaurantes | Likida | Licitaciones |
|---|---|---|---|
| Landing pública | No (en repo aparte) | No (en repo aparte, `likida.ai`) | No |
| Precios/planes | No (botón sin lógica) | Sí (`dashboard/suscripcion`, Stripe) | No |
| Trial | No | Implícito vía Stripe | No |
| Checkout/Stripe | No | Sí + alterno "pago por transferencia" | No |
| Facturación | No (solo botón visual) | Sí (planes desde Stripe) | No |
| Términos de servicio | Sí (`/terminos`, con `FaltaDato` explícito) | Sí | No |
| Aviso de privacidad | Sí (`/privacidad`) | Sí (`/privacidad`, `/aviso/[tenant]`, ARCO) | Sí (`/privacidad`, borrador sin validar) |
| Cookies | No | No encontrado explícito | No |
| SEO | Deliberadamente `noindex` | No evaluado en el repo (vive en marketing aparte) | Deliberadamente `Disallow: /` |
| Blog/recursos | No | Sí (`/blog`) | No |
| Demo pública | Widget WhatsApp reutilizable | Sí (`/demo`, datos marcados como inventados) | No |
| Formularios de contacto | No | Sí (`/api/lead`, calculadora) | No |
| Dominio/emails | `app.useatiende.ai` | `app.likida.ai`, Resend | No aplica (sin dominio de marketing) |
| Deploy/CI-CD | Vercel + GH Actions (quality + cron dispatcher) | Vercel + 9 workflows (CI, CodeQL, e2e, rollback, backups, salud-producción) | GH Actions (`quality.yml`: typecheck/lint/test/build, db-postgres, e2e-web, npm-audit, check-secrets); **sin config de despliegue real** (sin Dockerfile/Vercel/Fly/Render) |
| Observabilidad en producción | No (sin Sentry) | Sí (Sentry + alertas) | No |
| Backups | Documentado en runbook, sin automatizar visible | Sí (`backup-storage.yml`, drills de restore) | No encontrado |
| Estado del servicio (status page) | No | Workflow `salud-produccion.yml` (interno, no página pública) | No |

---

## 4. Calidad — resumen comparativo

| Aspecto | Restaurantes | Likida | Licitaciones |
|---|---|---|---|
| Unit/integración | Deno tests en Edge Functions | Vitest, ~2,880 pruebas | Vitest, 1,691 unit/integración |
| Tests de BD | SQL/pgTAP-style en `supabase/tests` | SQL + aislamiento multi-tenant dedicado | Migraciones+RLS reales en CI (`db-postgres` job) |
| E2E navegador | No (solo conversación real por SDK de voz) | Sí, Playwright (`pruebas-navegador`) | Sí, Playwright, **17 specs**, incluye accesibilidad (axe-core) |
| QA de agentes IA | No dedicado | Sí, chaos/fuzzing con oráculos (`scripts/qa-agentes`) | No (agentes sin negocio real desplegado aún) |
| Evals LLM-as-judge | No | Sí (`lib/evals`, banco de casos contables) | No |
| Cobertura con umbrales | No explícito | `@vitest/coverage-v8` | Sí, umbrales ≥85%/≥80% en varios paquetes |
| Auditorías de seguridad documentadas | Sí (`docs/audits`, 9.0/10 "GO condicionado") | Sí (`docs/auditoria-22`, 18 documentos + `docs/escala-50k`) | Implícito en `docs/TABLERO.md`/`ACEPTACION.md` (186 filas, 29% cumplido) |
| CI | GH Actions (quality + cron) | 9 workflows incl. CodeQL SAST | GH Actions con `check-secrets`, `npm-audit`, sin CodeQL |
| Total de pruebas | 58 Deno tests (citado en auditoría) | No cuantificado en el inventario | 1,807 (1,691 + 116 E2E) |

---

## 5. Matriz de brechas y acción propuesta

Leyenda de tamaño: S = ≤2 días, M = 3–10 días, L = >10 días o requiere diseño de producto nuevo. "Bloqueo externo" = requiere credenciales/cuenta de un tercero o decisión de negocio del usuario.

### 5.1 Auth y cuenta
| Capacidad | Restaurantes | Likida | Licitaciones | Acción propuesta | Paquete | Tamaño | Bloqueo externo |
|---|---|---|---|---|---|---|---|
| Recuperación de contraseña | No aplica | No aplica | No | Reproducir (flujo "olvidé mi contraseña" con token de un solo uso) | `apps/api` (auth) + `apps/web` | S | Correo transaccional (ver 5.4) |
| Google OAuth | Sí | Sí | No | Adaptar (opcional, evaluar si el cliente corporativo lo requiere; back office B2B puede preferir SSO empresarial en vez de Google) | `apps/api` (auth) + `apps/web` | M | Credenciales Google OAuth |
| Magic link | Sí | Sí | No (retirado a propósito) | Descartar — decisión de producto ya tomada (login por contraseña + 2FA es más apropiado para un back office regulado con step-up de aprobaciones) | — | — | No |
| Perfil de usuario (nombre, avatar, preferencias) | Parcial | Sí (`mi-perfil`) | No | Reproducir | `apps/web` (nueva página `/cuenta/perfil`) | S | No |
| Sesiones activas/dispositivos | No | Parcial (solo sesiones MCP) | No | Adaptar (listado simple de sesiones + revocar) | `apps/api` (auth) + `apps/web` | M | No |
| SSO/SAML/SCIM empresarial | No | Documentado (`docs/enterprise/sso-scim.md`), no visto implementado en código | No | Adaptar — relevante para clientes corporativos grandes, pero de valor solo tras validar demanda | `apps/api` | L | Proveedor IdP del cliente |

### 5.2 Configuración de cuenta/organización
| Capacidad | Restaurantes | Likida | Licitaciones | Acción propuesta | Paquete | Tamaño | Bloqueo externo |
|---|---|---|---|---|---|---|---|
| Pantalla de perfil de organización (razón social, logo, datos fiscales) | Sí (Sucursales) | Sí (`dashboard/configuracion`) | Parcial (existe "Empresa" con perfil-capacidades, pero no está en "Configuración") | Adaptar — enlazar/renombrar navegación para que sea evidente | `apps/web` | S | No |
| Miembros/roles | Sí | Sí | Sí (`UsuariosRolesPage.tsx`) | Ya cumplido — sin acción | — | — | No |
| Notificaciones (preferencias) | Sí | Sí | No | Reproducir (canal in-app mínimo, ver 5.3) | `apps/web`+`apps/api` | M | No |
| Integraciones (catálogo) | Parcial (agente voz/WhatsApp) | Sí (`dashboard/integraciones`, `conexiones`) | No | Adaptar — catálogo de conectores de fuentes de licitaciones ya existe en backoffice/Conectores; falta vista de "integraciones" orientada a credenciales del cliente (ERP, firma electrónica) | `apps/web`+`apps/api` | M | Depende de integración específica |
| API keys propias del cliente | No | Sí (`llaves-api`) | No | Reproducir si se decide ofrecer API pública a clientes (ver 5.9) | `apps/api`+`apps/web` | M | No |
| Facturación/planes (SaaS) | No (solo botón) | Sí (Stripe) | No | Ver 6.3 (bloqueo comercial) | `apps/api`+`apps/web` | L | **Stripe** |
| Idioma de interfaz | No | No | No | Descartar por ahora — ningún referente lo tiene; no es brecha real | — | — | No |
| Tema claro/oscuro | Sí | Sí | Sí (`ThemeSelector.tsx`) | Ya cumplido | — | — | No |

### 5.3 Notificaciones, búsqueda, datos
| Capacidad | Restaurantes | Likida | Licitaciones | Acción propuesta | Paquete | Tamaño | Bloqueo externo |
|---|---|---|---|---|---|---|---|
| Notificaciones in-app | Sí | Sí | No | Reproducir (tabla `notifications` + campanita en `AppShell`) | `packages/db`+`apps/api`+`apps/web` | M | No |
| Notificaciones por correo (vigencias por vencer, nueva convocatoria elegible, aprobación pendiente) | Sí | Sí | No | Reproducir — alto valor para este dominio (vigencias de documentos, plazos de convocatoria) | `apps/api`+`apps/worker` | M | **Proveedor de correo (Resend/SES/SMTP)** |
| Búsqueda global | No | No | No | Descartar por ahora — ningún referente la tiene; no es brecha respecto a los productos comparados | — | — | No |
| Exportación CSV | Sí | Sí | No | Reproducir (listados de convocatorias, auditoría, organizaciones) | `apps/api`+`apps/web` | S–M | No |
| Exportación PDF genérica (más allá del ZIP de expediente) | Sí | Sí | Parcial | Adaptar (reporte de Go/No-Go, resumen de expediente en PDF además del ZIP) | `packages/expediente`+`apps/api` | M | No |
| Importación de datos (p. ej. catálogo de tarifas, empresas relacionadas) | Sí | Sí | No | Adaptar (importar tarifas aprobadas vía CSV) | `apps/api`+`apps/web` | S | No |
| Comentarios/menciones fuera de Revisión | No | No | Parcial | Descartar ampliar por ahora — ningún referente tiene comentarios transversales | — | — | No |
| Actividad reciente (feed) | Parcial | Sí | No | Reproducir (feed simple en Panel, alimentado por `audit-log` ya existente) | `apps/web` | S | No |
| Dashboard/KPIs reales | Sí | Sí | **No (EmptyState)** | Reproducir — es la brecha más visible (REQ-169 ya identificado en `docs/TABLERO.md`) | `apps/web`+`apps/api` | M | No |
| Filtros guardados | No | No | No | Descartar — no es brecha respecto a referentes | — | — | No |
| Paginación completa (todas las listas, no solo tenders) | Sí | Sí | Parcial | Adaptar (extender cursor/paginación a auditoría, organizaciones, jobs) | `apps/api` | S | No |

### 5.4 Plataforma/observabilidad/seguridad
| Capacidad | Restaurantes | Likida | Licitaciones | Acción propuesta | Paquete | Tamaño | Bloqueo externo |
|---|---|---|---|---|---|---|---|
| Monitoreo de errores (Sentry) | No | Sí | No | Reproducir — brecha clara y barata de cerrar | `apps/web`+`apps/api`+`apps/worker` | S | **Cuenta/DSN de Sentry** |
| Analítica de producto | No | Parcial (tracking propio) | No | Descartar por ahora — ningún referente usa PostHog/GA; valorar tracking propio ligero más adelante | — | — | No (si se hace propio) / **PostHog u otro** (si se adopta SDK) |
| Feature flags | No | No (solo kill-switch) | No | Adaptar (kill-switch simple por agente/conector, patrón de Likida `interruptores.ts`) | `packages/agents`+`apps/worker` | S | No |
| Rate limits | Sí | Sí | Sí | Ya cumplido | — | — | No |
| Webhooks salientes (a integraciones del cliente) | Sí (entrante, WhatsApp) | Sí (entrante+saliente) | No | Adaptar — solo si se decide ofrecer integraciones salientes a ERPs de clientes | `apps/api` | M | Depende del receptor |
| API pública documentada sin sesión (OpenAPI público) | No | Sí | Parcial (existe pero requiere sesión) | Adaptar — publicar spec OpenAPI sin autenticación (solo forma, sin datos), como hace Likida | `apps/api` | S | No |
| PWA/manifest | No | No | No | Descartar — no es brecha respecto a referentes | — | — | No |
| i18n | No | No | No | Descartar — no es brecha respecto a referentes | — | — | No |
| Accesibilidad | Básica | Básica | **Fuerte (ya superior a ambos referentes)** | Ya cumplido / ventaja competitiva — sin acción | — | — | No |
| Backups automatizados con drill de restore | Parcial (runbook manual) | Sí (`backup-storage.yml` + drill) | No encontrado | Reproducir (patrón Likida: workflow de backup + drill periódico) | `packages/db`+CI | M | Almacenamiento de backups (S3/similar) |
| Status page / salud pública | No | Interno (workflow, no público) | No | Descartar por ahora — ningún referente tiene status page pública real | — | — | No |

### 5.5 Agentes de IA y automatización
| Capacidad | Restaurantes | Likida | Licitaciones | Acción propuesta | Paquete | Tamaño | Bloqueo externo |
|---|---|---|---|---|---|---|---|
| Motor de orquestación de agentes | Ad-hoc por función | Ad-hoc por función | **Genérico y robusto ya construido** (`packages/agents`: autorización, guardrails, idempotencia, presupuesto, reintentos, trazas) | Ya cumplido — ventaja arquitectónica sobre ambos referentes | — | — | No |
| Agentes de negocio nombrados y desplegados con LLM real | Sí (voz+WhatsApp con OpenRouter) | Sí (14+ agentes con OpenRouter) | No (motor listo, sin agentes de negocio conectados a LLM real en producción) | Reproducir — conectar 2-3 agentes de mayor valor (p. ej. extracción de requisitos de bases, matching semántico de convocatorias) al motor ya existente | `packages/agents`+`apps/worker` | L | **API key de proveedor LLM (OpenAI/OpenRouter)** |
| Evals LLM-as-judge | No | Sí | No | Adaptar (banco de casos de extracción de bases + juez), siguiendo el patrón de Likida | `packages/agents` | M | Requiere LLM real para correr evals |
| QA de agentes con chaos/fuzzing | No | Sí | No | Adaptar una vez existan agentes de negocio reales | `packages/agents` | M | No (una vez haya agentes reales) |
| Canal WhatsApp/voz | Sí (ambos productos) | Sí (WhatsApp como canal principal) | No | Descartar — no aplica al dominio de licitaciones B2B (flujo es documental/formal, no conversacional con clientes finales); reconsiderar solo si se usa para notificar vigencias por WhatsApp a analistas | — | — | **Meta WhatsApp Business API** si se reconsidera |
| Jobs de negocio visibles/reintentables | Sí | Sí | Parcial (`discover_tenders` real, cola propia en `apps/worker`) | Adaptar — completar `run_agent` (hoy esqueleto) y exponer más detalle en `backoffice/Jobs` | `apps/worker` | M | Depende de fuentes/LLM |
| Integraciones reales de fuentes oficiales (ComprasMX, DOF, portales estatales) | No aplica | No aplica | No (todas `not_configured`, solo CSV histórico verificado) | Bloqueo externo real — reproducir en cuanto se resuelva | `packages/sources` | L | **Credenciales/whitelisting con fuentes oficiales; algunas tienen CAPTCHA/bot-detection (documentado como B-02 en TABLERO.md)** |

### 5.6 Comercial/salida
| Capacidad | Restaurantes | Likida | Licitaciones | Acción propuesta | Paquete | Tamaño | Bloqueo externo |
|---|---|---|---|---|---|---|---|
| Landing pública | En repo aparte | En repo aparte | No | Decisión de negocio — si el modelo comercial es venta directa B2B (no self-serve), puede descartarse dentro de este repo y construirse aparte como en los referentes | Nuevo repo/proyecto de marketing | L | Dominio, copy, decisión comercial del usuario |
| Precios/planes públicos | No | Sí | No | Depende de la decisión anterior — si hay landing, adaptar tabla de precios | Marketing / `apps/api` (planes) | M | Decisión de pricing del usuario |
| Trial | No | Implícito | No | Igual que arriba | `apps/api` | M | Decisión comercial |
| Checkout/Stripe | No | Sí | No | Adaptar si se decide monetizar self-serve; si la venta es por contrato directo, descartar | `apps/api`+`apps/web` | L | **Cuenta Stripe y decisión de modelo de cobro** |
| Facturación recurrente | No | Sí | No | Igual que checkout | `apps/api` | L | **Stripe** |
| Términos de servicio | Sí | Sí | No | Reproducir — brecha legal simple y de bajo costo | `apps/web` | S | Redacción legal del usuario |
| Cookies | No | No visto | No | Descartar — no es brecha respecto a referentes | — | — | No |
| Blog/recursos | No | Sí | No | Descartar por ahora — bajo valor sin landing/SEO activo | — | — | Decisión de marketing |
| Demo pública | Widget reutilizable | Sí, con datos marcados como inventados | No | Adaptar — demo interactiva de solo lectura con datos ficticios de una organización de ejemplo, útil para ventas | `apps/web` | M | No |
| Formularios de contacto/leads | No | Sí | No | Adaptar solo si hay landing/ventas activas | `apps/web`+`apps/api` | S | No |
| Deploy/CI-CD de producción real | Vercel configurado | Vercel + 9 workflows | Solo CI de calidad, **sin despliegue real configurado** | Reproducir — es la brecha operativa más urgente para "salir a producción" | infra/CI | M | **Decisión de proveedor de hosting (Vercel/Fly/Render/VPS) y credenciales** |
| Observabilidad en producción | No | Sí (Sentry+alertas) | No | Ver 5.4 (Sentry) | — | — | Sentry |
| Backups con drill | Parcial | Sí | No | Ver 5.4 | — | — | Almacenamiento externo |
| Status page | No | Interno | No | Descartar | — | — | No |

---

## 6. Orden de rondas propuesto

### 6.1 Rondas reproducibles sin credenciales externas (código, config interna, datos de prueba)
1. **Ronda A — Dashboard/Panel real** (cierra REQ-169, la brecha más visible): KPIs desde `audit-log`/`tenders`/`expediente` ya existentes, sin dependencias externas.
2. **Ronda B — Exportaciones e importaciones genéricas**: CSV en listados (convocatorias, auditoría, organizaciones), PDF de resumen Go/No-Go y expediente, importación CSV de tarifas.
3. **Ronda C — Notificaciones in-app**: tabla `notifications`, campanita en `AppShell`, eventos generados server-side (vigencias por vencer, aprobación pendiente) — sin enviar correo todavía, solo in-app.
4. **Ronda D — Actividad reciente / feed en Panel**: reutiliza `audit-log` ya construido.
5. **Ronda E — Paginación completa y filtros consistentes** en listados que aún no la tienen.
6. **Ronda F — Perfil de usuario y sesiones activas** (sin SSO externo): página `/cuenta/perfil`, listado/revocación de sesiones propias.
7. **Ronda G — Recuperación de contraseña** con token interno (aún sin proveedor de correo real: se puede dejar el token visible en logs de staging o requerir el proveedor de correo antes de exponerlo en producción — ver bloqueo).
8. **Ronda H — Kill-switch/feature flags internos** para agentes y conectores (patrón `interruptores.ts` de Likida, sin SDK externo).
9. **Ronda I — OpenAPI público sin sesión** (solo forma del contrato, sin datos reales).
10. **Ronda J — Backups y drill de restore** usando el almacenamiento que ya se use para Postgres (si es autoalojado) o el mecanismo nativo del proveedor elegido — parcialmente bloqueada si el proveedor de hosting aún no está decidido (ver 6.2).
11. **Ronda K — Completar `run_agent` en `apps/worker`** con lógica real de negocio usando el motor de `packages/agents` (guardrails/idempotencia ya existen) — puede avanzar con un proveedor LLM simulado (`FakeLlmExtractorClient`, ya existente) hasta tener credenciales reales.
12. **Ronda L — Demo interactiva de solo lectura** con datos ficticios de una organización de ejemplo (sin backend nuevo, solo modo "demo" con datos seed).
13. **Ronda M — Términos de servicio** (texto placeholder con `FaltaDato` explícito, siguiendo el patrón honesto de Restaurantes, hasta validación legal real).

### 6.2 Requiere decisión/credenciales del usuario (bloqueos externos)
- **Correo transaccional real** (Resend/SES/SMTP): necesario para notificaciones por correo (5.3), recuperación de contraseña en producción (Ronda G), invitaciones por correo real.
- **Sentry** (cuenta + DSN): monitoreo de errores en los tres apps.
- **Proveedor LLM real** (OpenAI/OpenRouter, presupuesto): para activar agentes de negocio nombrados, evals y QA de agentes con datos reales.
- **Credenciales/whitelisting de fuentes oficiales de licitaciones** (ComprasMX, DOF, portales estatales) — ya documentado como bloqueo B-02 en `docs/TABLERO.md`; algunas fuentes tienen CAPTCHA/bot-detection que puede requerir acuerdo comercial o API oficial, no solo credenciales técnicas.
- **Decisión de modelo comercial**: ¿venta B2B directa (sin landing/checkout, como parece ser hoy) o self-serve SaaS (requiere landing, Stripe, planes, trial)? Esto determina si toda la sección 5.6 (excepto Términos/backups/CI) aplica.
- **Proveedor de hosting de producción** (Vercel/Fly/Render/VPS) y credenciales — hoy no hay ninguna configuración de despliegue real, solo CI de calidad.
- **Google OAuth** (si se decide ofrecerlo) y/o **proveedor SSO/SAML** del cliente corporativo (si se prioriza empresa grande sobre self-serve).
- **Meta WhatsApp Business API** — solo si se reconsidera un canal conversacional (hoy descartado por no encajar en el dominio documental de licitaciones).
- **Firma electrónica real y OCR real** — ya documentados como 0% construido en `docs/TABLERO.md` (por diseño, no forman parte del alcance de "presentación" del producto: nunca se enviará a portal ni se firmará en nombre del cliente).

---

## Fuentes citadas
- `atiende-restaurantes`: `src/App.tsx`, `src/pages/*`, `src/components/admin/*`, `supabase/functions/*`, `supabase/migrations/*`, `docs/audits/*`, `package.json`.
- Likida (`work/repo`): `src/app/**`, `src/lib/**`, `supabase/migrations/*`, `docs/auditoria-22/*`, `docs/escala-50k/*`, `CLAUDE.md`, `package.json`.
- `atiende-licitaciones-staging`: `apps/web/src/config/navigation.ts`, `apps/{web,api,worker}/src/**`, `packages/{agents,db,expediente,sources}/**`, `docs/TABLERO.md`, `docs/ACEPTACION.md`, READMEs de cada app/paquete.
