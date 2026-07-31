# Agent Development Gateway 需求与架构设计

## 1. 项目定位

Agent Development Gateway 是一个围绕 Coding Agent 工作流构建的个人开发控制台。

它不试图替代 JetBrains、VS Code 等成熟 IDE，也不只是 Claude Code 的 GUI 外壳，而是负责连接并统一管理：

- 本地与远程开发主机
- 多种 Coding Agent Runtime（Claude Code、Codex、OpenCode）
- Agent 会话
- 项目上下文与长期记忆
- MCP、Skills、Plugins、Hooks 等能力
- 模型与 Provider 配置
- IDE 上下文
- Remote Control
- 终端、端口转发与远程开发环境

核心目标是让开发者在本地、远程开发机、IDE、终端和不同设备之间切换时，不再重复配置、重复解释项目上下文，也不再依赖不稳定的 TUI 屏幕状态。

> 保留 TUI 工作流的直接、自由和高信息密度，同时获得 GUI 的稳定、可恢复、可管理与跨环境协同能力。

---

## 2. 背景与问题

### 2.1 IDE 与 Agent 工作流割裂

当前常见工作方式是：

- JetBrains IDE 负责代码编辑、索引、调试和重构
- Claude Code TUI 负责 Agent 会话和工具调用
- SSH 终端负责连接远程开发机
- Skill、MCP、Memory、Provider 配置散落在不同机器和目录中

这些工具各自独立，开发者需要不断在窗口、项目、机器和会话之间切换，并手动完成上下文传递。

### 2.2 TUI 在 IDE 内嵌终端中不稳定

Claude Code 等 TUI 在持续流式输出、工具调用、打断和终端重绘时，可能出现：

- 内容重复
- 内容缺失
- 工具输出与正文错位
- 终端重新布局失败
- 打断后残留旧内容

独立终端可通过调整窗口尺寸强制重绘，但 JetBrains 内嵌终端通常需要退出全屏、调整工具窗口大小，再重新进入全屏，恢复成本很高。

### 2.3 本地与远程上下文不连续

开发者可能在以下环境间频繁切换：

- 本地项目
- 公司远程开发机
- 个人服务器
- 不同项目
- 不同 Claude Code 会话

Agent Memory、Skills、MCP 和个人工作习惯通常与具体机器或具体会话绑定。切换环境后，开发者需要重新向 Agent 解释：

- 项目架构
- 开发与构建方式
- 已知问题
- 个人偏好
- 当前任务背景
- 上一次会话结论

### 2.4 远程 Agent 缺少统一控制面

现有远程开发通常能解决 SSH、文件编辑和端口转发，但缺少统一的 Agent 工作流管理：

- 远程 Agent 会话管理
- 断线恢复
- 本地与远程上下文同步
- 本地 MCP 注入远程 Agent
- Skill 与 Plugin 部署
- 多客户端 Remote Control
- IDE 上下文桥接

### 2.5 不同 Coding Agent 的协议与能力割裂

Claude Code、Codex 和 OpenCode 都具备会话、工具调用、权限、流式输出等相似概念，但各自的协议、生命周期和特色能力不同：

- 会话创建、恢复、分叉和持久化语义不同
- 文本、推理、工具输入和工具输出的流式粒度不同
- 权限确认、沙箱模式和用户提问模型不同
- Plan、Todo、Subagent、Skills、Hooks、Plugin 等特性并不完全对应
- Runtime 的启动方式可能是 SDK、子进程协议或独立 HTTP Server
- 上游协议会独立升级，不能让客户端直接依赖某个 Runtime 的原始事件

如果 UI 直接绑定任意一个 Runtime，后续接入其他 Agent 时会产生大量条件分支；如果只抽取所有 Runtime 的最小交集，又会损失每个 Agent 最有价值的原生能力。

因此需要设计公共 Runtime Model 和 Adapter SDK：公共模型负责稳定的基准流程，各 Adapter 负责协议转换和特性扩展。

---

## 3. 产品目标

### 3.1 核心目标

1. 使用统一客户端管理本地与远程 Agent Server。
2. 保持项目上下文、个人 Memory 和工作流配置连续。
3. 将 Agent 输出从终端屏幕状态转换为可恢复的结构化事件流。
4. 支持本地、远程和移动设备控制同一 Agent 会话。
5. 与 JetBrains IDE 协作，但不替代 IDE。
6. 通过 Runtime Adapter 同时兼容 Claude Code、Codex 和 OpenCode。
7. 建立稳定的公共 Runtime Model，作为所有客户端和 Adapter 的基准流程。
8. 在公共模型之上保留每个 Runtime 的特色能力，不退化为最低公共能力集合。
9. 优先服务个人高频工作流，即使只有项目作者本人使用，也应产生持续价值。

