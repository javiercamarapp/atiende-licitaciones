# Reverificación adversarial — cierre de ronda 5 (RF-01..04, R5-11, R5-12)

Fecha: 2026-09-06. Agente: reverificador adversarial Sonnet, contexto
independiente del proyecto "Atiende Licitaciones". Rol: **SOLO
encuentra y verifica** — ningún archivo de `apps/web`, `apps/api`,
`packages/*` ni `docs/ACEPTACION.md` fue modificado por este agente.

**HEAD reverificado**: `a62aacf85664c490dd44c57b7044281027fc50e0`
("docs: corrección RF-01..04; despacho reverificación final"), tomado en
dos worktrees separados y desechables (`<scratchpad>/reverify-rf` para
la suite automatizada, `<scratchpad>/reverify-rf-live` para los ataques
manuales en vivo; ambos eliminados al terminar). El repo principal no
se tocó salvo por los dos archivos de esta entrega. **Nota de
concurrencia**: mientras se ejecutaba esta reverificación, `main`
avanzó de `a62aacf` a `18e2d5c` (commits `0a29c10` "fix(web): elimina
el error de canvas del QR de 2FA en jsdom", `e98800c`, `38cb3f7`,
`4ec3a9f`, `59d9786`, `81ac7ca` — trabajo de otro agente sobre
`ci-local`, no relacionado con RF-01..04) — **no cubiertos por este
documento**, igual que la auditoría original advirtió sobre `main`
avanzando en paralelo.

Metodología: reproducción de comandos reales (`apps/api test`,
`apps/web test` ×2, `apps/web build`, `apps/web test:e2e:full` ×2);
además un entorno manual real y aislado (`apps/api` con PGlite real
servida por HTTP, sembrada por HTTP + un único `INSERT` directo para
`tool_calls`/`platform_admins` — igual que hacen los propios tests de
`apps/api`, ver `apps/api/scripts/manual-seed-server.ts`, no
commiteado) + `apps/web` build de producción real servido con
`vite preview` (mismo mecanismo de proxy que `test:e2e:full`), operado
con un navegador Chromium real (`claude-in-chrome`) y con ataques HTTP
directos (`curl`/`fetch`) para las condiciones de carrera y los tokens
cruzados. Evidencia completa de comandos y de la sesión de ataques en
`docs/logs/reverify-ronda5-final.log`.

---

## Resumen ejecutivo

- **Ancestría confirmada**: `a62aacf` contiene, en su historia directa,
  `0d4f5cf` (RF-01), `6282988` (RF-02), `9dc6000` (RF-03), `40b3dfe`
  (RF-04, causa raíz real) y `428797f` (R5-11, `apps/api`) — verificado
  con `git log`/`git show --stat` sobre cada uno.
- **`apps/api`: 238/238 tests verdes**, reproducido limpio (59
  archivos, ~235s).
- **`apps/web` unitario: 114/114 verdes** en una corrida aislada; una
  primera corrida con el propio agente ejecutando en paralelo el build
  y `test:e2e:full` mostró 9 fallos, todos por `Error: Test timed out
  in 20000ms` — el mismo patrón de contención de CPU ya documentado por
  el README, **no una regresión**.
