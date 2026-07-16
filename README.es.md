<div align="center">

# pi-approval-guardian

**Una puerta de aprobación automática fail-closed, inspirada en Codex Guardian, para Pi.**

Revisa todos los `bash` emitidos por el agente y las operaciones `write`/`edit` fuera del proyecto o sobre rutas sensibles antes de ejecutarlas.

[![npm version](https://img.shields.io/npm/v/pi-approval-guardian.svg)](https://www.npmjs.com/package/pi-approval-guardian)
[![CI](https://github.com/mics8128/pi-approval-guardian/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/pi-approval-guardian/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español**

</div>

> [!IMPORTANT]
> Las extensiones de Pi se ejecutan con tus permisos de usuario. Revisa el código antes de instalar. Este paquete es una puerta de aprobación, no un sandbox del sistema operativo.

## Inicio rápido

```bash
pi install npm:pi-approval-guardian
```

Crea `~/.pi/agent/approval-guardian.json`:

```json
{
  "model": "openai-codex/codex-auto-review",
  "timeoutMs": 90000,
  "policy": "No modificar producción sin aprobación explícita."
}
```

Reinicia Pi o ejecuta `/reload`, y comprueba el estado con `/approval-guardian`.

## Cómo funciona

```text
Pi agent tool call
  ├─ edición normal dentro del proyecto ─────► ejecución normal
  └─ bash / write sensible / edit sensible
                  ▼
       reviewer Guardian aislado
       solo read · grep · find · ls
                  ▼
       solo un allow explícito se ejecuta
```

Solo un `{"outcome":"allow"}` válido permite la ejecución. Denegación, timeout, fallo del proveedor, JSON inválido, cancelación, model/auth no disponible o circuit open bloquean la acción.

## Lista completa de funciones

### Intercepción

| Función | Comportamiento |
| --- | --- |
| Todo `bash` del agente | Se revisa antes de ejecutarse. |
| `write` sensible | Se revisa si el destino canónico está fuera del proyecto o coincide con una regla sensible. |
| `edit` sensible | Usa las mismas reglas de límite y sensibilidad. |
| Edición normal de código | Una edición no sensible dentro del proyecto evita la latencia del reviewer. |
| Shell directo excluido | `!`/`!!`, otros terminales y procesos no se interceptan. |
| Otras tools excluidas | Actualmente solo se cubren `bash`, `write` y `edit`. |

### Rutas sensibles

Se revisan rutas fuera del proyecto y categorías como:

- `.env`, credentials y secrets;
- `.ssh/`, `.gnupg/`, `.aws/`, `.kube/`, claves y certificados;
- `.zshrc`, `.bashrc`, `.profile` y persistencia del shell;
- `.git/`, hooks/config, `.github/`, GitLab CI;
- `.pi/`, settings y configuración Guardian;
- `package.json` y lockfiles npm/pnpm/Yarn;
- Terraform, Kubernetes y Docker Compose.

El clasificador resuelve symlinks de directorios existentes y symlinks de archivo colgantes para detectar escrituras fuera del proyecto. Una ruta sensible no se deniega automáticamente: requiere revisión.

### Aislamiento del reviewer

- Modelo separado del modelo de la conversación principal;
- sesión Pi aislada en memoria;
- solo `read`, `grep`, `find`, `ls`;
- sin `bash`, `write` ni `edit`;
- sin extensions, skills, prompt templates, themes ni project context files;
- thinking level `low`;
- investigación read-only de scripts, package scripts, destinos, configuración y metadata del repositorio;
- transcript, tool output, archivos, retry reason y acción tratados como evidencia no confiable.

La lista de tools no es un OS sandbox. El reviewer puede leer archivos accesibles para el usuario actual.

### Policy y prompt

Sincroniza conceptos del commit de OpenAI Codex Guardian [`03bb3b12367397e14a8facc2e018d645ff4d8e83`](https://github.com/openai/codex/tree/03bb3b12367397e14a8facc2e018d645ff4d8e83/codex-rs/core/src/guardian):

- separación transcript/action y protección contra prompt injection;
- risk: `low`, `medium`, `high`, `critical`;
- authorization: `unknown`, `low`, `medium`, `high`;
- low/medium normalmente permitidos;
- high solo con autorización suficiente, alcance limitado y sin absolute deny;
- critical denegado;
- exfiltración de secrets/private data a destinos no confiables denegada incluso con high authorization;
- reglas de credential probing, persistent security weakening, acciones destructivas, Git, borrado limitado y re-aprobación informada;
- organization policy adicional;
- respuesta JSON estricta.

### Límites de contexto

| Elemento | Límite |
| --- | ---: |
| Message transcript | 40.000 caracteres |
| Tool transcript | 40.000 caracteres |
| Una message | 8.000 caracteres |
| Una tool entry | 4.000 caracteres |
| Planned action | 64.000 caracteres |
| Recent non-user entries | 40 |

Se priorizan la primera/última intención del usuario y la evidencia reciente. El contenido largo se trunca por el centro con marcadores explícitos.

### Reutilización de sesión y delta

- La primera revisión envía el transcript completo acotado;
- tras una revisión válida se reutiliza la sesión y solo se envía el delta;
- las llamadas se serializan;
- cambios de branch, cwd, model, timeout o policy reconstruyen la sesión;
- un retry usa una sesión nueva y transcript completo;
- reload/shutdown limpia y cancela la revisión activa.

### Retry y deadline

| Función | Valor |
| --- | ---: |
| Máximo de attempts | 3 |
| Backoff inicial | 200 ms |
| Factor | 2× |
| Jitter | 0,9–1,1× |
| Deadline compartido por defecto | 90 segundos |
| Rango configurable | 1–300 segundos |

Se reintenta JSON de assessment inválido y errores transitorios clasificados por Pi: overload, rate limit, HTTP 5xx, fallos fetch/transport/stream. Quota/billing exhaustion no se reintenta. Startup, attempts, prompt y waits comparten un único deadline.

### Clasificación de resultados

- `allowed`: ejecutar;
- `denied`: bloquear y prohibir workaround;
- `timeout`: bloquear;
- `failure`: bloquear;
- `cancelled`: bloquear;
- `circuit-open`: bloquear sin llamar al reviewer.

### Circuit breaker

En una ejecución del agente Pi, 3 denegaciones explícitas consecutivas o 10 denegaciones entre las últimas 50 reviews abren el circuito. La ejecución se aborta y las acciones protegidas posteriores se bloquean inmediatamente.

### UI compacta

Muestra estados cortos: `reviewing`, `allowed`, `blocked`, `timed out`, `review failed`, `cancelled` y `circuit open`.

## Configuración

Global: `~/.pi/agent/approval-guardian.json`

Proyecto: `<project>/.pi/approval-guardian.json` (solo si el proyecto es trusted)

Variables:

```bash
PI_APPROVAL_GUARDIAN_MODEL
PI_APPROVAL_GUARDIAN_TIMEOUT_MS
PI_APPROVAL_GUARDIAN_POLICY
```

Model/timeout: `environment > trusted project > global > default`

Policy: `default + global + trusted project + environment`

## Instalación y actualización

```bash
pi install npm:pi-approval-guardian
pi install npm:pi-approval-guardian@0.2.0
pi update --extensions
pi remove npm:pi-approval-guardian
```

Git:

```bash
pi install git:github.com/mics8128/pi-approval-guardian@v0.2.0
```

## Comparación con Codex Guardian

| Capacidad | pi-approval-guardian | Codex Guardian |
| --- | --- | --- |
| Runtime | Extensión TypeScript para Pi | Subsistema nativo de Codex |
| Trigger | Todo bash + write/edit selectivos | Codex approval policy |
| Actions | Bash + archivos sensibles | Shell/exec/patch/network/MCP/permissions |
| Sandbox | No; solo approval gate | Integrado con permissions/sandbox |
| Session delta | Sí | Sí |
| Retry | Parse/provider transitorio, máx. 3 | Parse/session seleccionados, máx. 3 |
| Structured output | Prompt + parser | JSON Schema + parser |
| Analytics | No | Eventos/analytics nativos |

Este proyecto es **Codex Guardian-style**; no es un componente oficial de OpenAI ni idéntico a Codex.

## Seguridad, privacidad y límites

El proveedor reviewer recibe transcript/action acotados y puede leer archivos locales mediante tools read-only con permisos del usuario. Usa un proveedor confiable. El paquete no añade telemetry propia. Los comandos permitidos se ejecutan con los privilegios normales de Pi. La lista sensible es heurística, no un DLP completo. Las decisiones LLM son probabilísticas.

No se cubren `!`/`!!`, otros terminales, MCP, network, deployment, email, browser, subagent ni arbitrary custom tools.

## Desarrollo y publicación

Node.js 22.19+:

```bash
npm install
npm run check
npm run package:check
```

Para publicar en npm, consulta [docs/PUBLISHING.md](docs/PUBLISHING.md). El repositorio incluye un workflow de GitHub Actions para trusted publishing/OIDC.

## Licencias y avisos de terceros

El código original del proyecto usa la [licencia MIT](LICENSE). `src/policy.ts` contiene materiales modificados y adaptados de OpenAI Codex Guardian; esas partes siguen sujetas a la [licencia Apache 2.0](LICENSES/Apache-2.0.txt). Consulta [NOTICE](NOTICE) para la atribución y los cambios. Este proyecto no está afiliado ni respaldado por OpenAI.