### 3.2 非目标

第一阶段不计划：

- 重写完整 IDE
- 自研代码索引、重构和调试系统
- 支持 Claude Code、Codex、OpenCode 之外的全部 Coding Agent
- 构建企业级账号、权限和计费系统
- 直接公开到公网供多人共享
- 实现完整的云开发平台

---

## 4. 核心产品原则

### 4.1 Server 是核心，客户端只是视图

Agent Server 负责真实状态，Electron、Web、Mobile、TUI 和 IDE 插件只是客户端。

所有客户端都从 Server 的结构化状态和事件日志恢复界面，不依赖终端屏幕作为真实状态源。

### 4.2 本地与远程同构

同一套 Agent Server 应同时支持：

- 本机运行
- 通过 SSH 部署到远程机器运行
- 作为独立 daemon 长期运行

客户端只关心 Server Endpoint，不关心它位于本地还是远程。

### 4.3 IDE 与 Agent 解耦

JetBrains 继续负责：

- 代码编辑
- 索引与导航
- 重构
- 调试
- 语言级检查

Agent Development Gateway 负责：

- Agent 会话
- 工具调用与权限
- Markdown 流式渲染
- Memory、Skills、MCP
- 远程主机和端口
- Provider 配置
- Remote Control

IDE 插件只负责上下文桥接，不负责 Agent Runtime 生命周期。

### 4.4 Memory 可解释、可控制

长期记忆不应只是不可见的向量检索和自动注入。

每条记忆应具备：

- 来源
- 作用域
- 当前状态
- 最近更新时间
- 使用记录
- 是否过期
- 是否需要人工审核

Agent 可以建议新增 Memory，但长期记忆写入默认应由用户确认。

### 4.5 优先服务真实工作流

项目应从日常开发中的实际摩擦逐步演进，而不是一开始追求大而全。

### 4.6 公共模型是基准流程，不是最低公共能力

公共 Runtime Model 只统一稳定且语义明确的部分，例如：

- 会话生命周期
- 用户输入
- 文本与推理流
- 工具调用
- 权限和用户交互
- 任务状态
- 变更结果
- 用量与错误

每个 Runtime 的特色能力通过 Capability Negotiation、Extension Event 和专用 UI 保留。禁止为了统一接口而丢弃 Claude Code、Codex 或 OpenCode 的原生信息。

### 4.7 Adapter 是防腐层

客户端、Event Store、Memory 和 Remote Control 只依赖公共模型，不直接依赖上游 Runtime 协议。

Adapter 负责：

- 启动或连接对应 Runtime
- 将公共命令转换为原生命令
- 将原生事件映射为公共事件
- 暴露 Runtime Capability
- 保留无法标准化的扩展事件和原始引用
- 处理上游版本差异

上游 Runtime 升级时，应优先只修改对应 Adapter。

---

## 5. 总体架构

```text
┌────────────────────────────────────┐
│ Clients                            │
│                                    │
│ Electron / Web / Mobile / TUI      │
│ JetBrains Bridge                   │
└─────────────────┬──────────────────┘
                  │ HTTP / SSE / WS
                  ▼
┌────────────────────────────────────┐
│ Agent Server                       │
│ Node.js + TypeScript               │
│                                    │
│ Common Runtime Model               │
│ Runtime Adapter Host               │
│ Session Manager / Event Store      │
│ Permission / Interaction Manager   │
│ Memory / Skill / MCP Manager       │
│ File / Git / PTY                   │
└─────────────────┬──────────────────┘
                  │ Runtime Adapter API
       ┌──────────┼──────────┐
       ▼          ▼          ▼
┌────────────┐ ┌─────────┐ ┌──────────┐
│Claude Code │ │ Codex   │ │ OpenCode │
│Agent SDK   │ │AppServer│ │ Server   │
└────────────┘ └─────────┘ └──────────┘

Electron Main
      │
      ▼
Rust Remote Manager
├── SSH
├── Server Deployment
├── Tunnel Management
├── Version Upgrade
├── Health Check
└── Remote Process Supervision
```

---

## 6. 技术选型

