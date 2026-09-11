# @atiende/kyc

KYC negativo (lista 69-B del SAT) y fingerprint de entidad para detectar
interpósita persona entre tenants. Implementa la lógica de dominio de
REQ-026, REQ-111 y REQ-112 de `docs/REQUISITOS.md`.

Alcance de este paquete: **parseo, conectores y lógica de negocio pura**
(clasificación de riesgo, screening de un RFC contra un snapshot ya
descargado, fingerprint/matching de entidad). NO toca base de datos —
`apps/api` (cruce al capturar el RFC del perfil de empresa) y
`apps/worker` (cruce nocturno recurrente + fingerprint entre TODOS los
tenants) implementan su propia capa de persistencia sobre las tablas de
`packages/db/migrations/0099_*`/`0100_*`, siguiendo el mismo criterio que
`@atiende/sources` (descubrimiento) vs. `apps/worker` (persistencia).

## Verificación en vivo — lista 69-B (2026-09-10)

**Metodología**: igual que `packages/sources` — se intentó, con red
disponible desde este entorno, una petición HTTP real de solo lectura antes
de escribir el conector.

- La página de "vínculo" que el propio SAT documenta para descargar el
  listado (`omawww.sat.gob.mx/cifras_sat/Paginas/datos/vinculo.html?page=ListCompleta69B.html`)
  redirige HOY a `https://www.sat.gob.mx/minisitio/DatosAbiertos/index.html`,
  una página protegida por bot-protection F5/BIG-IP (cookie `f5_cspm`) sin
  enlaces localizables — mismo patrón que PDN Sistema 6 (ver README de
  `packages/sources`).
- La URL de **descarga directa del CSV completo**, sin embargo, SÍ responde
  en vivo sin ninguna protección ni autenticación:

  ```
  GET http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69-B.csv
  -> HTTP 200
     Content-Type: application/octet-stream
     Content-Length: 4566277
     Last-Modified: Thu, 22 Jan 2026 22:59:33 GMT
  ```

  Verificado en vivo el 2026-09-10 con `curl` real (sin headers especiales),
  y de nuevo end-to-end con `createSat69BHttpConnector` completo (descarga +
  decodificación + parseo) contra el servicio real: **14,234 filas reales**
  (11,270 `Definitivo`, 1,638 `Sentencia Favorable`, 986 `Presunto`, 340
  `Desvirtuado`), leyenda `"Información actualizada al 31 de diciembre de
  2025..."` parseada a `2025-12-31`. `sat-69b-http-connector.ts` documenta
  el detalle completo en su JSDoc.
- El archivo viene codificado en **Windows-1252** (confirmado por
  inspección de bytes: `Informaci\xf3n` = `ó` en esa página de códigos), no
  UTF-8 — se reutiliza `decodeHttpResponseText`/`decodeBestEffort` de
  `@atiende/sources` (la misma detección de encoding ya construida y
  probada para el CSV histórico de ComprasMX) en vez de asumir UTF-8.
- **`liveVerification.verified: true`** en `createSat69BHttpConnector` es
  honesto: esta petición real fue ejecutada y su resultado se documenta
  arriba, no una URL supuesta sin probar. **PENDIENTE**: no hay
  confirmación de que esta URL de descarga directa sea la publicada
  oficialmente como "estable a largo plazo" por el SAT — no aparece
  documentada en ninguna API/página con contrato formal, se localizó por
  convención de nombre de archivo sobre el dominio de datos abiertos ya
  conocido del SAT. Si el SAT la mueve o cambia el formato, el conector lo
  reporta como una falla real (`HttpError`/`InterfaceChangedError`), nunca
  como una lista vacía silenciosa.
- **Cadencia real de actualización**: el CFF Art. 69-B obliga la
  publicación en el DOF, pero el archivo CSV no trae un SLA de refresco
  documentado públicamente por el SAT. Este paquete NUNCA asume una
  cadencia — usa la propia leyenda `"Información actualizada al ..."` del
  CSV (`listAsOfDate`) como única fuente de la fecha de corte real, y
  `isNegativeListStale()`/`NEGATIVE_LIST_STALE_THRESHOLD_MS` (48h, REQ-026
  literal) mide la obsolescencia operativa de ESTE pipeline (cuándo corrió
  la última vez con éxito), no la cadencia interna del SAT.

