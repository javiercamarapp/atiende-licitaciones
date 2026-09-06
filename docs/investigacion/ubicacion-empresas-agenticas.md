# Investigación: ubicación de la "carpeta de empresas agénticas"

- **Fecha:** 2026-09-05
- **Alcance:** solo lectura. No se creó ni movió ninguna carpeta.
- **Conclusión: NO ENCONTRADA.** No existe en el sistema local ninguna carpeta llamada (o razonablemente equivalente a) "empresas agénticas" que agrupe los repos `atiende-*`. El proyecto Hoteles ya investigó exactamente lo mismo el 2026-09-05 y llegó a la misma conclusión (bloqueo B-001, ABIERTO).

## Comandos ejecutados y resultados

### 1. Dónde vive realmente cada repo `atiende-*`
```
ls -ld /Users/javiercamaraportepetit/Documents/Codex/atiende-restaurantes
```
→ `atiende-restaurantes` es hijo directo de `~/Documents/Codex`, igual que `atiende-hoteles-staging` y `atiende-licitaciones-staging`. Ningún repo `atiende-*` cuelga de una carpeta intermedia con nombre relacionado a "empresas" o "agéntic*"; todos están al mismo nivel dentro de `~/Documents/Codex`, que también contiene carpetas fechadas (`2026-08-21`, `2026-09-04`, etc.), `SKILLS/`, `wiki-sync-inbox/`, etc. — es decir, `Codex` es una carpeta de trabajo general, no una carpeta temática de "empresas agénticas".

### 2. `find -maxdepth 5 -type d` con variantes de nombre
Ejecutado sobre `~/Documents`, `~/Desktop`, `~/Developer`, `~/Projects` con patrones `-iname` para: `*empresa*`, `*agentic*`, `*agenc*`, `*atiende*`, `*ventures*`, `*companies*`.

- `~/Developer` y `~/Projects`: **no existen** (find no devolvió nada porque las rutas no existen; no son directorios en este sistema).
- `~/Documents` (vía `-iname *atiende*`): solo los tres repos ya conocidos (`atiende-hoteles-staging`, `atiende-licitaciones-staging`, `atiende-restaurantes`), todos bajo `Codex`.
- `~/Desktop`: coincidencias por "agenc*"/"atiende", pero ninguna es una carpeta contenedora de empresas:
  - `Desktop/PlataformaAgenticaBlueprintseInvestigacionPDF` — carpeta de PDFs de investigación (blueprints de Hoteles/Restaurantes/Licitaciones), no un contenedor de repos.
  - `Desktop/INTENTO DE STARTUPS/ATIENDE` (con subcarpetas `atiende.ai`, `atiende.ai-1`) — proyecto de landing/marketing de "Atiende" (marca), sin relación con los repos de código `atiende-hoteles-staging`/`atiende-licitaciones-staging`/`atiende-restaurantes`; contenido no revisado en detalle (fuera de alcance, no son secretos pero no aportan a la pregunta de ubicación de repos).
  - `Desktop/Javier-Portafolio-Compartir/Videos Marketing/ATIENDE` — carpeta de videos de marketing.
  - `Desktop/mi memoria claude/.raw/projects/atiende-ai` — caché de memoria de Claude, no carpeta de proyecto.
  - `Desktop/Documentos Likida/.../01-lista-de-empresas` — lista de prospectos de ventas de Likida (otro producto), no relacionado.

Ninguna de estas es una carpeta agrupadora de "empresas agénticas" ni contiene o apunta a los tres repos `atiende-*`.

### 3. `~/Library/CloudStorage/*` (Google Drive, iCloud)
```
ls -la ~/Library/CloudStorage/
```
→ Solo hay `GoogleDrive-javiercamaraportepetit@gmail.com` (no hay iCloud Drive configurado en `CloudStorage`).
```
find "~/Library/CloudStorage/GoogleDrive-.../" -maxdepth 4 -type d -iname "*empresa*" -o -iname "*agentic*" ...
```
→ **Sin resultados.** El contenido de Google Drive (`Mi unidad/`) tiene proyectos de Likida (`likida-ai-enterprise-main`, `LIKIDA/...`) pero ninguna carpeta de "empresas agénticas" ni repos `atiende-*`.