### 6.1 Desktop Client

- Electron
- electron-vite
- Svelte 5
- TypeScript
- svatoms
- svmarkdown
- electron-builder

职责：

- Agent 会话 UI
- 工具调用与权限卡片
- 长对话渲染
- Host、Project、Session 管理
- Memory、Skill、MCP 管理
- Remote Control 配置
- 调用 Rust Remote Manager
- 少量系统级能力

### 6.2 Agent Server

- Node.js
- TypeScript
- Claude Agent SDK、Codex App Server、OpenCode Server/SDK
- Runtime Adapter Host 与公共事件模型
- HTTP API
- SSE 事件流
- WebSocket 用于 PTY 等高频双向通道
- SQLite 作为本地持久化
- Zod 或 Valibot 做运行时协议校验

选择 Node 的原因：

- 与 Claude Agent SDK 及其他 TypeScript/HTTP Runtime 接口贴合
- I/O 密集型场景开发体验好
- 方便管理子进程、流和网络连接
- 与前端共享 TypeScript 类型
- MCP 和多 Agent Runtime 生态接入方便
- 业务协议变化快，适合快速迭代

### 6.3 Rust Remote Manager

Rust 负责稳定的远程连接和生命周期层：

- SSH Config 解析
- ProxyJump 和跳板机
- SSH 长连接
- 远程平台与架构检测
- Server 安装和升级
- Server 启停与健康检查
- SSH 隧道维护
- 本地与远程端口转发
- 断线重连
- 远程进程监督

Rust 不理解 Claude 会话、Memory、Tool Call 等业务数据。

职责边界：

> Rust 负责让 Node Server 在任何目标机器上可靠地运行并保持连接；Node Server 负责 Agent 业务。

### 6.4 Monorepo

- pnpm workspace
- Turborepo

建议结构：

```text
apps/
├── desktop/
├── server/
├── web/
└── tui/                     # 后续

packages/
├── protocol/                 # Client 与 Server 网络协议
├── runtime-model/            # 公共 Agent 领域模型
├── adapter-sdk/              # Runtime Adapter 接口与测试工具
├── adapter-claude-code/
├── adapter-codex/
├── adapter-opencode/
├── server-client/
├── runtime-core/
├── provider-profiles/        # 模型端点与 CC Switch 配置
├── memory/
├── mcp-broker/
├── ui/
├── svatoms/
└── svmarkdown/

crates/
├── remote-manager/
├── gateway-cli/
└── native-utils/            # 后续
```

---

## 7. 核心领域模型

### 7.1 Host

表示 Agent Runtime 可以运行的机器。

```ts
interface Host {
  id: string
  name: string
  type: 'local' | 'ssh'
  status: 'offline' | 'connecting' | 'online' | 'error'
  platform?: string
  arch?: string
  serverVersion?: string
  protocolVersion?: number
}
```

### 7.2 Project

表示一个逻辑项目，同一个 Project 可以存在于多个 Host。

```ts
interface Project {
  id: string
  name: string
  repositories: ProjectLocation[]
  memoryProfileId?: string
  skillProfileId?: string
}

interface ProjectLocation {
  hostId: string
  path: string
}
```

### 7.3 Session

表示一个 Agent 会话。

```ts
interface AgentSession {
  id: string
  projectId: string
  hostId: string
  adapterId: 'claude-code' | 'codex' | 'opencode'
  runtimeSessionId?: string
  providerProfileId?: string
  status: 'idle' | 'running' | 'waiting' | 'interrupted' | 'error'
  createdAt: number
  updatedAt: number
  lastEventSequence: number
}
```

### 7.4 Capability

描述某种能力运行在哪台主机上。

```ts
type CapabilityPlacement = 'local' | 'remote' | 'hosted'

interface Capability {
  id: string
  name: string
  type: 'mcp' | 'credential' | 'proxy' | 'terminal' | 'port' | 'ide'
  placement: CapabilityPlacement
  hostId?: string
  status: 'online' | 'offline' | 'connecting' | 'error'
}
```

### 7.5 Memory

```ts
type MemoryScope =
  | 'personal'
  | 'organization'
  | 'project'
  | 'host'
  | 'session'

interface MemoryItem {
  id: string
  scope: MemoryScope
  scopeId?: string
  content: string
  source: string
  confidence?: number
  status: 'active' | 'archived' | 'needs-review'
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}
```

### 7.6 Provider Profile

