# pi-approval-guardian

**为 Pi 工具调用提供 fail-closed 自动审查。**

Agent 执行 shell、读取私密数据，或修改项目外／敏感文件前，会先交给隔离 reviewer model 评估。

[![npm version](https://img.shields.io/npm/v/pi-approval-guardian.svg)](https://www.npmjs.com/package/pi-approval-guardian)
[![CI](https://github.com/mics8128/pi-approval-guardian/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/pi-approval-guardian/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Pi package](https://img.shields.io/badge/Pi-package-6c5ce7)](https://pi.dev/packages/pi-approval-guardian)

[English](README.md) · [繁體中文](README.zh-TW.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

> [!IMPORTANT]
> Pi extension 以当前用户权限运行。安装前请检查源码。本包是 approval gate，不是操作系统 sandbox。

## 安装

```bash
pi install npm:pi-approval-guardian
```

默认使用 `openai-codex/codex-auto-review`，共享 deadline 为 90 秒。尚未登录官方 Codex provider 时执行：

```text
/login openai-codex
/reload
/approval-guardian
```

默认配置无需创建设置文件。

## 默认保护范围

| 工具／动作 | 默认审查范围 |
| --- | --- |
| `bash.command` | 全部审查 |
| `grep.path` | 全部审查，包括广泛或未指定路径的搜索 |
| `read.path` | 已知私密数据 |
| `find.path`／`ls.path` | 已知私密路径 |
| `write.path`／`edit.path` | 项目外或私密／敏感路径 |
| 其他具有字符串 `path` 的工具 | 默认 `private-only` |

普通项目内 source edit 不增加 reviewer 延迟。用户直接输入的 `!`／`!!`、其他终端或其他进程不受拦截。

## 工作方式

```text
Pi agent tool call
        │
        ├─ 普通动作 ───────────────────────────────► 执行
        │
        └─ 受保护动作
               │
               ▼
        隔离 Guardian reviewer
        普通审查：read · grep · find · ls
        私密数据审查：不提供工具
               │
          ┌────┴────┐
          ▼         ▼
        allow     其他结果
        执行       阻止
```

只有有效的 `outcome: "allow"` 才执行。Deny、timeout、无效输出、auth/model/provider failure、取消和 circuit open 全部 fail closed。

私密数据还要求 user transcript 中已有明确授权，并且 reviewer 返回 `user_authorization: "high"`。

## 私密数据规则

常见保护对象包括：

- `.env`、`.npmrc`、`.netrc`、`.pypirc`、Git credential、service-account、credential/secret 目录；
- SSH/GPG 密钥、cloud CLI、Kubernetes、Docker 身份验证；
- Browser login store、password manager、keychain/keyring、VPN、私密证书和 Terraform credential；
- Linux、macOS 和 Windows 的常见 credential 位置；
- Pi 的 auth、settings/model/Guardian/trust、API key、run/session/delegate history、memory、context/session database 和搜索索引。

整个 `.pi/` **不会**被视为私密。`.pi/agent/npm/node_modules/` 内已安装的包代码和 skill 文档，以及用户的 skill/agent/extension 源码，不会仅因为存放在 `.pi/` 下就要求私密读取授权；单个文件仍可能匹配其他规则。

读取和修改使用不同分类：project `.pi/skills`、`.pi/agents`、`.pi/extensions`、prompts、themes、chains 和包设置仍是敏感 mutation surface，因为修改它们可能改变 Pi 行为。读取时不会仅因 `.pi/` 位置被视为机密，但修改仍需审查。

分类使用 canonical path，并解析 symlink target。

## Reviewer 行为

- 使用独立于主对话的 model 和 in-memory session。
- 普通审查仅提供 `read`、`grep`、`find`、`ls`。
- 私密数据授权审查不提供任何工具。
- Reviewer 不获得 `bash`、`write`、`edit`。
- Transcript、文件、tool output 和 planned action 均视为不可信 evidence。
- 在共享 deadline 内，无效 assessment 和部分临时 provider failure 最多尝试 3 次。

连续 3 个明确 denial batch，或最近 50 个 review batch 累计 10 个 denial，会打开 circuit。同一条 assistant message 同时发出的 sibling tool calls 视为一个 batch，因此多个同步 denial 只计一次。

## 可选配置

Global：`~/.pi/agent/approval-guardian.json`

Trusted project：`<project>/.pi/approval-guardian.json`

```json
{
  "model": "openai-codex/codex-auto-review",
  "timeoutMs": 90000,
  "policy": "未经精确授权不得修改 production。"
}
```

也可使用已在 Pi model registry 注册并完成认证的自定义 reviewer channel。

默认 review matrix：

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

可用层级：`always`、`outside-or-private`、`private-only`、`off`。

Trusted project 只能加强 global 保护：

```text
off < private-only < outside-or-private < always
```

环境变量：`PI_APPROVAL_GUARDIAN_MODEL`、`PI_APPROVAL_GUARDIAN_TIMEOUT_MS`、`PI_APPROVAL_GUARDIAN_POLICY`。

Model/timeout precedence：`environment > trusted project > global > built-in default`。Policy 会合并 global、trusted project 和 environment 配置。

运行 `/approval-guardian rules` 可查看生效规则。

## 更新与移除

```bash
pi update npm:pi-approval-guardian
```

更新后运行 `/reload`。

```bash
pi remove npm:pi-approval-guardian
```

项目本地安装：

```bash
pi install -l npm:pi-approval-guardian
```

带版本号的 npm spec 会固定版本；更新 pin 时需要安装新的明确版本。

## 安全限制

- 获准动作仍以 Pi 的普通用户权限执行。
- Reviewer 判断具有概率性，可能出错。
- Reviewer provider 会收到 bounded transcript 和 planned-action metadata。
- 已授权的私密读取不会在主对话中自动遮罩。
- 路径规则是 heuristic，不能识别所有重命名或间接 secret。
- Shell 不会被完整解析为 AST，复杂间接读取可能漏判。
- Filesystem 状态可能在审查和执行之间发生变化。
- Pathless custom tools、MCP、network、browser、email、deployment 和 subagent 动作不会自动全部受保护。
- Reviewer/provider 不可用时，受保护动作会被阻止。

完整技术说明见 [docs/REFERENCE.md](docs/REFERENCE.md)。

## 开发

需要 Node.js 22.19 或更高版本。

```bash
npm install
npm run check
npm run package:check
pi -e .
```

维护者发布说明见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 许可与来源

原始项目代码使用 [MIT License](LICENSE)。修改和改编的 OpenAI Codex Guardian policy/prompt 材料仍适用 [Apache License 2.0](LICENSES/Apache-2.0.txt)，详见 [NOTICE](NOTICE)。

本项目受 Guardian 启发，与 OpenAI 无隶属或背书关系。