- **`apps/web` build de producción: OK**, sin errores.
- **`test:e2e:full` DETERMINÍSTICAMENTE VERDE, 2/2 corridas**: **116
  passed, 0 failed** en ambas — confirma que **RF-04 sigue cerrado** en
  este HEAD (la "adenda" de `ronda5-final.md` sobre el commit `40b3dfe`
  se reconfirma correcta) y que el criterio REQ-049/065/089 ("suite
  completa en verde") puede mantenerse **CUMPLIDO**.
- **RF-01 verificado end-to-end, en código, por API directa y en vivo
  desde la UI real** (los cuatro escenarios pedidos: sin 2FA → honesto;
  con 2FA → `purpose`/`orgId` correctos; cross-org superadmin →
  `purpose="admin.action"` + `orgId` de la organización DUEÑA; token de
  un propósito reusado en otro → 403). **Sin regresiones.**
- **R5-11 (lado API) reverificado con un ataque de concurrencia real**:
  dos `stepUpToken` válidos y distintos, disparados de verdad en
  paralelo contra la MISMA `tool_call` → **exactamente un 200 y un
  409**, nunca dos 200.
- **RF-02 verificado con 30 recargas reales** de un `vite preview` de
  producción real contra `apps/api` real: **30/30 con una sola llamada
  a `/auth/refresh`, 0×401**. El caso "bootstrap + 401 concurrente" se
  reconfirma con el test determinístico dedicado (`useAuth.test.tsx`,
  parte de los 114 verdes) — forzar la carrera exacta desde fuera del
  proceso ya no es practicable porque la propia corrección serializa
  `bootstrap()` antes de cualquier otra petición autenticada, lo cual es
  en sí mismo una señal de que el fix cerró la ventana de carrera, no
  solo la ocultó. El caso "refresh que falla" se confirma con logout
  limpio de un solo intento, sin bucle.
- **RF-03 verificado con una librería de terceros ajena al proyecto**
  (`jsQR`): el QR real capturado de la pantalla decodifica EXACTO el
  mismo `otpauthUrl` mostrado en texto plano al lado — no es un
  placeholder. El `<canvas>` tiene `role="img"` + `aria-label` real, y
  el secreto/URL en texto siguen presentes como alternativa accesible.
- **RF-04 (contraste del toast) verificado en AMBOS temas** mediante
  los colores computados REALES del navegador sobre las clases exactas
  que usa `sonner.tsx` (`bg-card`/`text-foreground`): **14.88:1 en tema
  oscuro, 17.13:1 en tema claro** — muy por encima del 4.5:1 de WCAG AA
  — consistente con que la causa raíz real era el *timing* del escaneo
  de axe a mitad de la animación de Sonner (commit `40b3dfe`), no un
  color final insuficiente. Ver matiz de cobertura de tema oscuro en el
  rubro 4.
- **R5-12 reconfirmado sin corregir** (severidad BAJA, comentario
  desactualizado en `apps/web/src/lib/api/twofa.ts:33-35`) — no era
  parte del encargo de corrección de RF-01..04 y sigue así.
- **Ningún hallazgo nuevo de severidad relevante** (RF-05+): se
  investigó un 503 anómalo en `POST /auth/logout` observado en el log
  de red del navegador durante los ataques en vivo; descartado como
  artefacto de la instrumentación de red del navegador tras reproducir
  el mismo endpoint, mismo HEAD, con `app.inject` y con HTTP real —
  siempre `204`, incluso con un token inválido (logout es idempotente
  por diseño). Ver rubro 5.

---

## 1. Ancestría y reproducibilidad

### 1.1 `git show --stat` de los commits de reparación (todos dentro de la historia de `a62aacf`)

| Commit | Asunto | Archivos tocados (resumen) |
|---|---|---|
| `0d4f5cf` | RF-01: declara `X-Step-Up` al aprobar/denegar `tool_calls` | `StepUpDialog.tsx`, `useAdmin.ts`, `useAgents.ts`, `useTwoFactor.ts`, `lib/api/admin.ts`, `lib/api/agents.ts`, `AgentesHerramientasPage.tsx(+.test)`, `AprobacionesBackofficePage.tsx(+.test)` |
| `6282988` | RF-02: comparte el mutex de refresh entre bootstrap y el 401-retry | `client.ts` (`refreshSessionOnce()`), `useAuth.tsx`, `useAuth.test.tsx` (nuevo) |
| `9dc6000` | RF-03: renderiza un QR real en el enrolamiento de 2FA | dependencia `qrcode`, `ConfiguracionPage.tsx` (`TotpQrCode`), test unitario nuevo |
| `40b3dfe` | RF-04: espera la transición del toast antes de escanear axe | `expediente-flujo-completo.spec.ts` (+12 líneas, `waitForTimeout(500)`) |
| `428797f` | R5-11 (`apps/api`): exige step-up en aprobación de `tool_calls` | `modules/admin/routes.ts`, `modules/agents/routes.ts`, 4 archivos de test nuevos/ajustados |

Confirmado con `git log a62aacf~7..a62aacf` que los cinco commits están
en la rama directa hacia `a62aacf`, en el orden correcto (R5-11 y
RF-04 anteceden a RF-01/02/03, que a su vez anteceden al cierre
`ec16003`/`9be55d9`/`a62aacf`).

### 1.2 Comandos reproducidos

| Comando | Resultado | Evidencia (log) |
|---|---|---|
| `npm run -w apps/api test` | **238/238 verdes**, 59 archivos, ~235s | sección 1 de `reverify-ronda5-final.log` |
| `npm run -w apps/web test` (corrida 1, con build+e2e del propio agente corriendo en paralelo) | 9/114 fallos, **todos** `Error: Test timed out in 20000ms` | sección 2 |
| `npm run -w apps/web test` (corrida 2, aislada) | **114/114 verdes**, 30 archivos, 40.00s | sección 3 |
| `npm run -w apps/web build` | OK, sin errores | sección 4 |
| `npm run -w apps/web test:e2e:full` (corrida 1/2, `RATE_LIMIT_PROFILE=e2e` vía `scripts/e2e-full.mjs`) | **116 passed, 0 failed** | sección 5 |
| `npm run -w apps/web test:e2e:full` (corrida 2/2) | **116 passed, 0 failed** | sección 6 |

**Veredicto**: reproducibilidad completa. La corrida contaminada de
`apps/web test` no es una regresión — es exactamente el patrón de
contención de CPU que el propio README documenta (timeout de 20s +
`retry: 1`), y desaparece al aislar la corrida. `test:e2e:full` es
**determinísticamente verde 2/2** en este HEAD, confirmando la adenda
de `ronda5-final.md` sobre `40b3dfe`.

---

## 2. Ataques — veredicto por hallazgo

### RF-01 — step-up en aprobación de `tool_calls` (MEDIA-ALTA → CORREGIDO, reconfirmado)

| Escenario atacado | Método | Resultado | Veredicto |
|---|---|---|---|
| Admin con permiso (owner/admin) pero **sin 2FA enrolado** hace clic en "Aprobar" | UI real (Chromium), cuenta real sin 2FA | `StepUpDialog` detecta `enrolled:false` **antes** de intentar la mutación — 0 peticiones a `.../approve`, se muestra `EmptyState` + enlace real "Ir a Configuración a enrolar 2FA →" | **CONFIRMADO** — más estricto que un 403 crudo: nunca deja llegar el error sin explicación |
| Admin con 2FA aprueba una `tool_call` real | UI real, TOTP calculado en vivo (`otplib`) | `POST /auth/2fa/step-up` → 201, `POST /agents/tool-calls/:id/approve` → 200 (network real capturado) | **CONFIRMADO** — un 200 real es prueba viva de `purpose="tool_call.approval"` + `X-Org-Id` correctos (ver fila siguiente para el contraste) |
| Cross-org: superadmin (sin membership en la org dueña) aprueba desde "Aprobaciones" | UI real + API directa | UI: `POST /auth/2fa/step-up` (orgId=dueña) → 201, `POST /admin/tool-calls/:id/approve` → 200. API: mismo token pero atado a la organización PROPIA del superadmin → **403** "atada a OTRA organización"; sin `X-Step-Up` → **403** con instrucción | **CONFIRMADO** — `orgId` se ata a la organización dueña de la `tool_call`, nunca a la activa del superadmin |
| Writer (sin permiso) | UI real | Columna "Acciones" no existe; texto honesto "Tu rol (writer) puede ver las tool_calls pero no aprobarlas/denegarlas" | **CONFIRMADO** — mismo invariante que A12 |
| Token de un `purpose` reusado en otro (`company.rate_approval` sobre una ruta que exige `tool_call.approval`) | API directa | `POST .../approve` con ese token → **403** "emitida para OTRA acción" | **CONFIRMADO** |

### R5-11 — concurrencia real en `apps/api` (reverificado con ataque nuevo)

Dos `stepUpToken` válidos y distintos (uno por código de respaldo cada
uno, ambos `purpose=tool_call.approval`, mismo `orgId`), disparados
**verdaderamente en paralelo** (`curl ... & curl ... & wait`) contra la
MISMA `tool_call` pendiente:

```
[T2] HTTP 200 {"authorizationStatus":"approved",...}
[T1] HTTP 409 {"title":"La tool_call ya fue resuelta (no está pendiente)"}
```

**Veredicto: CONFIRMADO** — exactamente un 200 y un 409, nunca los dos
200. No es una repetición del test ya existente: aquí ambas peticiones
HTTP fueron procesos reales concurrentes contra un servidor real, no
`app.inject` secuencial de un test.

### RF-02 — condición de carrera en `refreshSession()` (MEDIA → CORREGIDO, reconfirmado)

| Escenario | Método | Resultado | Veredicto |
|---|---|---|---|
| 30 recargas de página con sesión activa | `vite preview` (build de producción real) + `apps/api` real + Chromium real, 30 recargas reales espaciadas ~0.6s | **30/30 con una sola `POST /auth/refresh`, 0×401** | **CONFIRMADO** — el bug original era intermitente (~2/6 en la auditoría original); aquí 0/30 |
| Bootstrap + petición 401 concurrente → 1 refresh | Test determinístico dedicado (`useAuth.test.tsx`, reproducido dentro de los 114/114 verdes) — forzar la carrera exacta desde fuera del proceso ya no es viable porque `bootstrap()` ahora SIEMPRE espera `refreshSessionOnce()` antes de disparar cualquier otra petición | Test pasa; ya se demostró en rojo contra el código anterior y en verde con el fix (ver commit `6282988`) | **CONFIRMADO** por el mecanismo (código: `useAuth.tsx#bootstrap` usa el mismo `refreshSessionOnce()` que el 401-retry de `apiRequest`) + el test |
| Refresh que falla → logout limpio sin bucle | Refresh token corrompido en `localStorage`, recarga real | `POST /auth/refresh` → 401 **una sola vez**, redirección limpia a `/login`; reconfirmado 3s después: sigue habiendo solo 1 petición | **CONFIRMADO** |

### RF-03 — QR real (BAJA → CORREGIDO, reconfirmado con librería independiente)

Captura de pantalla real del `<canvas>` → decodificada con `jsQR`
(librería de terceros, nunca usada por el propio proyecto) →

```
otpauth://totp/Atiende%20Licitaciones:manual-admin2-no2fa%40example.com?secret=FFRCHQCNGZL6MGKGFU67CLQ6QFQ5TZEV&issuer=Atiende%20Licitaciones
```

Comparado carácter por carácter contra el texto plano mostrado en la
misma pantalla: **coincide exacto**. El `<canvas>` tiene
`role="img"` + `aria-label="Código QR para enrolar la verificación en
dos pasos en tu app de autenticación"` (confirmado con el árbol de
accesibilidad real del DOM). El secreto y la URL en texto plano siguen
presentes sin cambios. **Veredicto: CONFIRMADO** — no es un
placeholder, codifica el secreto real del usuario.

### RF-04 — contraste del toast, ambos temas (MEDIA → CORREGIDO, reconfirmado con matiz)

- `test:e2e:full` 2/2 limpio (**tema por defecto = claro**, `ThemeSelector`
  arranca en `"claro"` salvo que el usuario elija otra cosa —
  `apps/web/src/components/ThemeSelector.tsx`) — cubre el escenario
  real y completo (bases → matriz → tarifa con step-up → propuesta
  económica) con el propio `waitForTimeout(500)` de `40b3dfe`.
- **Tema oscuro**: se leyeron los colores computados REALES del
  navegador para las clases exactas que usa `sonner.tsx`
  (`bg-card`/`text-foreground`) en ambos temas:
  - Oscuro: `color: rgb(238,242,246)` sobre `background: rgb(20,30,46)`
    → **14.88:1**
  - Claro: `color: rgb(15,28,46)` sobre `background: rgb(255,255,255)`
    → **17.13:1**
  - Ambos muy por encima del 4.5:1 exigido por WCAG 2 AA.
  - Además se disparó en vivo, dos veces, la aprobación real de una
    `tool_call` en tema oscuro real (mismo `Toaster`/mismo
    `toast.success(...)` que usa TODA la app, incluida
    `RedaccionPage.tsx`) — el toast se renderiza correctamente, sin
    excepciones.

**Matiz honesto**: no se reprodujo el toast **textual exacto**
"Propuesta económica generada" en **tema oscuro** con un escaneo axe
real inmediato (sin esperar los 500ms) — habría exigido repetir en vivo
todo el flujo de negocio de `expediente-flujo-completo.spec.ts` (bases,
matriz, tarifa con step-up, redacción técnica) solo para llegar a ese
punto, fuera del presupuesto de esta reverificación. La verificación de
colores computados reales (arriba) es una prueba MÁS fuerte que un
escaneo axe puntual porque es la causa raíz *sin* la variable de tiempo
de animación que originó el hallazgo — pero **la suite automatizada
segín se ejecuta hoy (`test:e2e:full`) nunca corre en tema oscuro**, lo
cual es una nota de cobertura real, no un hallazgo de severidad
(ver rubro 3).

### R5-12 — comentario desactualizado en `twofa.ts` (BAJA, ya conocido, reconfirmado sin corregir)

`apps/web/src/lib/api/twofa.ts:33-35` sigue afirmando que
`/2fa/verify-enrollment` "no fue actualizada para EXIGIRLOS
[orgId/purpose] a nivel de aplicación como sí lo está `/2fa/step-up`".
Confirmado en código, `apps/api/src/modules/twofa/routes.ts:241-242`:
la ruta `/2fa/verify-enrollment` SÍ llama `assertStepUpOrgId`/
`assertStepUpPurpose`, exactamente igual que `/2fa/step-up`. El
comentario sigue siendo incorrecto. **Sin impacto funcional** (es un
comentario, no código ejecutable) — fuera del alcance de la corrección
de RF-01..04 según su propio encargo, sigue así.

---

## 3. Nota de cobertura (no es un hallazgo nuevo, RF-05+)

`test:e2e:full` arranca siempre con el tema por defecto ("claro" —
`ThemeSelector` lee `localStorage`, vacío en cada worker nuevo de
Playwright). **Ningún test de la suite automatizada cambia
explícitamente a tema oscuro antes de correr axe** sobre una pantalla
con datos reales cargados (`recorrido.spec.ts` sí recorre ~29 rutas con
organización vacía, pero tampoco alterna tema ahí). Dado que el
mecanismo de color del toast (`!text-foreground` sobre `bg-card`) es
compartido por TODA la app y se confirmó con un margen de contraste muy
amplio en ambos temas (rubro 2, RF-04), esto es una nota de cobertura
razonable para una ronda futura, no una regresión ni un hallazgo de
severidad.

---

## 4. Investigación descartada (no es un hallazgo)

Durante los ataques en vivo, el log de red del navegador mostró un
`POST /auth/logout → 503` puntual al cerrar sesión desde la UI.
Reproducido de forma aislada contra el MISMO HEAD (`a62aacf`) con
`app.inject` (in-process) y con HTTP real sobre un puerto real: **el
servidor siempre responde 204**, incluso con un `refreshToken` inválido
o ya usado (logout es idempotente por diseño —
`apps/api/src/modules/auth/routes.ts`). `useAuth.tsx#logout` además
SÍ espera (`await`) la respuesta antes de limpiar tokens y navegar, así
que tampoco hay una ruta de carrera del lado del cliente. Se concluye
que el 503 fue un artefacto puntual de la instrumentación de red de
`claude-in-chrome` (coincidió con un error aislado de "Frame with ID 0
is showing error page" en la misma sesión de captura) — descartado, sin
impacto en ningún veredicto de este documento. Evidencia completa en la
sección 8 de `docs/logs/reverify-ronda5-final.log`.

---

## 5. Balance final de la ronda 5

| Hallazgo | Severidad | Estado al iniciar esta reverificación | Estado reconfirmado |
|---|---|---|---|
| RF-01 | MEDIA-ALTA | CORREGIDO (`0d4f5cf`) | **CERRADO** — verificado en código, por API directa (incl. concurrencia R5-11) y en vivo desde la UI real con los 4 actores (writer, admin sin 2FA, admin con 2FA, superadmin cross-org) |
| RF-02 | MEDIA | CORREGIDO (`6282988`) | **CERRADO** — 30/30 recargas reales sin el par 200/401; refresh fallido con logout limpio sin bucle; carrera bootstrap+401 confirmada por test determinístico |
| RF-03 | BAJA | CORREGIDO (`9dc6000`) | **CERRADO** — QR real decodificado con librería independiente, coincide exacto con el `otpauthUrl`; accesible (`role="img"`+`aria-label`) |
| RF-04 | MEDIA | CORREGIDO (`40b3dfe`, ya en el HEAD auditado) | **CERRADO** — `test:e2e:full` 2/2 limpio; contraste real verificado en AMBOS temas (14.88:1 oscuro, 17.13:1 claro); nota de cobertura sobre tema oscuro en la suite automatizada (no bloqueante) |
| R5-11 (API) | BAJA-MEDIA | CORREGIDO (`428797f`) | **CERRADO** — reconfirmado con 238 tests verdes + ataque de concurrencia real nuevo (200+409) |
| R5-12 | BAJA | Sin corregir (fuera de alcance) | **Sigue sin corregir** — solo un comentario, sin impacto funcional |

**Ninguna regresión encontrada.** Ningún hallazgo nuevo de severidad
relevante (RF-05+) — el único candidato investigado (503 en logout) se
descartó como artefacto de instrumentación, no de producto.

## 6. Candidatos a CUMPLIDO para el orquestador (`docs/ACEPTACION.md`, no editado por este agente)

Con la evidencia de esta reverificación sumada a la de `ronda5-final.md`
(rubro 8, ya entregada al orquestador) y `api-r5-09-10-reverificacion.md`:

| REQ/A | Evidencia consolidada tras esta reverificación | Recomendación |
|---|---|---|
| REQ-044/064 | Step-up 2FA real de extremo a extremo, incluyendo AHORA `tool_calls` (RF-01) y su caso cross-org — verificado en código, API y UI real | **CUMPLIDO** (matiz: solo TOTP, passkey/WebAuthn queda pendiente para otra ronda) |
| REQ-049/065/089 | `test:e2e:full` determinísticamente verde 2/2 en este HEAD (116/116) — el hallazgo RF-04 que había forzado reabrir este criterio está cerrado y reconfirmado | **CUMPLIDO** (se mantiene; no se reabre) |
| REQ-142 | Reconfirmado por los 238 tests de `apps/api` (incl. `security-req142-provenance-binding.test.ts`) | **CUMPLIDO** |
| REQ-171 | Reconfirmado por los 238 tests de `apps/api` (incl. `correlation-id-e2e.test.ts`) + `AuditoriaPage.tsx` conectado | **CUMPLIDO** |
| A13 | Reconfirmado: `test:e2e:full` 2/2 incluye la descarga autenticada real del paquete desde `apps/web` | **CUMPLIDO** |
| A11, A12, A14, A15 | Sin cambios desde `ronda5-final.md`, reconfirmados indirectamente por la reproducción limpia de `test:e2e:full` 2/2 | Se mantienen **CUMPLIDO** |

`docs/ACEPTACION.md` sigue siendo un snapshot pre-ronda-5 (declara HEAD
`b362e62`) — su actualización formal queda, como ya señaló la auditoría
original, a criterio del orquestador.