```ts
interface ProviderProfile {
  id: string
  name: string
  source: 'native' | 'cc-switch' | 'environment' | 'custom'
  model?: string
  endpoint?: string
}
```

`ProviderProfile` 表示模型、认证和请求端点配置；它与 `RuntimeAdapter` 是两个正交维度。例如 Claude Code Adapter 可以使用官方 Anthropic 配置或 CC Switch 配置，OpenCode Adapter 也可以选择不同模型 Provider。

### 7.7 Runtime Adapter Descriptor

```ts
interface RuntimeAdapterDescriptor {
  id: 'claude-code' | 'codex' | 'opencode'
  displayName: string
  adapterVersion: string
  runtimeVersion?: string
  protocolVersion: string
  capabilities: RuntimeCapability[]
}

type RuntimeCapability =
  | 'session.resume'
  | 'session.fork'
  | 'input.queue'
  | 'output.partial_text'
  | 'output.partial_reasoning'
  | 'tool.input_stream'
  | 'interaction.permission'
  | 'interaction.question'
  | 'mode.plan'
  | 'task.todo'
  | 'agent.subagent'
  | 'extension.skills'
  | 'extension.hooks'
  | 'extension.plugins'
  | 'mcp.dynamic'
  | 'model.switch'
```

Capability 列表用于客户端决定显示哪些操作和专用视图，不能通过 Adapter 名称硬编码推断能力。

---

## 8. Agent Server 功能

### 8.1 会话管理

- 创建会话
- 恢复会话
- 中断会话
- 关闭会话
- 切换模型
- 切换权限模式
- 管理长期 Runtime Connection / Query
- 管理用户输入队列
- 支持多个并行会话

### 8.2 结构化事件

Server 通过 Runtime Adapter 将各 Agent 的原生事件转换为统一协议。

```ts
type RuntimeEvent =
  | AssistantTextDeltaEvent
  | ThinkingDeltaEvent
  | ToolStartedEvent
  | ToolUpdatedEvent
  | ToolCompletedEvent
  | PermissionRequestedEvent
  | QuestionRequestedEvent
  | PlanUpdatedEvent
  | TodoUpdatedEvent
  | SubagentUpdatedEvent
  | UsageUpdatedEvent
  | RuntimeExtensionEvent
  | SessionStatusChangedEvent
  | TurnCompletedEvent
  | RuntimeErrorEvent
```

每个事件必须包含：

```ts
interface RuntimeEventBase {
  id: number
  sessionId: string
  sequence: number
  timestamp: number
}
```

### 8.3 Event Store

采用 append-only event log：

- 客户端可根据 sequence 断线重连
- Renderer 崩溃后可重新构建 UI
- 支持 Web 和手机接管会话
- 支持回放真实会话做性能测试
- 支持未来的 Session Fork 和审计

### 8.4 权限系统

支持：

- Allow once
- Allow for session
- Deny
- Remember rule
- 已处理请求幂等保护
- 多客户端同时操作时只接受第一次决策

### 8.5 文件、Git 与终端

Server 提供：

- 文件读取和变更观察
- Git 状态与 Diff
- PTY 会话
- 命令执行
- 进程状态
- 开发端口发现

---

## 9. 多 Agent Runtime Adapter

### 9.1 目标

首批支持三种 Coding Agent Runtime：

- Claude Code
- Codex
- OpenCode

Gateway 不直接统一模型 API，而是统一完整的 Coding Agent Runtime，包括会话、工具、权限、文件修改、任务状态和扩展能力。

Adapter 层必须同时满足两个目标：

1. 让所有客户端基于同一个基准流程工作。
2. 保留各 Runtime 独有能力，并允许针对性优化交互。

### 9.2 基准流程

公共模型定义以下基准生命周期：

```text
Detect Runtime
→ Connect / Start Runtime
→ Inspect Capabilities
→ Create or Resume Session
→ Send User Input
→ Receive Structured Event Stream
→ Resolve Permission / Question
→ Interrupt or Continue
→ Complete Turn
→ Persist and Replay Events
→ Dispose Connection
```

所有 Adapter 应尽量映射这一流程。无法支持的命令必须通过 Capability 明确声明，而不是运行时静默忽略。

### 9.3 Adapter SDK

