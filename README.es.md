# pi-approval-guardian

**Revisión automática fail-closed para llamadas de herramientas de Pi.**

Antes de ejecutar comandos shell, leer datos privados o modificar archivos sensibles/fuera del proyecto, un modelo reviewer aislado evalúa la acción.

[![npm version](https://img.shields.io/npm/v/pi-approval-guardian.svg)](https://www.npmjs.com/package/pi-approval-guardian)
[![CI](https://github.com/mics8128/pi-approval-guardian/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/pi-approval-guardian/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Pi package](https://img.shields.io/badge/Pi-package-6c5ce7)](https://pi.dev/packages/pi-approval-guardian)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español**

> [!IMPORTANT]
> Las extensiones de Pi se ejecutan con los permisos del usuario actual. Revisa el código antes de instalar. Este paquete es un approval gate, no un sandbox del sistema operativo.

## Instalación

```bash
pi install npm:pi-approval-guardian
```

El reviewer por defecto es `openai-codex/codex-auto-review`, con un deadline compartido de 90 segundos. Si el provider oficial de Codex no está autenticado:

```text
/login openai-codex
/reload
/approval-guardian
```

La configuración por defecto no requiere archivo adicional.

## Protección por defecto

| Tool/action | Scope por defecto |
| --- | --- |
| `bash.command` | Siempre se revisa |
| `grep.path` | Fuera del proyecto o cuando path/pattern/glob/scope efectivo puede exponer datos privados |
| `read.path` | Datos privados conocidos |
| `find.path` / `ls.path` | Paths privados conocidos |
| `write.path` / `edit.path` | Fuera del proyecto o en paths privados/sensibles |
| Otras tools con `path` string | `private-only` por defecto |

Las ediciones y búsquedas limpias normales dentro del proyecto se ejecutan sin latencia del reviewer. Los comandos directos `!`/`!!`, otros terminales y otros procesos no se interceptan.

## Funcionamiento

```text
Pi agent tool call
        │
        ├─ acción normal ───────────────────────────► ejecutar
        │
        └─ acción protegida
               │
               ▼
        Guardian reviewer aislado
        normal: read · grep · find · ls
        private-data: sin tools
               │
          ┌────┴────┐
          ▼         ▼
        allow     otro resultado
        ejecutar   bloquear
```

Solo un `outcome: "allow"` válido permite ejecutar. Deny, timeout, output inválido, errores de auth/model/provider, cancelación y circuit open bloquean fail-closed.

El acceso a datos privados también exige autorización explícita en el transcript del usuario y `user_authorization: "high"` del reviewer.

## Reglas de datos privados

Se protegen, entre otros:

- `.env`, `.npmrc`, `.netrc`, `.pypirc`, credenciales Git, service accounts y directorios de credentials/secrets;
- claves SSH/GPG y autenticación de cloud CLI, Kubernetes y Docker;
- login stores del navegador, password managers, keychains/keyrings, VPN, certificados privados y credenciales de Terraform;
- ubicaciones comunes de credenciales en Linux, macOS y Windows;
- auth, settings/model/Guardian/trust, API keys, historial de runs/sessions/delegates, memory, bases de datos de context/session e índices de búsqueda de Pi.

No se considera privado todo `.pi/`. El código y la documentación de skills instalados bajo `.pi/agent/npm/node_modules/`, y el source de skills/agents/extensions del usuario, no requieren autorización privada únicamente por su ubicación. Un archivo individual aún puede coincidir con otra regla.

Read y mutation se clasifican por separado. Project `.pi/skills`, `.pi/agents`, `.pi/extensions`, prompts, themes, chains y package settings siguen siendo sensitive mutation surfaces porque pueden cambiar el comportamiento de Pi; se revisan al modificarlos, pero no son confidenciales solo por leerlos.

Se comprueban canonical paths y targets de symlinks.

## Comportamiento del reviewer

- El estado del reviewer usa una in-memory session aislada; el fallback final puede usar la identidad del model principal, pero nunca su estado de conversación.
- Reviews normales: solo `read`, `grep`, `find`, `ls`.
- Reviews de autorización privada: sin tools.
- Nunca recibe `bash`, `write` ni `edit`.
- Transcript, archivos, tool output y planned action se tratan como evidencia no confiable.
- Hasta 3 attempts para assessments inválidos y ciertos errores transitorios dentro de un deadline compartido por reviewer channel.

Tres batches adversos consecutivos, o diez entre los últimos cincuenta, abren el circuito. Deny, timeout y failure son adversos; allow y cancelación no lo son. Las sibling tool calls de un mismo assistant message forman un solo batch.

## Configuración opcional

Global: `~/.pi/agent/approval-guardian.json`

Trusted project: `<project>/.pi/approval-guardian.json`

```json
{
  "model": "openai-codex/codex-auto-review",
  "fallbackModel": "openai-codex/codex-auto-review",
  "timeoutMs": 90000,
  "policy": "No modificar producción sin autorización exacta."
}
```

También se admiten custom reviewer channels ya registrados y autenticados en Pi. Tras eliminar models duplicados, Guardian prueba el primary, el `fallbackModel` configurado y finalmente el model de la sesión Pi actual. Solo avanza por model/auth no disponible o failure explícito. Un timeout es terminal para esa acción y falla closed sin probar otro channel; allow, deny explícito y cancelación también detienen la cadena. Cada channel mantiene su propia reviewer session aislada y reutilizada incrementalmente; los avisos de cambio aparecen solo en la UI.

Review matrix por defecto:

```json
{
  "review": {
    "bash.command": "always",
    "grep.path": "outside-or-private",
    "read.path": "private-only",
    "find.path": "private-only",
    "ls.path": "private-only",
    "write.path": "outside-or-private",
    "edit.path": "outside-or-private"
  }
}
```

Niveles: `always`, `outside-or-private`, `private-only`, `off`.

Un trusted project solo puede reforzar la protección global:

```text
off < private-only < outside-or-private < always
```

Los defaults revisan cada `bash` del agent, mientras que un `grep` ordinario dentro del proyecto evita latencia cuando su path, selector y scope efectivo no pueden exponer datos privados. Usa `grep.path: "always"` para un perfil más estricto. No se recomienda desactivar `bash.command` salvo que exista otro shell gate o sandbox confiable.

Variables: `PI_APPROVAL_GUARDIAN_MODEL`, `PI_APPROVAL_GUARDIAN_FALLBACK_MODEL`, `PI_APPROVAL_GUARDIAN_TIMEOUT_MS`, `PI_APPROVAL_GUARDIAN_POLICY`.

Precedencia de primary model/fallback model/timeout: `environment > trusted project > global > built-in default`. La policy combina configuración global, trusted project y environment.

Usa `/approval-guardian` para ver primary, configured fallback, current-model fallback y las fuentes de configuración; `/approval-guardian rules` muestra las reglas efectivas.

## Actualizar y eliminar

```bash
pi update npm:pi-approval-guardian
```

Después ejecuta `/reload`.

```bash
pi remove npm:pi-approval-guardian
```

Instalación y eliminación local al proyecto:

```bash
pi install -l npm:pi-approval-guardian
pi remove -l npm:pi-approval-guardian
```

Después de eliminarlo, ejecuta `/reload`.

Un npm spec con versión queda fijado. Para mover el pin, instala una nueva versión explícita.

## Limitaciones de seguridad

- Las acciones aprobadas usan los permisos normales del usuario de Pi.
- Las decisiones del reviewer son probabilísticas.
- El provider recibe un transcript acotado y metadata de la acción.
- Una lectura privada autorizada no se redacta en la conversación principal.
- La clasificación de paths aplica antes la normalización compatible con Pi de `~`, `@`, `file://` y espacios Unicode, pero las reglas siguen siendo heurísticas y no detectan todos los secrets renombrados o indirectos.
- El shell no se analiza como un AST completo. Guardian solo usa bounded glob matching para targets privados comunes, por lo que puede omitir lecturas indirectas.
- Tras allow, Guardian valida y bloquea el tool input JSON-like para impedir cambios de handlers `tool_call` posteriores; los runtime values exóticos fallan closed. No observa commandPrefix, spawnHook, custom-tool internals ni cambios del filesystem después de dispatch.
- Pathless o nested-path custom tools, MCP, network, browser, email, deployment y subagent actions no quedan cubiertas automáticamente; necesitan dedicated enforcement.
- El estado del filesystem puede cambiar entre review y ejecución.
- Si primary, configured fallback y un current-model fallback distinto no están disponibles, las acciones protegidas se bloquean fail-closed.

Referencia técnica completa: [docs/REFERENCE.md](docs/REFERENCE.md)

## Desarrollo

Requiere Node.js 22.19 o superior.

```bash
npm install
npm run check
npm run package:check
pi -e .
```

Guía de publicación: [docs/PUBLISHING.md](docs/PUBLISHING.md)

## Licencia y atribución

El código original usa [MIT License](LICENSE). El material adaptado de OpenAI Codex Guardian policy/prompt permanece bajo [Apache License 2.0](LICENSES/Apache-2.0.txt). Consulta [NOTICE](NOTICE).

Este proyecto está inspirado en Guardian y no está afiliado ni respaldado por OpenAI.