### 4. `mdfind` con variantes
Se ejecutó `mdfind -onlyin ~ "<término>"` para: `empresas`, `agénticas`, `agenticas`, `agentic`, `agency`, `agencia`, `atiende`, `companies`, `ventures`, `Atiende`.

- Todas las coincidencias son **documentos** (PDFs de blueprints/investigación, .md de la wiki de memoria de Claude, entregables de Likida, node_modules con "companies" en un README de terceros), nunca una carpeta contenedora real.
- Los únicos directorios que aparecen en los resultados de `mdfind atiende`/`Atiende` son, de nuevo, `atiende-hoteles-staging`, `atiende-licitaciones-staging`, `atiende-restaurantes` (bajo `Codex`) y `Desktop/PlataformaAgenticaBlueprintseInvestigacionPDF` (PDFs, no repos).

### 5. Historial de shell
```
wc -l ~/.zsh_history            → 4538 líneas (existe)
ls ~/.bash_history              → no existe
grep -iE "mkdir|cd " ~/.zsh_history | grep -iE "empresa|agent|atiende"
```
→ **Sin coincidencias.** No hay ningún `cd` o `mkdir` en el historial de zsh que mencione "empresa", "agent*" o "atiende" en el mismo comando (se probaron ambas variantes de grep, amplia y estricta).

### 6. Memoria de Claude Code
```
find /Users/javiercamaraportepetit/.claude/projects/*/memory -type d
ls -la ".../memory"
grep -rli "empresa|agéntic|agentic|atiende" ".../memory"
```
→ El único directorio `memory/` existente (`/Users/javiercamaraportepetit/.claude/projects/-Users-javiercamaraportepetit/memory`) está **vacío** (sin archivos `.md`). No hay notas de memoria persistente sobre esta carpeta. (Sí hay menciones del término en `history.jsonl` y transcripciones `.jsonl` de sesiones — logs de conversación, no memoria estructurada — que reflejan justamente esta misma pregunta siendo investigada, no una respuesta ya resuelta.)

### 7. Docs de `atiende-hoteles-staging` (bloqueo ya registrado por Hoteles)
Se revisaron `docs/BLOQUEOS.md`, `docs/PROGRESO.md` y `docs/operacion-bucle.md`.

**`docs/BLOQUEOS.md` — B-001 (ABIERTO), fecha 2026-09-05**, contenido íntegro relevante:
- Hoteles ejecutó un barrido equivalente (`find` con variantes `agentic`/`agéntica`/`EmpresasAgenticas`, `mdfind`, listados de `~`, `~/Desktop`, `~/Documents`, `~/Documents/Codex`, iCloud Drive) y concluyó: **sin resultados**, la carpeta no existe.
- Candidatas que Hoteles anotó como **no confirmadas** (pendientes de decisión del usuario): `~/Documents/Codex` (donde vive `atiende-restaurantes`), `~/Desktop/INTENTO DE STARTUPS`, `~/Desktop/GitHub`.
- Acción tomada por Hoteles: trabajar de forma provisional en `~/Documents/Codex/atiende-hoteles-staging` sin crear ninguna carpeta nueva.
- Pendiente explícito: "ruta exacta de la carpeta (o autorizar una candidata)" — es decir, **Hoteles dejó esto sin resolver, a la espera de que el usuario responda**, igual que se encuentra ahora.
- Marcado como "Intentos: 1 (barrido local completo). No se repetirá el barrido; se espera respuesta" — Hoteles decidió no re-intentar la búsqueda.

**`docs/PROGRESO.md`**: línea `R-0 (ubicación) · barrido local de "empresas agénticas" · docs/BLOQUEOS.md B-001 · — · NO ENCONTRADA · siguiente: esperar ruta del usuario; trabajo de requisitos sigue.` — confirma el mismo estado: NO ENCONTRADA, bloqueado en espera del usuario.