```ts
interface RuntimeAdapter {
  readonly descriptor: RuntimeAdapterDescriptor

  detect(context: RuntimeHostContext): Promise<RuntimeInstallation[]>
  connect(options: RuntimeConnectOptions): Promise<RuntimeConnection>
  createSession(input: CreateSessionInput): Promise<RuntimeSessionHandle>
  resumeSession(input: ResumeSessionInput): Promise<RuntimeSessionHandle>
  send(sessionId: string, input: UserInput): Promise<void>
  interrupt(sessionId: string): Promise<void>
  resolveInteraction(
    sessionId: string,
    resolution: InteractionResolution
  ): Promise<void>
  setModel?(sessionId: string, model: ModelSelection): Promise<void>
  disposeSession(sessionId: string): Promise<void>
  events(sessionId: string): AsyncIterable<AdapterEvent>
}
```

`ResumeSessionInput` 与 `ForkSessionInput` 必须携带 Runtime 权威状态中的
`projectPath`。Adapter 不得以 server 的 `process.cwd()` 或仅存在于内存中的映射
推断 provider session 所属项目；该约束保证本地/远程 host 以及 server 重启后的恢复一致。

Adapter SDK 还应提供：

- 公共 Schema 与类型
- Adapter 生命周期工具
- 日志和错误包装
- Event Mapper 辅助函数
- Capability 校验
- 录制与回放测试工具
- Contract Test Suite

### 9.4 公共 Runtime Model

公共模型至少包含以下实体：

```text
Session
Turn
Message
Content Block
Tool Call
Interaction Request
Task / Plan
Change Set
Usage
Runtime Error
```

建议以语义事件而不是具体 SDK 类型作为网络协议：

```ts
interface RuntimeEventEnvelope<TPayload = unknown> {
  id: number
  sequence: number
  sessionId: string
  adapterId: string
  type: string
  timestamp: number
  payload: TPayload
  nativeRef?: {
    runtimeVersion?: string
    eventType?: string
    eventId?: string
  }
}
```

基准事件包括：

```text
session.created / session.status_changed
turn.started / turn.completed
content.text.started / delta / completed
content.reasoning.started / delta / completed
tool.started / input_delta / output_delta / completed
interaction.permission_requested / resolved
interaction.question_requested / resolved
plan.updated
task.updated
changes.updated
usage.updated
runtime.warning / runtime.error
```

### 9.5 不退化为最低公共能力

公共模型之外，允许 Adapter 输出命名空间化扩展事件：

```ts
interface RuntimeExtensionEvent {
  type: 'runtime.extension'
  adapterId: string
  feature: string
  payload: unknown
}
```

示例：

```text
claude-code.subagent.progress
claude-code.plan_mode.changed
codex.sandbox.changed
codex.collaboration.updated
opencode.session.reverted
opencode.command.available
```

扩展机制遵循：

- 已知扩展由对应专用组件渲染
- 未知扩展保留在 Event Store，并在 Debug View 中可查看
- 不允许因公共模型无法表达而直接丢弃原始事件
- 原始 Payload 默认仅用于调试和重新投影，敏感信息需要脱敏或可配置关闭
- 客户端通过 Feature Registry 注册专用 UI，避免散落 `if (adapterId === ...)`

### 9.6 客户端渲染策略

客户端采用两级渲染：

```text
Common UI
├── Text / Reasoning
├── Tool Call
├── Permission / Question
├── Diff / Changes
├── Task / Plan
└── Usage / Error

Adapter Feature UI
├── Claude Code 专用交互
├── Codex 专用交互
└── OpenCode 专用交互
```

公共 UI 保证切换 Runtime 后仍有一致的基础体验；专用 UI 根据 Capability 和 Extension Event 提供更好的原生体验。

例如：

- 同一种工具调用使用统一卡片骨架
- 不同 Runtime 的审批模式显示不同操作项
- 支持 Plan 的 Runtime 显示 Plan 面板
- 支持 Session Fork/Revert 的 Runtime 显示对应历史操作
- 支持 Subagent 的 Runtime 显示独立 Agent 状态

### 9.7 首批 Adapter 接入方式

#### Claude Code Adapter

- 基于 Claude Agent SDK
- 使用长生命周期流式输入和结构化输出
- 映射 Session、Permission、AskUserQuestion、Tool、Plan、Todo、Subagent 等事件
- 保留 Skills、Hooks、Plugins 和 Claude Code 配置能力

#### Codex Adapter

