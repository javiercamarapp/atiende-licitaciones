# Auditoría adversarial final — ronda 5 (flujo completo, 2FA/step-up, back office, post-adjudicación)

Fecha: 2026-09-06. Agente: auditor adversarial final Sonnet, contexto
independiente del proyecto "Atiende Licitaciones". Rol: **SOLO
encuentra** — ningún archivo de `apps/web`, `apps/api`, `packages/*` fue
modificado por este agente. Se ejecutaron comandos reales (tests, builds,
servidores) y se operó la UI real con un navegador real (Chrome vía
`claude-in-chrome`) contra `apps/api` real (PGlite en memoria) sembrada
por el propio `e2e/global-setup.ts`.

**HEAD auditado**: `38a6a3b3b9fd0947fa327c51e1b6d1e128205535`
("docs: despacho auditoría final ronda 5"), tomado en
`git worktree add <scratchpad>/audit-r5-final HEAD`. El repo principal no
se tocó (ver nota de AGENTES.md: el agente #71 de `apps/web` seguía "en
cierre" al despachar esta auditoría; este documento congela su veredicto
en el HEAD de arriba — commits posteriores de #71 no están cubiertos).

**Metodología**: `npm install` limpio en el worktree; reproducción de
`apps/api test` (238 tests) y `apps/web test` (unitario, dos corridas);
`apps/web build`; dos corridas completas de `npm run -w apps/web
test:e2e:full` contra `apps/api` real; además, un entorno manual paralelo
(`apps/api` con `PGlite` en memoria + `apps/web` servido con `vite dev` Y
con `vite preview` sobre el build de producción real, ambos apuntando a
esa API vía el mismo proxy que usa `test:e2e:full`) para operar la UI a
mano con dos actores reales (`admin` con 2FA enrolado por el seed,
`writer` sin 2FA) y capturar peticiones/respuestas reales de red y logs
reales del servidor. Evidencia completa de comandos en
`docs/logs/audit-ronda5-final.log`; capturas en
`docs/auditoria-2/capturas-r5/`.

---

## Resumen ejecutivo

- **apps/api: 238/238 tests verdes** (59 archivos), reproducido limpio.
- **apps/web unitario: 105/105 verdes** en una corrida limpia (sin
  contención de CPU); una primera corrida con el propio auditor
  ejecutando otros procesos en paralelo mostró 3 fallos que
  desaparecieron al aislar la corrida — **flakiness ya documentada por el
  propio README** (contención de CPU, timeout 20s + retry 1), no una
  regresión nueva.
- **`test:e2e:full` NO es determinísticamente verde en este HEAD**: falla
  **2 de 2 corridas**, siempre el mismo test, con el mismo hallazgo axe
  exacto (ver **RF-04**, severidad MEDIA). Esto es una regresión real
  sobre el criterio ya cerrado REQ-065/089 ("suite completa en verde").
- **Flujo de negocio completo verificado en código y en vivo**: A11, A12,
  A14 tienen test E2E nombrado explícito contra `apps/api` real; A13/A15
  quedan cubiertos por la descarga autenticada real y la declaración de
  presentación en el mismo archivo (ver rubro 2).
- **Step-up 2FA correcto donde existe**: `company.rate_approval` y
  `expediente.approval` declaran `orgId`+`purpose` exactos, verificado
  leyendo el código Y en vivo (petición real `POST /auth/2fa/step-up` →
  201 con un código de respaldo real, seguida de `POST
  /company/rates/:id/approve` → 200, logs reales en
  `docs/logs/manual-api.log`).
- **Hallazgo nuevo, el más importante de esta ronda (RF-01, MEDIA-ALTA)**:
  `apps/web` **nunca fue actualizado** para el step-up que R5-11 (commit
  `428797f`, ya en este HEAD) agregó a la aprobación/denegación de
  `tool_calls` — aprobar o denegar desde "Agentes y herramientas" o desde
  "Aprobaciones" (back office, cross-org) **siempre responderá 403** en
  cuanto exista una `tool_call` pendiente real, sin ningún diálogo de
  step-up que lo resuelva.
- **Hallazgo nuevo (RF-02, MEDIA)**: una condición de carrera real y
  reproducible entre dos llamadas independientes a `refreshSession()`
  (una sin mutex, en `AuthProvider.bootstrap()`) puede invalidar una
  sesión válida en una recarga de página — reproducido en vivo, de forma
  intermitente, **tanto en `vite dev` como en el build de producción real
  servido con `vite preview`** (no es un artefacto de React StrictMode).
- **Hallazgo nuevo (RF-03, BAJA)**: el enrolamiento de 2FA no renderiza
  ningún código QR real (solo texto), pese a que la UI y el README dicen
  "escanea el código QR".
- **R5-12 (ya conocido, reconfirmado abierto)**: el comentario de
  `apps/web/src/lib/api/twofa.ts:33-35` sigue describiendo mal el
  comportamiento real de `apps/api` (ver detalle en rubro 3).
- **Seguridad**: CSP real verificada con `curl` sobre un `vite preview`
  real (cabeceras completas); refresh token en `localStorage` (riesgo ya
  documentado, sin mitigación nueva posible sin cambiar el contrato de
  `apps/api`); sin secretos en el bundle de producción (grep limpio);
  `npm audit` reproduce exactamente lo que el README ya explica (5
  vulnerabilidades de herramientas de desarrollo vía `vitest@2.x` de
  otros workspaces, ninguna en el código de producción).
- **Back office y post-adjudicación**: conectados y con datos reales,
  verificado por código y en vivo (jobs con reintentar, auditoría con
  traza por `correlationId`, seguimiento con `calendarNote`/`legalRegime`).

---

## Rubro 1 — Reproducibilidad

| Comando | Resultado | Evidencia |
|---|---|---|
| `npm install` (raíz) | 739 paquetes, sin errores | terminal |
| `npm run -w apps/api test` | **238/238 verdes**, 59 archivos, 69.67s | `docs/logs/audit-ronda5-final-api-test.log` |
| `npm run -w apps/web test` (1a corrida, con el propio auditor corriendo `apps/api` real + `vite dev` + `vite preview` en paralelo) | 3 archivos fallaron (`RevisionPage.test.tsx` A12, `RedaccionPage.test.tsx`, `PaqueteDescargablePage.test.tsx` A14) — **los mismos 3 archivos, aislados y re-corridos sin contención, pasan 7/7** | `docs/logs/audit-ronda5-final-web-unit.log`; reconfirmación aislada en terminal |
| `npm run -w apps/web test` (2a corrida, limpia) | **105/105 verdes**, 29 archivos, 42.43s | `docs/logs/audit-ronda5-final-web-unit2.log` |
| `npm run -w apps/web build` | OK, sin errores | `docs/logs/manual-web-build.log` |
| `npm run -w apps/web test:e2e:full` (corrida 1/2) | **105 passed, 1 failed** | `docs/logs/audit-ronda5-final-e2e-full-run1.log` |
| `npm run -w apps/web test:e2e:full` (corrida 2/2) | **105 passed, 1 failed** — **el mismo test, el mismo hallazgo axe exacto** (mismo `contrastRatio: 1.95`, mismos colores `#444d5a`/`#141e2e`) | `docs/logs/audit-ronda5-final-e2e-full-run2.log` |
| `npm audit --workspace apps/web` | 5 vulnerabilidades (3 moderate, 1 high, 1 critical), idéntico a lo documentado en el README | terminal |

**Veredicto**: `apps/api` y `apps/web` (unit) reproducen limpio.
`test:e2e:full` **NO es determinísticamente verde** — falla de forma
**determinista** (no flaky: 2/2 corridas, mismo test, mismo número) por
un hallazgo axe real. Ver **RF-04**.

---

## Rubro 2 — Flujo completo desde UI con dos roles

`apps/web/e2e/expediente-flujo-completo.spec.ts` (organización C del
seed, dos actores reales `writer`/`admin`) cubre, con nombres de test
explícitos:

| Paso del flujo | Test | Criterio |
|---|---|---|
| Firmante autorizado, tarifa propuesta+aprobada con step-up | `"preparación: admin agrega un firmante..."`, `"...aprueba una tarifa con step-up 2FA..."` | REQ-044/064 |
| Bases → matriz de requisitos (sin OCR) | `"Análisis de bases: sube el documento..."` | REQ-156 |
| **A14** paquete nunca "Listo" incompleto | `'A14: el paquete nunca aparece "Listo" con el expediente todavía incompleto'` | REQ-159/163 |
| Propuesta técnica y económica reales | `"Redacción: genera la propuesta técnica..."`, `"...propuesta económica..."` | REQ-157 |
| Checklist de integridad en verde | `"Cumplimiento documental: ejecuta el checklist..."` | REQ-160 |
| Revisión: writer solicita | `"Revisión: writer solicita revisión..."` | — |
| **A12** writer no puede aprobar (ni ve el botón) | `"A12: el rol writer no puede aprobar el expediente..."` | REQ-062/144 |
| admin aprueba con step-up (actor distinto) | `"admin aprueba el expediente con step-up 2FA..."` | REQ-044/064 |
| Paquete "Listo para presentar" | `'el paquete pasa a "Listo para presentar"...'` | REQ-163 |
| **A13** descarga autenticada real (`.zip`) | `"descarga autenticada del paquete listo"` | REQ-048/159/161/163 |
| **A15** declara presentación, nunca envía/firma | `"declara la presentación del expediente (nunca se envía nada a un portal externo)"` — verifica el texto **"El sistema nunca envía ni firma nada"** visible | REQ-045/046/165 |
| **A11** editar tras aprobar invalida y vuelve a "Borrador" | `'A11: editar una sección tras aprobar invalida...'` | REQ-162 |
| 320×568/390×844 sin scroll horizontal, con datos reales | `"320×568 y 390×844: Análisis de bases y Redacción..."` | REQ-089 |

**Nota sobre `docs/ACEPTACION.md` (no editado por este agente, solo
señalado)**: la fila A13 de ese documento (snapshot pre-ronda-5) dice
"sin cobertura integrada de descarga autenticada real desde `apps/web`" —
**esto ya no es cierto**: el test de arriba SÍ descarga el ZIP real desde
la UI autenticada. Candidato a **CUMPLIDO** (ver tabla del rubro 8).

**Comprobado correcto en vivo** (no solo leyendo el spec): logueado como
`admin` real contra `apps/api` real, propuse y aprobé una tarifa
(`AUD-01`, $9,999.00) con un código de respaldo real, y como `writer`
confirmé que la tabla de tarifas **no muestra ninguna acción
Aprobar/Rechazar** para un rol sin permiso (misma invariante que A12,
aplicada también a Tarifas). Ver `docs/auditoria-2/capturas-r5/`.

**Gap menor no bloqueante**: ningún test de este archivo corre axe sobre
`/entrega/paquete-descargable` ni `/entrega/entregas` con datos reales
cargados (sí lo hace `recorrido.spec.ts` pero con la organización
default, SIN convocatorias). No es un hallazgo nuevo, es una nota de
cobertura.

---

## Rubro 3 — Step-up en UI

**Comprobado correcto (código + red real)**:

- `StepUpDialog.tsx` pide "Código TOTP o de respaldo"; si el usuario no
  tiene 2FA, muestra `EmptyState` + enlace a Configuración (nunca un
  formulario que la API igual rechazaría). Verificado en código y en vivo
  como `writer` (sin 2FA) — nunca llegué a probar el modal antes de
  enrolar porque, correctamente, ninguna pantalla del `writer` ofrece un
  botón de aprobar sin 2FA (la única forma de "provocar" el modal es
  tener el rol correcto, y en ese caso siempre hay 2FA de por medio).
- `TarifasAprobadasPage.tsx` usa `purpose="company.rate_approval"`;
  `RevisionPage.tsx` usa `purpose="expediente.approval"` — coinciden
  EXACTO con los dos únicos `purpose` que `apps/api` exige en esos dos
  endpoints (`lib/step-up.ts`).
- `useVerifyStepUp`/`useVerifyTwoFactorEnrollment` (hooks/useTwoFactor.ts)
  declaran `currentOrgId` (→ `X-Org-Id`) SIEMPRE, nunca lo omiten.
- **Verificado en vivo con petición real** (log del servidor,
  `docs/logs/manual-api.log`): `POST /auth/2fa/step-up` (con `X-Org-Id` y
  `purpose: "company.rate_approval"` en el body) → **201**, seguido
  inmediatamente de `POST /company/rates/:id/approve` (con
  `X-Step-Up: <token>`) → **200**. La tarifa pasó a "Aprobada" en la UI.
- **Enrolamiento real end-to-end**, dos veces: (a) como `writer`, generé
  un secreto TOTP nuevo, confirmé con un código TOTP calculado
  legítimamente (`otplib`, mismo algoritmo que usa el propio
  `e2e/two-factor-helpers.ts`) → "2FA enrolado y verificado"; (b) usé
  luego un **código de respaldo** (de los 10 emitidos) para aprobar la
  tarifa de arriba — ambos caminos (TOTP y respaldo) funcionan de
  extremo a extremo contra `apps/api` real.
- Un `stepUpToken` de un propósito no sirve para otro y una sesión de un
  solo uso no se puede reutilizar — esto **no lo reverifiqué yo mismo**
  en vivo (habría consumido presupuesto de rate-limit real de 2FA/5min,
  compartido con el resto de esta sesión manual), pero SÍ está cubierto
  por `apps/api/test/security-r505-stepup-scope.test.ts` (parte de los
  238 tests verdes reproducidos en el rubro 1) y ya fue reverificado
  adversarialmente en `docs/auditoria-2/api-r5-09-10-reverificacion.md`
  (ataques 3, 4 y 5 del resumen ejecutivo de ese informe).
- **R5-11 desde la API** (aprobar `tool_call` sin step-up → 403; con
  step-up → 200): confirmado por los 238 tests verdes, en particular
  `apps/api/test/security-r511-tool-call-stepup.test.ts` y
  `ronda4-admin-tool-calls.test.ts` (incluye el caso "superadmin sin 2FA
  → 403 con instrucción"). **Desde la UI, sin embargo, esto está roto —
  ver RF-01 abajo.**

### RF-01 (MEDIA-ALTA) — `apps/web` nunca se actualizó para el step-up de `tool_calls` (R5-11)

**Rubro**: 3 (step-up en UI) / 4 (back office).

**Hallazgo**: el commit `428797f` (ya en este HEAD, agente #78) hizo que
`POST /agents/tool-calls/:id/approve|deny` (org-scoped, "Agentes y
herramientas") y `POST /admin/tool-calls/:id/approve|deny` (superadmin
cross-org, "Aprobaciones" del back office) exijan `requireStepUp` con
`purpose: 'tool_call.approval'`/`'admin.action'` respectivamente — exacto
igual patrón que `company.rates`/`expediente.approval`. Pero
`apps/web/src/lib/api/agents.ts` y `apps/web/src/lib/api/admin.ts`
**nunca declaran `stepUpToken`** en esas llamadas:

```ts
// apps/web/src/lib/api/agents.ts
export async function approveToolCall(orgId: string, id: string) {
  return apiRequest<unknown>(`/agents/tool-calls/${id}/approve`, { method: "POST", orgId });
}
```

```ts
// apps/web/src/lib/api/admin.ts
export async function approveAdminToolCall(id: string) {
  return apiRequest<unknown>(`/admin/tool-calls/${id}/approve`, { method: "POST" });
}
```

Ninguna de las dos pasa `{ stepUpToken }`. Los hooks que las consumen
(`useApproveToolCall`/`useDenyToolCall` en `hooks/useAgents.ts`,
`useApproveAdminToolCall`/`useDenyAdminToolCall` usados por
`AprobacionesBackofficePage.tsx`) tampoco muestran ningún
`StepUpDialog`; las páginas (`AgentesHerramientasPage.tsx`,
`AprobacionesBackofficePage.tsx`) llaman `.mutate(id)` directo al hacer
clic en "Aprobar"/"Denegar", sin pedir ningún código.

**Por qué no lo detectó ningún test**: el único test de
`AprobacionesBackofficePage` (`AprobacionesBackofficePage.test.tsx`) usa
MSW, que simula `POST /admin/tool-calls/:id/approve` devolviendo 200
incondicionalmente — nunca comprueba que la petición real llevaría
`X-Step-Up`, y por lo tanto nunca reproduce el 403 real que `apps/api`
ya impone. Ningún test E2E (`test:e2e:full`) toca la pantalla de
"Agentes y herramientas" ni aprueba/deniega una `tool_call` real.

**Impacto real hoy**: `packages/agents`/`apps/api` todavía no tienen un
productor real de `tool_calls` conectado en producción (el propio README
de `apps/api` documenta que el cableado completo de `AgentRunner` con
proveedores LLM queda fuera de esta ronda) — así que hoy la bandeja
normalmente está vacía y el defecto es "latente". Pero en cuanto exista
una `tool_call` pendiente real (o en cualquier prueba manual que la
inserte, como hacen los propios tests de `apps/api`), **aprobar o
denegar desde CUALQUIERA de las dos pantallas de `apps/web` fallará
siempre con 403**, sin ningún mensaje que explique por qué ni ningún
camino para resolverlo desde la UI — el usuario solo verá un error
genérico.

**Reparación (no aplicada por este agente)**: extender
`AgentesHerramientasPage.tsx`/`AprobacionesBackofficePage.tsx` con el
mismo patrón `StepUpDialog` que `TarifasAprobadasPage`/`RevisionPage`
(`purpose="tool_call.approval"`/`"admin.action"`), y declarar
`stepUpToken` en `approveToolCall`/`denyToolCall`/
`approveAdminToolCall`/`denyAdminToolCall`.

### R5-12 (ya conocido, reconfirmado sin corregir)

`apps/web/src/lib/api/twofa.ts:33-35` sigue afirmando que
`/2fa/verify-enrollment` "no fue actualizada para EXIGIRLOS [orgId/purpose]
a nivel de aplicación como sí lo está `/2fa/step-up`" — esto sigue siendo
**incorrecto**: `apps/api/src/modules/twofa/routes.ts` llama
`assertStepUpOrgId`/`assertStepUpPurpose` en ambas rutas por igual (ya
documentado en `docs/auditoria-2/api-r5-09-10-reverificacion.md`, sin
impacto funcional). Sigue sin corregirse en este HEAD. Severidad BAJA
(comentario, no código ejecutable).

### RF-03 (BAJA) — Enrolamiento 2FA sin código QR visual real

**Rubro**: 3.

**Hallazgo**: `ConfiguracionPage.tsx` dice textualmente "Escanea el
código QR con tu app, o captura el secreto manualmente" pero **no
renderiza ningún código QR** (ninguna imagen/canvas/SVG) — solo el
secreto en texto plano y la URL `otpauth://...` como texto. Confirmado en
vivo (ver captura `docs/auditoria-2/capturas-r5/rf03-2fa-sin-qr-visual.jpg`)
y en código: no existe ninguna dependencia de generación de QR en
`apps/web` (`grep -rn qrcode apps/web/package.json apps/web/src` sin
resultados). El propio README de la ronda 5 de `apps/web` también dice
"QR/secreto" dando a entender que existe un QR.

**Impacto**: funcional (todo usuario puede seguir enrolando 2FA copiando
el secreto o la URL a mano en su app de autenticación — confirmado en
vivo, funciona), pero la UI promete una acción ("escanear") que no es
posible, y obliga a copiar manualmente un secreto de 32 caracteres en
cada enrolamiento — fricción real, no solo cosmética.

**Reparación (no aplicada)**: renderizar un QR real (librería ligera
sin dependencias de red, p. ej. generación de SVG a partir del
`otpauthUrl`) o corregir el texto para no prometer un QR inexistente
mientras no se implemente.

---

## Rubro 4 — Back office conectado

**Comprobado correcto** (código + reproducción de los 238 tests de
`apps/api` que los respaldan):

- **Usuarios y roles** (`UsuariosRolesPage.tsx`) sobre `GET
  /organizations/:orgId/memberships` real.
- **Auditoría** (`AuditoriaPage.tsx`) sobre `GET /audit-log` real, con
  filtro por `correlationId` y botón "Ver traza" por fila
  (`aria-label="Ver traza completa de ${entry.correlationId}"`) que
  reconstruye el flujo completo — respaldado por
  `apps/api/test/correlation-id-e2e.test.ts` ("un flujo completo
  (propuesta económica → checklist → aprobación → ensamblado de
  paquete) con el MISMO correlation_id se reconstruye por completo en
  `GET /audit-log?correlationId=`"), parte de los 238 verdes.
- **Conectores/Jobs/Costos/Incidentes**: conectados desde ronda 3, sin
  cambios en esta ronda. `JobsPage.tsx` tiene un botón "Reintentar"
  conectado a `useRetryAdminJob()` real.
- **Aprobaciones cross-org** (`AprobacionesBackofficePage.tsx`) sobre
  `POST /admin/tool-calls/:id/approve|deny` real (ya no de solo lectura,
  desde ronda 4) — **pero ver RF-01**: esta pantalla en concreto es la
  que quedará rota en cuanto exista una `tool_call` real pendiente.
- **Superadmin sin 2FA → 403**: no reproducido por mí en vivo (crear un
  superadmin real requiere insertar directo en `platform_admins`, sin
  ruta HTTP — ver "Limitaciones" abajo), pero confirmado por
  `apps/api/test/ronda4-admin-tool-calls.test.ts` → `"R5-11: un
  superadmin SIN 2FA enrolado recibe 403 con instrucción explícita de
  enrolar, aunque el rol sea correcto"`, parte de los 238 verdes
  reproducidos en el rubro 1.

**Limitación de esta auditoría**: no existe ningún endpoint HTTP para
convertir un usuario en superadmin (`platform_admins` solo se llena por
`INSERT` directo, usado así por los propios tests de `apps/api`) — no
pude verificar "superadmin sin 2FA → 403" clickeando en un navegador real
sin escribir código nuevo contra la base del proceso en memoria (fuera de
mi mandato de "solo encuentra"). Se documenta como límite metodológico,
no como hallazgo.

---

## Rubro 5 — Post-adjudicación desde UI

`SeguimientoPage.tsx` (código revisado, no recorrido en vivo por límite
de tiempo — la organización C del seed no tiene un procedimiento
adjudicado, y crear uno real habría requerido escribir un script de seed
adicional): expone los 5 `kind` (hito, garantía, facturación, pago,
penalización, convenio modificatorio) con sus campos específicos
(`guaranteeType`, `cfdiReference`+fecha de aceptación de factura,
`modificationReference`), y renderiza `calendarNote`/`legalRegime`
(ley, artículo, DOF, días hábiles/naturales, razón) **tal cual los
deriva el servidor** — nunca calculado en el cliente. Una tarjeta de
alertas de vencimiento (`GET /expediente/post-award-alerts`) agrega
across todas las convocatorias de la organización activa (REQ-056).
Comprobado correcto por lectura de código; el mecanismo del servidor
(motor de calendario, `legalRegime`) ya fue reverificado
independientemente en rondas anteriores (`api-ronda5-reverificacion.md`,
R5-01 CERRADO).

---

## Rubro 6 — Honestidad y accesibilidad con datos reales

**Comprobado correcto**:

- Axe corre automáticamente sobre **las ~29 rutas del sidebar
  individualmente** (`recorrido.spec.ts`, un test por `item` de
  `ALL_NAV_ITEMS`, título `"grupo del sidebar: ${item.label} (${item.to})
  carga sin violaciones serious/critical"`) — incluye TODAS las pantallas
  nuevas de ronda 5 (Configuración, Auditoría, Usuarios y roles,
  Aprobaciones back office, Seguimiento, etc.), aunque con datos vacíos
  (organización por defecto sin convocatorias). Con datos reales cargados,
  `expediente-flujo-completo.spec.ts` corre axe además sobre Análisis de
  bases, Redacción (técnica y económica) y Revisión (A12) — y ahí es
  donde aparece **RF-04** (ver abajo).
- 390×844 sin scroll horizontal se verifica sobre **las mismas ~29 rutas**
  (`recorrido.spec.ts`), y 320×568/390×844 se repite con datos reales
  cargados sobre Análisis de bases/Redacción en
  `expediente-flujo-completo.spec.ts`.
- Aviso de presentación por el usuario: verificado en vivo y en código —
  el texto "El sistema nunca envía ni firma nada" es visible antes de
  declarar la presentación (`EntregasPage.tsx`), y el propio test E2E lo
  comprueba.
- Aviso de privacidad marcado como borrador: `GET /legal/privacy-notice`
  devuelve `"status":"borrador_pendiente_validacion_juridica"` real
  (`apps/api/test/legal-privacy-notice.test.ts`, parte de los 238
  verdes) — el contenido real incluye la fecha DOF correcta (20-mar-2025)
  y la SABG como autoridad supervisora.
- Guard 404 de tenant cruzado: el mecanismo (`ResourceNotFoundPage.tsx` +
  `isNotFoundOrForbidden()`) está unit-testeado con MSW
  (`ConvocatoriaDetallePage.test.tsx` → "muestra la página 404 dedicada
  cuando el `tenderId` pertenece a otra organización"), y **el 403/404
  real de `apps/api` para un recurso cruzado SÍ ocurre** (confirmado en
  vivo: `GET /tenders/:id` de una convocatoria de la organización C con
  `X-Org-Id` de la organización A devolvió **404 real**, ver
  `docs/logs/manual-api.log`) — pero no logré confirmar limpiamente en
  vivo que la UI pinta `ResourceNotFoundPage` en ese momento exacto,
  porque la misma recarga de página en la que lo intenté coincidió con
  **RF-02** (la sesión se perdió en la misma navegación). No es un
  hallazgo nuevo de esta sección — es una limitación de mi verificación
  en vivo, con el mecanismo ya cubierto por unit test y el 404 real de la
  API confirmado por separado.

### RF-04 (MEDIA) — `test:e2e:full` falla de forma determinista: violación axe "serious" real, ya "corregida" antes sin éxito

**Rubro**: 1 (reproducibilidad) / 6 (a11y con datos reales).

**Hallazgo**: en **2 de 2** corridas completas de `test:e2e:full`, el
test `"Redacción: genera la propuesta económica con la tarifa aprobada
(sin conceptos bloqueados)"` (`e2e/expediente-flujo-completo.spec.ts:197`)
falla con una violación axe **serious** idéntica en ambas corridas:

```
color-contrast (serious): Element has insufficient color contrast of 1.95
(foreground color: #444d5a, background color: #141e2e, font size: 9.8pt
(13px), font weight: normal). Expected contrast ratio of 4.5:1.
target: .toast > ... > div[data-title=""].!text-foreground
"Propuesta económica generada."
```

El elemento es el **título del toast de éxito de Sonner**
(`components/ui/sonner.tsx`, clase `title: "!text-foreground"`). El
propio código de `sonner.tsx` documenta, en un comentario extenso, que
esta EXACTA cadena de números (**"3.59:1, luego 1.95:1"**) ya fue medida
por axe en intentos ANTERIORES de arreglar este mismo toast, y afirma que
la solución actual (`!important` vía `!text-foreground`) "SÍ gana de
forma determinística" sobre la cascada interna de Sonner. **Mi
reproducción, dos veces, mide exactamente el mismo 1.95:1 que el
comentario atribuye a un intento YA descartado por insuficiente** — es
decir, o el arreglo declarado en el comentario no cubre este toast en
particular (posiblemente por cómo Sonner separa `data-title`/contenido
cuando el mensaje se pasa como JSX en vez de string plano — ver
`RedaccionPage.tsx:216`, el único de los `toast.success(...)` de esa
página que pasa contenido enriquecido en vez de un string simple), o el
fix no se aplica en el tema activo en ese momento del test.

**Por qué es relevante más allá de "un color"**: esto significa que el
criterio ya declarado **CUMPLIDO** en `docs/ACEPTACION.md`
("REQ-065/089: Suite Playwright completa en verde... 98/98 E2E ×2
determinista") **ya no es cierto** con los archivos de ronda 5 incluidos
— la suite completa NO está verde de forma determinista en este HEAD.
No es un flake (ver rubro 1: 2/2 corridas, mismo test, mismo número
exacto) — es una regresión real y reproducible.

**Reparación (no aplicada por este agente; adenda)**: investigar por qué
el toast de "Propuesta económica generada" (a diferencia de "Propuesta
técnica generada" o "Sección actualizada", que sí pasan axe en los mismos
specs) no hereda el mismo contraste ya corregido — candidatos: contenido
JSX vs. string en `toast.success()`, o un tema oscuro activo en ese punto
del recorrido que no estaba activo cuando se verificó el fix original.

**Adenda (post-auditoría, sin re-verificar por este agente)**: mientras
se escribía este documento, `main` avanzó 6 commits sobre el HEAD
auditado (`38a6a3b` → `d966e62`, agente #71 "web ronda 5" cerrando en
paralelo — advertido explícitamente por el encargo de esta auditoría).
El commit `40b3dfe` ("fix(web,e2e): espera la transición del toast antes
de escanear axe") declara una causa raíz DISTINTA a la de este hallazgo:
no un color final insuficiente, sino que Sonner anima su entrada (400ms
`opacity`/`transform`) y `toBeVisible()` no espera a que la transición
CSS termine — axe muestrearía un color MEZCLADO a mitad de esa animación,
un "serious" real pero espurio (el propio commit registra que el color
medido cambiaba entre corridas, pese a que las clases CSS son
deterministas). El fix agrega `page.waitForTimeout(500)` antes de
escanear. **Este agente NO reprodujo `test:e2e:full` contra ese HEAD
posterior** (fuera del HEAD congelado de esta auditoría) — se documenta
la corrección propuesta por honestidad, pero el veredicto de RF-04 para
el HEAD `38a6a3b` (2/2 corridas rojas, deterministas, mismo número exacto
`1.95`) se mantiene sin cambios. Recomendación para el orquestador:
reverificar `test:e2e:full` contra `d966e62` (o el HEAD que corresponda
al cierre real de #71) antes de dar por cerrado RF-04.

---

## Rubro 7 — Seguridad

**Comprobado correcto**:

- **CSP efectiva**: verificada con `curl -sD -` sobre un `vite preview`
  real (build de producción real, no `vite dev`) apuntando a `apps/api`
  real: `Content-Security-Policy` completa (sin `unsafe-inline`/
  `unsafe-eval` en `script-src`), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`
  — coincide exactamente con lo documentado en el README.
- **Sin secretos en el bundle**: `grep -rlE` de patrones de secretos
  (`JWT_SECRET`, `TOTP_ENCRYPTION_KEY`, `PLATFORM_API_KEY`,
  `-----BEGIN`) sobre el `dist/` de producción real → **sin
  coincidencias** en ninguno de los ~67 archivos generados.
- **`npm audit`**: reproduce exactamente el mismo número (5
  vulnerabilidades: 3 moderate, 1 high, 1 critical) y la misma cadena de
  causa (esbuild/vite anidado bajo `vitest@2.x` de otros workspaces, vía
  el peer-dependency de `vitest-axe`) ya documentada en el README —
  confirmado que es una limitación real de `npm` con workspaces
  compartidos, no un defecto nuevo.
- **Refresh token en `localStorage`**: riesgo real y ya documentado
  extensamente (README, `session.ts`) — sin mitigación nueva posible sin
  que `apps/api` emita el refresh token como cookie `httpOnly` (fuera del
  alcance de `apps/web`).

### RF-02 (MEDIA) — Condición de carrera real en la restauración de sesión: dos `refreshSession()` sin mutex compartido pueden invalidar un refresh token válido

**Rubro**: 7 (seguridad/confiabilidad de sesión) / 1 (reproducibilidad).

**Hallazgo**: `apps/web/src/lib/api/client.ts` declara un mutex de módulo
(`refreshInFlight`) para evitar refrescos paralelos, pero **solo lo usa
dentro de `apiRequest`** (el reintento automático tras un 401). La
función exportada `refreshSession()` — la MISMA que
`AuthProvider.bootstrap()` (`hooks/useAuth.tsx:66`) llama **directamente**
al restaurar sesión desde el refresh token guardado — **no pasa por ese
mutex en absoluto**:

```ts
// apps/web/src/lib/api/client.ts
let refreshInFlight: Promise<void> | null = null;
export async function refreshSession(): Promise<void> { /* ...POST /auth/refresh... */ }
export async function apiRequest<T>(...) {
  // ...
  if (!refreshInFlight) {
    refreshInFlight = refreshSession().finally(() => { refreshInFlight = null; });
  }
  await refreshInFlight; // <- SOLO esta ruta usa el mutex
  // ...
}
```

```ts
// apps/web/src/hooks/useAuth.tsx (AuthProvider.bootstrap, useEffect de montaje)
await refreshSession(); // <- llamada DIRECTA, sin mutex
```

`refresh_tokens` es de un solo uso con rotación real (documentado
extensamente en el propio proyecto). Si dos llamadas a `refreshSession()`
se disparan casi al mismo tiempo con el MISMO refresh token (una vía
`apiRequest`'s 401-retry, protegida por el mutex; otra vía
`AuthProvider.bootstrap()`, sin protección), **apps/api responde 200 a
la primera y 401 a la segunda** (confirmado con logs reales del
servidor, ver abajo) — y el `catch` de la llamada perdedora en
`bootstrap()` ejecuta `clearTokens()`, **borrando el token recién
rotado por la llamada ganadora**. El resultado: el usuario aparece
deslogueado (`/login`) pese a tener, momentos antes, un refresh token
perfectamente válido.

**Reproducido en vivo, dos veces, de forma independiente**:

1. En `vite dev` (con React `<StrictMode>` activo en `main.tsx`): tras
   iniciar sesión real, una recarga de página perdió la sesión de forma
   repetida (varias veces seguidas).
2. **Crucial**: reproducido también sobre el **build de producción real**
   servido con `vite preview` (SIN `StrictMode`'s doble-invocación de
   efectos, exclusiva de modo desarrollo) — confirmando que **no es un
   artefacto de React StrictMode**. Log real del servidor
   (`docs/logs/manual-api.log`) muestra, en una sola recarga de página:
   ```
   POST /auth/refresh -> 200
   POST /auth/refresh -> 401   (mismo instante, ~2ms de diferencia)
   ```
   con la UI terminando en `/login` pese a que la sesión era válida
   segundos antes.

El comportamiento es **intermitente** (no cada recarga lo reproduce: de
~6 recargas observadas en el build de producción, 2 mostraron el par
200/401; el resto refrescó limpio con una sola llamada) — consistente
con una carrera genuina dependiente de timing de red, no con un bug
determinista de una sola ruta. No encontré con certeza CUÁL segunda
llamada exacta dispara el par (ninguno de los hooks de dominio
inspeccionados —`useCompany`, `useTwoFactorStatus`— debería disparar una
petición autenticada antes de que `currentOrgId`/`status` lo permitan),
pero el mecanismo de fondo es inequívoco por código: solo existen DOS
sitios en todo `apps/web` que llaman `refreshSession()`
(`grep -rn refreshSession apps/web/src`), y solo uno de los dos está
protegido por el mutex compartido.

**Por qué ningún test existente lo detecta**: ningún test unitario ni E2E
abre dos pestañas ni fuerza dos restauraciones de sesión concurrentes;
`test:e2e:full` usa un login fresco por worker (`e2e/fixtures.ts`), nunca
ejercita la restauración desde `localStorage` bajo carrera. Una
auditoría anterior (`docs/auditoria-2/web-integrado.md`, sección "401→
refresh→reintento") analizó el mutex `refreshInFlight` pero **solo en el
contexto de `apiRequest`**, concluyendo "Comprobado correcto" sin
examinar la llamada directa y desprotegida de `AuthProvider.bootstrap()`
— este hallazgo es nuevo en esta ronda.

**Impacto**: sin fuga de datos ni vulnerabilidad de seguridad (no permite
suplantar a otro usuario ni acceder sin autorización) — es un problema de
**confiabilidad de sesión**: un usuario legítimo puede ser deslogueado
sin motivo aparente, en cualquier despliegue real (no solo en desarrollo),
con más probabilidad cuantas más pestañas del mismo origen tenga abiertas
a la vez (cada `AuthProvider` de cada pestaña mantiene su propio
`refreshInFlight` en memoria de MÓDULO — es decir, ni siquiera dos
pestañas de la MISMA app comparten ese mutex, agravando el riesgo
multi-pestaña específicamente).

**Reparación (no aplicada por este agente)**: enrutar la llamada de
`AuthProvider.bootstrap()` por el MISMO mutex `refreshInFlight` (exportar
una función `refreshSessionOnce()` que internamente lo use, y usarla en
ambos sitios). Para el caso multi-pestaña (mutex en memoria de módulo, no
compartido entre pestañas), esto por sí solo no basta — se necesitaría
además un lock cross-tab (p. ej. Web Locks API `navigator.locks`, o una
bandera en `localStorage` con retry) para eliminar también esa variante
del mismo riesgo.

---

## Rubro 8 — Tabla REQ/A con evidencia integrada (candidatos a CUMPLIDO)

`docs/ACEPTACION.md` es un snapshot pre-ronda-5 (declara HEAD `b362e62`)
y **no fue editado por este agente** (fuera de mandato). Lo siguiente es
evidencia actualizada contra el HEAD real de esta auditoría, para que el
orquestador decida el cierre formal.

| REQ/A | Estado en `ACEPTACION.md` (stale) | Evidencia actualizada (este HEAD) | Candidato |
|---|---|---|---|
| REQ-044/064 (doble confirmación con re-autenticación) | PENDIENTE | `POST /auth/2fa/step-up` real + `X-Step-Up` exigido en `company.rate_approval`/`expediente.approval`; UI conectada y verificada en vivo (código + red real, este documento, rubro 3); 238 tests de `apps/api` incl. `security-r505-stepup-scope.test.ts`, `security-req044-064-step-up-2fa.test.ts` | **CUMPLIDO** (passkey queda fuera, solo TOTP — documentarlo como matiz, no como pendiente) |
| REQ-119 (aviso de privacidad publicado) | PENDIENTE ("ningún aviso propio existe") | `GET /legal/privacy-notice` real, público, versionado, contenido basado en `docs/legal/verificacion-legal.md`, marcado explícitamente "borrador_pendiente_validacion_juridica"; `apps/web` lo consume real en `/privacidad`; `apps/api/test/legal-privacy-notice.test.ts` verde | **CUMPLIDO parcial** — el entregable existe y es honesto sobre su estado, pero sigue **BLOQUEADO_EXTERNO** para el estado "validado" (no hay abogado que lo confirme; el propio contenido lo declara) |
| REQ-131 (aviso actualizado antes de enrutamiento alternativo) | PENDIENTE | Mismo mecanismo que REQ-119 | **EN_EVIDENCIA** (el aviso existe y es versionado; no hay evidencia de un "reporte de transparencia" separado) |
| REQ-142 (dato sin procedencia rechazado/excluido) | PENDIENTE ("solo se registra, no se aplica") | `apps/api/test/security-req142-provenance-binding.test.ts`: capacidad sin `field_provenance` bloquea el requisito en el expediente; documento sin procedencia genera "no_evaluable" explícito en matching — **ya se aplica, no solo se registra** | **CUMPLIDO** |
| REQ-171 (traza por correlation_id extremo a extremo) | PENDIENTE | `apps/api/test/correlation-id-e2e.test.ts`: flujo completo propuesta→checklist→aprobación→paquete reconstruido por un solo `correlationId` vía `GET /audit-log`; `AuditoriaPage.tsx` conecta el filtro + botón "Ver traza" real | **CUMPLIDO** |
| A13 (paquete completo descargable con manifiesto/evidencia/revisión) | EN_EVIDENCIA ("CUMPLIDO a nivel apps/api; UI de descarga sin conectar") | `expediente-flujo-completo.spec.ts` → `"descarga autenticada del paquete listo"`, UI real, `.zip` real descargado autenticado | **CUMPLIDO** (el matiz de "UI sin conectar" ya no aplica) |
| A11, A12, A14, A15 | CUMPLIDO | Reconfirmado con nombres de test explícitos contra `apps/api` real (rubro 2 de este documento) | Se mantiene **CUMPLIDO** |
| REQ-049/065/089 ("suite completa en verde") | CUMPLIDO | **RF-04**: `test:e2e:full` falla determinísticamente 2/2 en este HEAD | **Reabrir a EN_EVIDENCIA** hasta cerrar RF-04 |

---

## Hallazgos — resumen con severidad

| ID | Severidad | Rubro | Resumen | Reparación | Estado reparación |
|---|---|---|---|---|---|
| RF-01 | MEDIA-ALTA | 3/4 | `apps/web` nunca declara `X-Step-Up` al aprobar/denegar `tool_calls` (org-scoped ni cross-org); tras R5-11 esto SIEMPRE fallará 403 en cuanto exista una `tool_call` pendiente real | Agregar `StepUpDialog` (`purpose="tool_call.approval"`/`"admin.action"`) a `AgentesHerramientasPage.tsx`/`AprobacionesBackofficePage.tsx` | **CORREGIDO** (commit `0d4f5cf`). `agents.ts`/`admin.ts` ahora exigen `stepUpToken` y lo declaran en `X-Step-Up`; `StepUpDialog`/`useVerifyStepUp` aceptan un `orgId` explícito para el caso cross-org (atado a la organización DUEÑA de la tool_call, no a la activa del superadmin); ambas páginas abren el diálogo de step-up en vez de mutar directo. Tests unit (MSW) nuevos verifican `X-Org-Id`+`purpose` exacto en `/auth/2fa/step-up`, `X-Step-Up` real en la mutación, el caso cross-org y el mensaje honesto de "sin 2FA" — ver `AgentesHerramientasPage.test.tsx`, `AprobacionesBackofficePage.test.tsx`. **Sin test E2E con una `tool_call` real sembrada vía API**: `apps/api` no expone ninguna ruta HTTP para crear una (solo `INSERT` directo, usado por sus propios tests) y esta corrección tenía prohibido tocar `apps/api` — documentado como límite de alcance en `docs/logs/fix-web-ronda5.log`, pendiente para una ronda que sí incluya `apps/api`. |
| RF-02 | MEDIA | 7/1 | Carrera real entre dos `refreshSession()` (una sin mutex) puede invalidar un refresh token válido en una recarga; reproducido en dev Y en build de producción real, intermitente | Enrutar `AuthProvider.bootstrap()` por el mismo `refreshInFlight`; considerar lock cross-tab para el caso multi-pestaña | **CORREGIDO** (commit `6282988`). `client.ts` agrega `refreshSessionOnce()` como único punto de entrada externo (reusa el refresh en curso); `AuthProvider.bootstrap()` lo usa en vez de llamar a `refreshSession()` directo. Test unitario nuevo dispara bootstrap + una petición 401 concurrente y verifica UNA sola llamada real a `/auth/refresh` — confirmado en ROJO contra el código anterior (2 llamadas reales, `expected 2 to be 1`) y en VERDE con la corrección (ver `useAuth.test.tsx`). Verificación adicional en `vite preview` (build de producción real) + `apps/api` real + navegador real (Playwright/Chromium): 20 recargas de sesión seguidas, 20×200 y 0×401 en `/auth/refresh` — log completo en `docs/logs/fix-web-ronda5.log`. El lock cross-tab (multi-pestaña) queda fuera de esta corrección puntual, documentado en el propio código. |
| RF-03 | BAJA | 3 | Enrolamiento 2FA sin código QR visual real, pese al texto "escanea el código QR" | Renderizar QR real o corregir el texto | **CORREGIDO** (commit `9dc6000`). Se agrega la dependencia `qrcode` (generación 100% en cliente, sin red) y un componente `TotpQrCode` que dibuja el QR real del `otpauthUrl` en un `<canvas role="img" aria-label="...">`; el secreto/URL en texto plano se conservan sin cambios como alternativa accesible. Test unitario verifica que se invoca la generación real con el `otpauthUrl` exacto de `apps/api` (jsdom no implementa `HTMLCanvasElement.getContext`, limitación conocida ya documentada por el ruido de axe-core en esta suite — se usa un spy sobre `QRCode.toCanvas` en vez de depender de un canvas real; la generación visual la cubre `test:e2e:full` con un navegador real). |
| RF-04 | MEDIA | 1/6 | `test:e2e:full` falla determinísticamente (2/2) por una violación axe "serious" de contraste en el toast de "Propuesta económica generada", pese a un fix previo documentado como "determinístico" | Investigar por qué este toast específico no hereda el fix de `!text-foreground` (posible causa: contenido JSX vs. string en `toast.success()`) | **YA CERRADO antes de esta corrección, reverificado** — no reproduce en el HEAD actual (`519d5a4` al iniciar esta corrección). La adenda de este mismo documento ya señalaba que el commit `40b3dfe` ("fix(web,e2e): espera la transición del toast antes de escanear axe", causa raíz real: la animación de entrada de Sonner —400ms `opacity`/`transform`— hacía que axe muestreara un color mezclado a mitad de transición, un "serious" real pero espurio, no un contraste final insuficiente) ya estaba en `main` aunque no en el HEAD congelado de la auditoría (`38a6a3b`). Esta corrección reprodujo `test:e2e:full` 2/2 veces contra el HEAD real de partida: **116 passed, 0 failed** en ambas corridas (ninguna violación axe del toast) — logs completos en `docs/logs/fix-web-ronda5.log`. `docs/ACEPTACION.md` REQ-049/065/089 puede considerarse **CUMPLIDO** de nuevo (no se reabre). |
| R5-12 | BAJA (ya conocido) | 3 | Comentario desactualizado en `twofa.ts:33-35` sobre `/2fa/verify-enrollment` | Corregir el comentario | **FUERA DE ALCANCE de esta corrección** — el encargo (ver cabecera de este documento / TAREA del agente corrector) listó explícitamente RF-01..04, sin incluir R5-12. Sigue sin corregir; el comentario en `apps/web/src/lib/api/twofa.ts:33-35` sigue siendo inexacto (ver detalle arriba). |

## Comprobado correcto (sin hallazgo)

- Aislamiento por `purpose`/`orgId` del step-up, verificado en código y
  con petición real (`company.rate_approval`, `expediente.approval`).
- Enrolamiento 2FA real de extremo a extremo, con TOTP y con código de
  respaldo, contra `apps/api` real.
- Control de acceso por rol en Tarifas (writer no ve Aprobar/Rechazar),
  verificado en vivo.
- A11/A12/A14/A15 con test E2E nombrado explícito contra `apps/api` real.
- Back office (Usuarios/roles, Auditoría con traza, Jobs con reintentar)
  conectado a datos reales.
- Post-adjudicación con `calendarNote`/`legalRegime` derivados por el
  servidor, nunca por el cliente.
- Axe automático sobre las ~29 rutas del sidebar (incl. todas las
  pantallas nuevas de ronda 5) y sobre varias pantallas con datos reales.
- CSP real, sin secretos en el bundle de producción, `npm audit`
  reproducido igual al README (limitación de tooling, no del código de
  producción).
- REQ-142 y REQ-171 ya se aplican de verdad (no solo se registran/existen
  en memoria) — candidatos sólidos a CUMPLIDO.