**`docs/operacion-bucle.md`**: en la sección "Reanudación tras cierre de sesión" usa el comentario `# o la ruta definitiva` junto a la ruta actual (`~/Documents/Codex/atiende-hoteles-staging`), lo que confirma que Hoteles trata su ubicación actual como **provisional**, anticipando una futura reubicación a la carpeta "empresas agénticas" una vez que el usuario la confirme. No hay ninguna ruta definitiva registrada en ningún documento de Hoteles.

Se comprobó también que no existe `docs/BLOQUEOS.md`/`PROGRESO.md` adicional en `atiende-restaurantes` con más pistas (no se encontró mención de "empresas agénticas" fuera de Hoteles al hacer `grep`/`mdfind` globales).

## Candidatos descartados (resumen)

| Ruta | Por qué NO encaja |
|---|---|
| `~/Documents/Codex` | Contiene los tres repos `atiende-*` pero también carpetas fechadas, `SKILLS/`, inbox de wiki-sync — es una carpeta de trabajo general de Codex, no una carpeta temática "empresas agénticas"; nombre no coincide y Hoteles ya la marcó como candidata no confirmada. |
| `~/Desktop/INTENTO DE STARTUPS/ATIENDE` (y `atiende.ai`, `atiende.ai-1`) | Proyecto de marca/landing "Atiende", no contiene ni referencia a los repos de código; nombre no coincide con "empresas agénticas"; ya listada como candidata no confirmada por Hoteles. |
| `~/Desktop/GitHub` | Solo contiene `Mirror-AI` y `repo-temp`, sin relación con "empresas agénticas" ni con los repos `atiende-*`; listada por Hoteles como candidata pero sin evidencia de contenido real que la respalde. |
| `~/Desktop/PlataformaAgenticaBlueprintseInvestigacionPDF` | Es una biblioteca de PDFs de investigación/blueprints (Hoteles, Restaurantes, Licitaciones), no un contenedor de repos ni carpeta de empresas. |
| Google Drive (`Mi unidad/...`) | Contiene proyectos de Likida (`likida-ai-enterprise-main`, `LIKIDA/...`); ninguna carpeta ni documento llamado "empresas agénticas"; no hay repos `atiende-*` replicados ahí. |
| `~/Library/CloudStorage/*iCloud*` | No existe ninguna cuenta de iCloud Drive montada en este sistema (`CloudStorage` solo tiene Google Drive). |
| `~/Developer`, `~/Projects` | No existen como directorios en este sistema. |
| `.zsh_history` / `.bash_history` | Sin comandos `cd`/`mkdir` que mencionen "empresa", "agent*" o "atiende" combinados; `.bash_history` ni siquiera existe. |
| Memoria de Claude Code (`~/.claude/projects/*/memory/`) | El único directorio de memoria existente está vacío; no hay nota persistente que resuelva la ubicación. |

## Conclusión final

**NO ENCONTRADA.** No existe evidencia local de una carpeta "empresas agénticas" en ninguna de las ubicaciones buscadas (Documents, Desktop, Developer/Projects —inexistentes—, Google Drive, iCloud —inexistente—, Codex y subcarpetas fechadas), ni en `mdfind`, ni en el historial de shell, ni en la memoria de Claude Code. El proyecto Hoteles llegó exactamente a la misma conclusión el mismo día (B-001, ABIERTO en `atiende-hoteles-staging/docs/BLOQUEOS.md`) y dejó el bloqueo pendiente de respuesta del usuario, sin repetir el barrido y sin crear ninguna carpeta nueva. `atiende-licitaciones-staging` debería seguir el mismo patrón: seguir trabajando de forma provisional en `~/Documents/Codex/atiende-licitaciones-staging` y registrar este mismo bloqueo (mencionando que Hoteles ya lo tiene abierto como B-001), en vez de repetir la búsqueda o inventar/crear una carpeta. La decisión de la ruta definitiva depende exclusivamente del usuario.