- 优先接入 Codex App Server 的机器可读协议，而不是解析 TUI 文本
- 根据目标 Codex 版本生成或绑定对应 TypeScript / JSON Schema
- 映射 Thread/Turn、Item、Approval、Command Execution、Reasoning 和 Collaboration 等事件
- Adapter 必须处理 Codex 协议版本与 Capability 差异

#### OpenCode Adapter

- 优先连接 OpenCode Headless Server 或官方 SDK
- 使用其 HTTP/OpenAPI 接口和事件流
- 映射 Session、Message Part、Permission、Todo、Diff、MCP、Provider 和 Agent 等能力
- 可以连接 Gateway 管理的 OpenCode Server，也可以连接用户已有实例

### 9.8 版本与兼容策略

Adapter 版本、Gateway 协议版本和上游 Runtime 版本必须分别记录：

```ts
interface AdapterRuntimeVersion {
  adapterVersion: string
  gatewayProtocolVersion: number
  upstreamRuntimeVersion: string
  upstreamProtocolVersion?: string
}
```

要求：

- 每次连接先完成版本握手和 Capability 探测
- Adapter 不假设某项上游能力永久存在
- 关键上游版本使用录制事件做回归测试
- 上游协议变更只影响对应 Adapter，不修改公共客户端协议
- 无法兼容时给出明确升级、降级或禁用提示

### 9.9 Adapter Contract Tests

每个 Adapter 至少通过以下统一测试：

- Runtime 检测和启动
- 创建会话
- 发送文本并接收流式输出
- 工具调用开始、进度与完成
- 权限请求与处理
- 用户问题与回答（若支持）
- 中断任务
- 会话恢复（若支持）
- 错误归一化
- 断线与重连
- 原始事件录制和回放一致性

此外，每个 Adapter 应维护专用 Feature Tests，防止为了通过公共测试而破坏原生能力。

---

## 10. Remote Development

### 10.1 远程连接流程

```text
选择 SSH Host
→ Rust Remote Manager 建立连接
→ 检测目标平台与架构
→ 查询远程 Server 版本
→ 缺失或不兼容时自动部署
→ 启动或连接 Remote Server Daemon
→ 建立 SSH Local Forwarding
→ Electron 连接本地映射 Endpoint
```

### 10.2 Server 部署目录

```text
~/.agent-development-gateway/
├── runtime/
│   └── node/
├── versions/
│   ├── 0.1.0/
│   └── 0.2.0/
├── current -> versions/0.2.0
├── data/
├── logs/
└── run/
```

### 10.3 远程 Server Daemon

远程 Server 应独立于 SSH 会话运行。

目标：

- SSH 断线时 Agent 继续执行
- 客户端重连后补齐缺失事件
- Electron 关闭后仍可运行任务
- 支持 Web 或 Mobile Remote Control

### 10.4 端口转发

支持两类端口：

```text
Remote → Local
远程 Vite / Debug / HTTP 服务映射到本地

Local → Remote
本地 MCP / Proxy 等能力映射给远程 Server
```

Server 负责发现和声明端口，Rust Remote Manager 负责真正建立隧道。

---

## 11. MCP 管理

### 11.1 MCP Placement

每个 MCP 必须明确运行位置：

```ts
type McpPlacement = 'local' | 'remote' | 'hosted'
```

示例：

- 浏览器、本地应用、系统钥匙串：local
- 远程文件系统、构建系统、内网服务：remote
- GitHub、Notion 等公共服务：hosted

### 11.2 本地 MCP 注入远程 Agent

HTTP MCP：

```text
Remote Server
→ SSH Reverse Tunnel
→ Local HTTP MCP
```

stdio MCP：

```text
Remote Server
→ HTTP MCP
→ SSH Reverse Tunnel
→ Local MCP Broker
→ stdio MCP Process
```

Local MCP Broker 负责将 stdio MCP 包装成可通过网络访问的 MCP 服务。

### 11.3 可用性状态

本地 MCP 可能因为电脑休眠或网络断开而不可用。

客户端需要显示：

- Online
- Offline
- Reconnecting
- Error

Agent 调用离线能力时应得到明确错误，而不是静默失败。

---

## 12. Skill、Plugin 与配置管理

### 12.1 Skill Library

客户端维护统一 Skill Library，并支持部署到：

- 本地用户级目录
- 远程用户级目录
- 本地项目目录
- 远程项目目录
- 当前会话临时目录

### 12.2 版本与 Diff

应显示：

- 本地版本
- 远程版本
- 项目版本
- 是否存在差异
- 查看 Diff
- 单向同步
- 覆盖策略