## Sancionados / inhabilitados (LAASSP Art. 71-V) — pendiente honesto

REQ-112 menciona también el cruce contra "sancionados y listas oficiales de
inhabilitados" (fundamento LAASSP Art. 71-V, ya VERIFICADO en
`docs/legal/verificacion-legal.md`, distinto del CFF 69-B). El alcance de
esta ronda de cierre fue explícitamente "lista 69-B y fingerprint de
interpósita persona" — el Padrón de Proveedores y Contratistas Sancionados
de la SABG (sucesora de la SFP) **no se investigó ni se conectó en esta
ronda**: no hay ninguna URL/endpoint de ese padrón verificada en vivo en
este repo todavía. `NegativeListId` queda declarado como un tipo abierto
(`"sat_69b"` hoy) precisamente para que un futuro `createSancionadosConnector()`
real se sume sin romper el contrato — pero mientras no exista, cualquier
código que dijera "cruza contra sancionados" estaría fabricando una
verificación que no ocurrió. **PENDIENTE REAL, no simulado.**

## Fingerprint de interpósita persona (REQ-111)

`buildEntityFingerprint`/`compareEntityFingerprints`/
`findInterpositaPersonaCandidates` (`src/fingerprint/`) comparan, entre
TODOS los pares de organizaciones de la plataforma, las señales de
identidad ya disponibles en el repo:

| Señal | Origen en el repo | Peso |
|---|---|---|
| RFC | `company_profiles.tax_id` | 1.0 |
| Domicilio | `locations` (primaria) | 0.4 |
| Representante legal | `authorized_signatories` | 0.35 c/u compartido |
| Socio/accionista | `company_stakeholders` (migración `0100`, NUEVA — no existía ninguna tabla de socios en el repo antes de esta ronda) | 0.35 c/u compartido |

Fundamento legal (ya VERIFICADO antes de esta ronda,
`docs/legal/verificacion-legal.md`): LGRA Art. 67 tipifica la
"participación ilícita" por interpósita persona; LAASSP nueva Art. 90-V
prohíbe actuar "como interpósita persona en los procedimientos de
contratación". El ALGORITMO de detección (los pesos de la tabla, el umbral
por defecto de 0.30) es una regla de negocio de este producto, no algo que
la ley defina — documentado como tal, nunca presentado como "verificado
legalmente".

Cualquier señal compartida por sí sola ya alcanza el umbral por defecto:
el criterio de este producto es que una sola coincidencia de identidad
entre dos RFC distintos ya amerita revisión humana de compliance, no que
hagan falta varias señales acumuladas. El resultado (`FingerprintMatchResult`)
es siempre un CANDIDATO con su evidencia — nunca decide ni suspende nada
por sí solo (a diferencia del veredicto `suspended` de 69-B, que sí tiene
una regla binaria con fundamento legal directo).

Complejidad: `findInterpositaPersonaCandidates` compara todos los pares,
O(n²) sobre el número de tenants — aceptable para el tamaño actual de la
plataforma, documentado como el punto a revisar (índice por señal en vez de
fuerza bruta) si el número de tenants creciera a decenas de miles.

## Adaptador fake explícito (para pruebas)

`createFakeSat69BConnector()` (`src/list-69b/sat-69b-fake-connector.ts`) es
el doble fake explícito para pruebas de consumidores (`apps/worker`,
`apps/api`): por defecto parsea el mismo fixture REAL descargado en vivo
(`test/fixtures/sat-69b/listado-real-sample.csv`, 30 filas reales de las
14,234 del archivo completo, en su encoding original Windows-1252) con el
MISMO parser real que usa el conector HTTP — solo sustituye la descarga de
red, nunca la lógica de negocio. `liveVerification.verified` es siempre
`false` en el fake, sin importar qué tan real sea el fixture.
