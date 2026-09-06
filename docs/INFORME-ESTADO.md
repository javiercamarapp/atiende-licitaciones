# Informe de estado — Atiende Licitaciones (2026-09-06 05:5x)

Repo: `/Users/javiercamaraportepetit/Documents/Codex/atiende-licitaciones-staging` (staging; ruta definitiva pendiente, B-01). HEAD: ver `git log`. 341 commits. Orquestación Fable; 70 despachos Sonnet con `model="sonnet"` explícito (docs/AGENTES.md).

## Implementado y probado (evidencia en docs/logs y docs/auditoria-*)
- **Monorepo** npm: apps/web, apps/api, apps/worker, packages/db, packages/agents, packages/sources, packages/expediente. CI local completa en verde: 28/28 workspaces + npm audit + check-secrets (docs/logs/ci-local-3.log). Pipeline GitHub Actions escrito (Postgres real, Playwright, audit, secretos) pendiente de remoto (B-03).
- **Base de datos** (packages/db): 52 migraciones idempotentes con checksum; RLS en todas las tablas con org_id; funciones SECURITY DEFINER auditadas por test contra lista blanca; 156 tests; ataques dinámicos: 622/620 + 176/173 + 167/167 tras correcciones; fugas cerradas (DB-01, DB-08 crítica, DB-12).
- **API** (apps/api, Fastify): auth con scrypt, JWT, refresh con rotación atómica y revocación de familia, login en tiempo constante, eventos de auth auditados; organizaciones/invitaciones/roles con protección de owner; Empresa completa con procedencia por campo y tarifas aprobadas; Convocatorias con ingest idempotente, versiones, eventos e invalidación; Matching con relevancia y elegibilidad separadas; Go/No-Go; expediente completo (26 rutas: bases, matriz, propuestas, checklist, aprobación, paquete ZIP draft/ready, declaración de presentación, post-adjudicación con plazo de pago 17 días hábiles y régimen legal); back office superadmin; CSP y cabeceras; rate limit por niveles; 183 tests; auditorías y reverificaciones cerradas (AE-01..15, API-01..15).
- **Worker** (apps/worker): cola con SKIP LOCKED, lease token real, reintentos/dead letter, scheduler con advisory lock, ingesta con estados explícitos de fuente, worker_role con RLS real; 298 tests; 23 hallazgos cerrados.
- **Runtime de agentes** (packages/agents): prohibiciones duras invariantes (nunca enviar, firmar, actuar en portales, contactar terceros), actionKind semántico, no fabricación recursiva, presupuesto/rate limit, router con tolerancia cero; 263 tests; 22/23 hallazgos cerrados, límites AG-05/AG-12 documentados.
- **Motor de expediente** (packages/expediente): matriz con conflictos escalados, datos de empresa nunca inventados, propuesta económica en centavos con cantidad en letra, checklist, aprobaciones con invalidación automática por hash sellado no falsificable, paquete ZIP con hashes de bytes reales; 413 tests; 22/22 cerrados o límite documentado (EX-08/EX-10).
- **Conectores** (packages/sources): ComprasMX/OCDS-SHCP/DOF/PDN/estatales + CSV histórico real en streaming; estados explícitos (nunca "0 nuevas" ante fallo); clasificador de captcha/challenge; versionado con TZ México; 204 tests; SR-01..24 cerrados, SR-25 y descartes cooperativos como límites aceptados.
- **Frontend** (apps/web): paridad visual con Restaurantes verificada por render real; a11y axe 0 violaciones en 48 combinaciones; móvil 320/390; conectado a la API real (sesión, Empresa, Convocatorias, Matching, Go/No-Go, Fuentes y frescura, back office parcial); CSP; 80 unit + 98 E2E contra API real (determinista ×2); paquete "Borrador" por defecto y aviso de que la presentación y firma las realiza el usuario.
- **Legal**: 24 citas verificadas contra fuentes oficiales (LAASSP nueva DOF 16-abr-2025; pago 17 días hábiles; Plataforma Digital de Contrataciones Públicas/SABG; nueva LFPDPPP) — no es asesoría jurídica.

## Tablero de aceptación (docs/TABLERO.md, escala estricta)
186 criterios: **47 CUMPLIDO**, 53 EN_EVIDENCIA, 77 PENDIENTE, 5 LÍMITE_ACEPTADO, 3 NO_APLICA, 1 BLOQUEADO_EXTERNO. Nota de Fable: la fila E11 del tablero dice "0% construido" pero apps/api tiene `post-award.routes.ts`, migración 0032 y tests (`expediente-post-award.test.ts`); se reconciliará en la próxima pasada del tablero.

## Pendiente (ejecutable, ronda 5 en curso)
Conectar en la web el flujo de expediente (bases, cumplimiento, redacción, revisión, entregas, seguimiento) y los paneles restantes de back office; procedencia vinculante (REQ-142); correlation_id extremo a extremo (REQ-171); calendario oficial de inhábiles; 2FA/step-up en aprobaciones económicas; aviso de privacidad; guard 404 de tenant; reconciliación E11.

## Pendiente por bloqueo externo o decisión del usuario
- B-01 ruta definitiva de "empresas agénticas" (no encontrada).
- B-02 acceso a ComprasMX/OCDS-SHCP/PDN/estatales (reCAPTCHA/bot-detection/API no localizable): integraciones reales no marcadas completas.
- B-03 CI con Postgres real requiere remoto GitHub autorizado.
- OpenAI real sin credenciales; validación por abogado del marco legal.
- Por diseño, nunca: envío de ofertas, firma, actuación en portales, contacto con terceros.

## No construido (declarado)
OCR real; firma electrónica; WhatsApp/voz; pgvector; capa LLM del guardrail anticolusión.

## Incidentes
INC-01..09 en docs/BLOQUEOS.md (concurrencia git, límites de sesión/servidor 429, duplicados obsoletos). Sin pérdida de contenido verificada en todos.