### 12.3 扩展范围

后续统一管理：

- Skills
- Agents
- MCP
- Hooks
- Plugins
- Provider Profiles

---

## 13. Agent Memory

### 13.1 记忆层级

- Personal：个人长期偏好与工作方式
- Organization：公司开发流程、规范和基础设施
- Project：项目架构、技术决策和已知问题
- Host：某台机器的路径、工具和环境信息
- Session：当前任务的临时上下文

### 13.2 注入策略

支持：

- Always：始终注入稳定约束
- Retrieval：按需检索历史知识
- Tool：Agent 主动查询 Memory
- Review：会话结束后生成候选记忆，等待人工确认

### 13.3 记忆写入

默认不允许 Agent 无审核地持续写入长期记忆。

推荐流程：

```text
会话结束
→ Agent 提取候选长期信息
→ 用户逐条审核
→ 选择作用域
→ 写入 Memory Store
```

### 13.4 上下文组合

创建会话时组合：

```text
Personal Profile
+ Organization Profile
+ Host Context
+ Project Context
+ Session Context
```

---

## 14. Electron 客户端

### 14.1 主要界面

- Host 列表
- Project 列表
- Session 列表
- Conversation
- Tool Calls
- Permissions
- Changes / Diff
- Terminal
- Ports
- Memory
- Skills / MCP / Plugins
- Provider Switcher

### 14.2 交互风格

遵循 TUI 精神，而非传统聊天软件设计：

- 高信息密度
- 键盘优先
- 命令面板
- 快速切换项目和会话
- 可折叠工具输出
- 结构化权限卡片
- 最少弹窗
- 支持 Vim 风格浏览快捷键

### 14.3 svmarkdown

用于 AI 回复的流式 Markdown 渲染。

优化方向：

- Append-only 增量解析
- Committed Blocks 与 Active Tail 分离
- 稳定 Node Identity
- Tail-only Reconciliation
- 流式阶段延迟代码高亮
- 长会话 content-visibility
- 流结束后完整校验解析

### 14.4 svatoms

用于模型状态切片订阅：

- SessionList 只订阅会话摘要
- Conversation 只订阅 Message ID
- MessageItem 只订阅 Block ID
- MarkdownBlock 只订阅对应流
- ToolBlock 只订阅对应工具状态

避免当前流式消息更新时引发整个会话树重算。

---

## 15. JetBrains IDE Bridge

IDE 插件不是核心运行时，只负责上下文桥接。

第一阶段功能：

- 绑定当前项目到 Gateway Project
- 发送当前文件
- 发送选区
- 发送诊断信息
- 从 Agent UI 跳转到文件和行号
- 使用 IDE 原生 Diff 查看修改
- 打开对应终端
- 显示 Agent 任务完成通知

插件退出、重载或崩溃不能影响 Agent 会话运行。

---

## 16. Remote Control

### 16.1 客户端

- Electron
- Web
- Mobile Web
- 后续原生移动端

### 16.2 功能

- 查看活动会话
- 查看工具调用
- 批准或拒绝权限
- 回答 AskUserQuestion
- 发送后续消息
- 中断任务
- 查看 Diff 与 Todo
- 接收任务完成通知

### 16.3 多客户端控制

角色可分为：

- Observer：只读
- Controller：可发送消息和处理普通交互
- Owner：可修改权限、关闭会话和管理 Host

权限请求使用幂等 resolution，防止多个客户端重复处理。

---

## 17. 通信协议

### 17.1 HTTP

用于离散命令：

```text
POST /api/sessions
POST /api/sessions/:id/messages
POST /api/sessions/:id/interrupt
POST /api/permissions/:id/resolve
POST /api/questions/:id/resolve
POST /api/hosts/:id/ports
```

### 17.2 SSE

用于 Server 到客户端的 Agent 事件流：

```text
GET /api/sessions/:id/events?after=<sequence>
```

支持：

- Last-Event-ID
- 断线重连
- 历史事件补发
- 多客户端订阅

### 17.3 WebSocket

仅用于：

- PTY
- 高频双向流
- 必要的低延迟交互

### 17.4 Rust Remote Manager RPC

Electron Main 与 Rust 子进程通过 NDJSON 通信。

请求：

```json
{"id":"1","method":"connect","params":{"host":"company-dev"}}
```

响应：

```json
{"id":"1","result":{"localEndpoint":"http://127.0.0.1:58124"}}
```

