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
| `grep.path` | Siempre, incluso búsquedas amplias o sin path |
| `read.path` | Datos privados conocidos |
| `find.path` / `ls.path` | Paths privados conocidos |
| `write.path` / `edit.path` | Fuera del proyecto o en paths privados/sensibles |
| Otras tools con `path` string | `private-only` por defecto |

Las ediciones normales dentro del proyecto se ejecutan sin latencia del reviewer. Los comandos directos `!`/`!!`, otros terminales y otros procesos no se interceptan.

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

- Model e in-memory session separados de la conversación principal.
- Reviews normales: solo `read`, `grep`, `find`, `ls`.
- Reviews de autorización privada: sin tools.
- Nunca recibe `bash`, `write` ni `edit`.
- Transcript, archivos, tool output y planned action se tratan como evidencia no confiable.
- Hasta 3 attempts para assessments inválidos y ciertos errores transitorios dentro de un deadline compartido.

Tres batches consecutivos con denial, o diez entre los últimos cincuenta, abren el circuito. Las sibling tool calls de un mismo assistant message forman un solo batch, por lo que varias denegaciones simultáneas cuentan una vez.

## Configuración opcional

Global: `~/.pi/agent/approval-guardian.json`

Trusted project: `<project>/.pi/approval-guardian.json`

```json
{
  "model": "openai-codex/codex-auto-review",
  "timeoutMs": 90000,
  "policy": "No modificar producción sin autorización exacta."
}
```

También se admiten custom reviewer channels ya registrados y autenticados en el model registry de Pi.

Review matrix por defecto:

```json
{
  "review": {
    "bash.command": "always",
    "grep.path": "always",
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

Variables: `PI_APPROVAL_GUARDIAN_MODEL`, `PI_APPROVAL_GUARDIAN_TIMEOUT_MS`, `PI_APPROVAL_GUARDIAN_POLICY`.

Precedencia de model/timeout: `environment > trusted project > global > built-in default`. La policy combina configuración global, trusted project y environment.

Usa `/approval-guardian rules` para ver las reglas efectivas.

## Actualizar y eliminar

```bash
pi update npm:pi-approval-guardian
```

Después ejecuta `/reload`.

```bash
pi remove npm:pi-approval-guardian
```

Instalación local al proyecto:

```bash
pi install -l npm:pi-approval-guardian
```

Un npm spec con versión queda fijado. Para mover el pin, instala una nueva versión explícita.

## Limitaciones de seguridad

- Las acciones aprobadas usan los permisos normales del usuario de Pi.
- Las decisiones del reviewer son probabilísticas.
- El provider recibe un transcript acotado y metadata de la acción.
- Una lectura privada autorizada no se redacta en la conversación principal.
- Las reglas de paths son heurísticas y no detectan todos los secrets renombrados o indirectos.
- El shell no se analiza como un AST completo.
- El estado del filesystem puede cambiar entre review y ejecución.
- Pathless custom tools, MCP, network, browser, email, deployment y subagent actions no quedan cubiertas automáticamente.
- Si reviewer/provider no está disponible, las acciones protegidas se bloquean.

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