事件：

```json
{"event":"connection_status","data":{"hostId":"company-dev","status":"reconnecting"}}
```

---

## 18. 协议兼容与升级

Server 握手返回：

```ts
interface ServerHandshake {
  protocolVersion: number
  serverVersion: string
  platform: string
  arch: string
  capabilities: string[]
  adapters: RuntimeAdapterDescriptor[]
}
```

客户端根据 protocolVersion 和 capabilities 判断是否兼容。

不要求客户端与 Server 包版本完全一致，但协议不兼容时应提示并自动升级远端 Server。

---

## 19. 安全要求

### 19.1 本地模式

- Server 默认只监听 127.0.0.1
- 使用随机端口
- 使用短期随机 Token
- 校验 Origin
- 默认关闭任意 CORS

### 19.2 远程模式

- Remote Server 只监听远程 127.0.0.1
- 通过 SSH Local Forwarding 访问
- 不直接暴露公网端口
- Server Token 与 SSH Host 绑定
- 支持会话和设备撤销

### 19.3 Remote Control

公开网络接入前至少需要：

- TLS
- 强认证
- 设备授权与撤销
- 操作审计
- 项目目录白名单
- 权限请求二次确认

第一阶段优先通过 Tailscale、WireGuard 或 Cloudflare Tunnel 等可信网络接入，而不是直接开放公网服务。

---

## 20. MVP

第一阶段只证明一条完整链路。

### 20.1 MVP 必须完成

1. Electron 连接本地 Node Server。
2. 建立公共 Runtime Model、Adapter SDK 和 Adapter Contract Test。
3. Claude Code Adapter 使用 Claude Agent SDK 创建长生命周期会话。
4. 支持流式 Markdown、工具调用、权限请求和中断。
5. 使用结构化 Event Store 保存会话状态。
6. 客户端刷新后可恢复当前会话。
7. Rust Remote Manager 可通过 SSH 部署并启动同一套 Server。
8. Electron 通过 SSH Tunnel 连接远程 Server。
9. 支持远程项目会话。
10. 支持一个简单的 Personal + Project Memory Profile。
11. 支持远程会话断线重连和事件补发。

### 20.2 MVP 暂缓

- stdio MCP 远程代理
- 完整 Skill Marketplace
- Claude Code 之外的 Adapter 可在 MVP 后接入，但公共模型不得绑定 Claude Code
- JetBrains 深度集成
- 原生移动端
- TUI Client
- 自动端口发现
- 企业级权限模型

---

## 21. 后续路线

### Phase 1：公共模型与本地 Claude Code 客户端

- Common Runtime Model
- Adapter SDK 与 Contract Tests
- Claude Code Adapter
- Electron + Svelte
- Local Server
- 工具和权限
- Event Store
- svmarkdown 性能优化

### Phase 2：远程开发

- Rust Remote Manager
- SSH 部署
- Server Daemon
- 隧道与断线恢复
- Remote Project

### Phase 3：多 Runtime 与 Context

- Codex Adapter
- OpenCode Adapter
- Adapter 专用 Feature UI
- 自研 Agent Memory
- Skill Library
- Provider Profiles
- CC Switch Adapter
- MCP Placement

### Phase 4：IDE 协同

- JetBrains Bridge
- 当前文件、选区和诊断
- IDE 原生 Diff
- 文件定位

### Phase 5：Remote Control

- Web Client
- Mobile Web
- 多客户端控制
- 通知

### Phase 6：多客户端与扩展

- TUI Client
- 更多 Runtime Adapter
- Plugin SDK
- Workspace Automation

---

## 22. 成功标准

这个项目的第一成功标准不是用户量，而是项目作者本人愿意每天使用。

可衡量的结果包括：

- 不再依赖 JetBrains 内嵌终端运行 Claude Code TUI
- 本地和远程项目切换时不需要重复解释上下文
- 会话在断线、刷新和设备切换后仍可恢复
- Memory、Skill、MCP 和 Provider 配置可统一管理
- IDE 与 Agent 之间的上下文传递成本显著降低
- 远程任务可在 Electron 关闭后继续运行
- 手机或 Web 可查看和控制远程会话
- 长对话流式渲染稳定，不因历史内容增长明显卡顿

---

## 23. 一句话定义

> Agent Development Gateway 是一个连接开发者、IDE、开发主机、长期上下文与多种 Coding Agent Runtime 的本地优先开发工作台。
