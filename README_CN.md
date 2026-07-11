# Codex Lark Plugin

[![docs](https://img.shields.io/badge/docs-English-blue)](README.md)
[![version](https://img.shields.io/badge/version-1.19.1-informational)](CHANGELOG.md)
[![node](https://img.shields.io/badge/node-%3E%3D20.0.0-339933?logo=node.js&logoColor=white)](package.json)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

通过飞书（Lark）与 Codex 实时聊天。本地文件记忆、定时任务、富媒体支持。

---

## 工作原理

```
飞书用户 ──> 飞书开放平台 ──WebSocket──> codex-lark-plugin (MCP Server) ──> Codex
                                                  <── 回复 / 编辑 / 表情 ──<
```

本插件以 MCP Server 形式运行在 Codex 内部。通过 WebSocket 连接飞书开放平台（无需公网回调地址），接收消息后注入记忆上下文，转发给 Codex 处理。Codex 通过内置 MCP 工具进行回复、编辑、加表情、下载附件、回复文档评论，以及管理记忆与定时任务。lark-cli 的各项技能负责处理更广泛的飞书 API 操作（日历、文档、表格、任务、通讯录等）。

---

## 功能特性

### 消息接收

- 私聊消息和群聊 @机器人 消息
- 飞书文档评论 @机器人 事件会携带选中文本、父评论、回复正文和文档标题上下文进入 Codex
- 富文本、图片、文件、音视频等多种消息类型
- **Codex 会话连续性**：exec delivery 会为每个飞书 chat/thread 保存并恢复一个 Codex session，多轮对话可以复用 Codex 原生 session 上下文
- 引用回复自动合并上下文，并可读取被引用交互卡片中的可见文本
- 附件下载到本地收件箱
- 用户对 bot 消息添加的 emoji reaction 会作为正常交互 turn 送入 Codex，并携带被 reaction 的 bot 消息上下文；模型可继续流程、重试、追问、回复，或返回 `[LARK_NO_REPLY]`

### 消息回复

- 文字、图片（不超过 10 MB）、文件（不超过 30 MB）
- 较长的 Lark/Feishu 回复会默认倾向使用轻量 Markdown 结构来提升可扫读性；短回复、代码、日志、JSON、diff、命令输出、action block 和用户显式指定的格式保持不变
- **卡片渲染**：简单回复保持可复制文本；包含标题、代码块、Markdown 表格、多项列表或结构化段落的富 Markdown 会自动渲染为 body-only 飞书 Schema 2.0 交互式卡片，默认不生成 header/template。传 `format='text'` 可强制纯文本，`format='card'` 可强制生成卡片，也支持 raw `card` payload。生成卡片时可选 `footer` 底部小字脚注；Codex exec 生成的卡片回复可自动追加紧凑运行指标 footer
- 编辑已发送的消息
- 回复已有飞书文档评论线程，或在当前文档中新建顶级评论
- 文档评论 @bot 事件会收到可配置的持久 emoji 确认回应（默认 `THUMBSUP`）
- 表情回复
- 长文本自动按段落、换行、空格分段发送

### 记忆系统

- 三层架构：Buffer（短期）/ 情景记忆（中期）/ 语义记忆（长期）
- 自动蒸馏：对话静默超时后自动触发摘要；系统触发的 flush turn 是后台行为，exec 失败只记日志，不会作为可见飞书回复发送
- 可选阶段 2：从近期 episode 提取用户画像，默认关闭，并受最小 episode 数、按用户冷却、L1/L2 安全网和审计日志约束
- 本地 markdown 文件存储，路径 `~/.codex/channels/lark/memories/`
- 用户 profile 分层存储（v0.10.0+）：`public.md`（@mention 可见）/ `private.md`（仅 owner 可见）

### 隐私与安全（v0.9.0+）

- **服务端派生的调用者身份**：敏感工具（`save_memory` / `save_skill` / `create_job` / `list_jobs` / `update_job` / `delete_job` / `what_do_you_know` / `forget_memory` / `run_local_cli_tool` / `manage_access_control`）从飞书事件流派生调用者身份，不信任工具参数——社工提示无法假冒他人操作
- **文档评论绑定**：文档评论工具只能在 `doc:<file_token>` 触发的 turn 中调用，必须携带当前 `thread_id`，并会拒绝 prompt 注入造成的 `doc_token` 不匹配，避免把评论发到其他文档
- **记忆透明度（v0.11.0+）**：`what_do_you_know` 列出 bot 记住了调用者的哪些信息（按当前 chat 可见性过滤）；`forget_memory` 按 hash 删除特定条目，可选 `promote_to_rule` 把删除动作沉淀为 `privacy-rules.md` 中的规则——**自学习闭环**让误判随使用递减
- **追加式审计日志（v0.11.0+）**：`~/.codex/channels/lark/logs/audit.log` 以紧凑文本行记录每次敏感工具调用（时间 / log id / `audit` / 工具名 / 结果 / 调用者 / 脱敏参数），运营者可事后回溯查看本机上发生了什么
- **终端技能默认脱敏（v0.11.0+）**：`$lark:jobs` 默认不展示 prompt 正文，需显式要求 verbose；破坏性操作需交互确认
- **分层 profile 记忆（v0.10.0+）**：每个用户的 profile 拆成 `public.md`（他人 @mention 时可见）和 `private.md`（仅 owner 可见）。私聊里的偏好不会通过 @mention 注入泄露到群聊
- **L1/L2/L3 分类体系**（v0.10.0+）：硬编码的 regex + 关键词规则拦截手机/凭据/敏感中文词。邮箱**不在** L1——本插件定位为**工作 IM 场景**，工作邮箱常通过签名和通讯录公开；个人使用的部署可以在自己的 `privacy-rules.md` 里加一条 "Always private" 规则专门归类邮箱。用户可编辑的 `privacy-rules.md` 处理个人和组织特有场景；LLM 处理灰色地带。`parseTieredProfile` 在 LLM 分类之上加 L1 兜底——误判为 public 的凭据被强制归 private
- **老版本 profile 迁移尊重 L2 规则（v0.11.1+）**：操作者在升级前（或同步）编辑 `privacy-rules.md`，`## Always private` 段的短语会以 case-insensitive 子串方式在迁移时生效——组织内项目代号、客户名、人名提及等 L1 无法覆盖的内容会被直接分到 `private.md`
- **记忆硬化**：public profile 写入会在服务端经过 L1 和 deterministic L2 always-private 规则检查，敏感 spillover 会转写到 `private.md`；同一用户的 profile 操作串行化；已存记忆、引用、flush buffer、cron prompt、Codex exec prompt、L2 规则在 prompt 中都以 untrusted data 包裹；episode 文件受 `LARK_MAX_EPISODE_BYTES` 限制
- **`list_jobs` 可见性过滤**：群聊里只能看到 `target_chat_id` 匹配本群的 job（非 owner 看不到 prompt 正文）；私聊里只能看到自己建的 job。群成员不再能互相窥探定时任务
- **仅 owner 可改**：`update_job` / `delete_job` 要求 `caller == created_by`
- **CronJob 身份隔离**：每次 cronjob 触发使用独立 `thread_id`，不会和同一 chat 的真人消息串线
- **终端回退**：`$lark:jobs` 等终端技能仅在没有活跃 Lark channel turn 时，通过保留的 `__terminal__` chat id 回退到 `LARK_OWNER_OPEN_ID`

### 定时任务（CronJob）

- **两种任务类型**：`message` 确定性发送固定内容；`prompt` 复用普通聊天同一条 `codex exec` 交付路径
- Prompt job 失败时会包含结构化 run 诊断：run 元数据、可观测阶段耗时、仅用于诊断的 progress，以及可用时脱敏后的 `codex exec` stdout/stderr tail
- 标准 cron 表达式 + 简化别名（`every 30m`、`daily at 09:00`、`weekdays at 17:00`）
- 通过飞书聊天或 `$lark:jobs` skill 创建和管理任务
- 崩溃恢复：重启后自动补执行错过的任务
- 任务以 JSON 文件存储在 `~/.codex/channels/lark/jobs/`

### 可靠性

- 每个会话独立消息队列，同一会话按序处理
- Feishu API 热路径使用统一 retry/timeout wrapper：发送、编辑、reaction、元数据读取、下载都会受控重试
- 附件/图片下载直接流式写盘，并有可配置大小上限和超时
- 依赖审计入口：`npm run audit:deps`
- 单实例锁，防止重复启动
- 发送者/群聊白名单过滤（两个列表同时配置时为 OR 关系）
- 定时任务崩溃恢复（错过的任务重启后补执行一次）

---

## 快速开始

### 第 1 步：创建飞书机器人

1. 前往[飞书开放平台](https://open.feishu.cn/)创建自建应用
2. 启用「机器人」能力
3. 添加以下权限：`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message:send_as_bot`、`im:resource`、`im:message.reactions:write`、`docs:document.comment:read`、`docs:document.comment:create`、`drive:drive.metadata:readonly`
4. 在「事件订阅」中启用 WebSocket 模式，并订阅 `im.message.receive_v1`、`im.message.reaction.created_v1`、`drive.notice.comment_add_v1`
5. 获取 App ID 和 App Secret

### 第 2 步：安装插件

**通过插件市场安装（推荐）：**

在终端执行以下命令：

```bash
codex plugin marketplace add https://github.com/IS908/codex-lark-plugin.git
codex plugin add lark@codex-lark-plugin
```

安装后新开一个 Codex session，让插件的 skills 和 MCP server 生效。

**从源码安装（开发用）：**

```bash
git clone https://github.com/IS908/codex-lark-plugin.git
cd codex-lark-plugin
npm install
```

源码开发时，将 Codex 指向这个插件目录，让它读取 `.codex-plugin/plugin.json`
和 `.mcp.json`。也可以先直接运行 MCP server 的本地 smoke test：

```bash
npm start -- --dry-run
```

dry-run 可在没有真实 Lark 凭证时验证本地模块 wiring；真实启动仍需要在 `~/.codex/channels/lark/.env` 或 shell 环境中配置 `LARK_APP_ID` 和 `LARK_APP_SECRET`。

可选：安装 [lark-cli](https://github.com/larksuite/cli) 以获取完整飞书 API 能力（日历、文档、表格、任务、通讯录等）：

```bash
npm install -g @larksuite/cli
npx skills add larksuite/cli -y -g
```

### 第 3 步：配置凭据

**交互式配置（推荐）：**

```text
$lark:configure setup
```

引导式完成所有配置 -- 凭据、访问过滤、记忆参数调优。

**快速配置：**

```text
$lark:configure <app_id> <app_secret>
```

**手动配置：**

```bash
mkdir -p ~/.codex/channels/lark
cat > ~/.codex/channels/lark/.env << 'EOF'
LARK_APP_ID=cli_your_app_id
LARK_APP_SECRET=your_app_secret
EOF
```

### 第 4 步：启动

```bash
# 本地直接启动 MCP server：
bash scripts/start.sh

# 或使用 npm：
npm start
```

### 更新插件

**插件市场：**

```bash
codex plugin marketplace add https://github.com/IS908/codex-lark-plugin.git
codex plugin add lark@codex-lark-plugin
```

重新安装后新开一个 Codex session。

**从源码：**

```bash
cd codex-lark-plugin
git pull
npm install
```

`~/.codex/channels/lark/.env` 中的配置不受更新影响。更新后需新开 Codex session 或重启 Codex 生效。

查看当前版本：

```bash
node -e "console.log(require('./package.json').version)"
```

### 发布到 GitHub

首次公开 push 前，先确认仓库元信息，并确保本地凭据没有进入暂存区：

```bash
npm install
npm test
npm run check:release-version
npm run audit:deps
git status --short --ignored
```

仓库会有意提交 `.env.example`、`.mcp.json`、`.codex-plugin/`、`.agents/plugins/marketplace.json` 和 `plugins/lark` 插件市场包装目录。生成产物、依赖、本地 `.env*` 文件、日志、编辑器/工具状态会由 `.gitignore` 忽略。

发布版本检查清单：

- 同步更新 `package.json`、`package-lock.json`、`plugins/lark/package.json` 和 `plugins/lark/package-lock.json`。
- 同步更新 `.codex-plugin/plugin.json` 和 `plugins/lark/.codex-plugin/plugin.json`；Codex 会根据 manifest version 选择插件 runtime cache 目录，manifest 版本滞后可能导致新 package 仍从旧 cache 运行。
- 更新 README 徽章和 `CHANGELOG.md` release heading。
- 打 tag 前运行 `npm run check:release-version`。MCP server-info version 会在启动时读取 `package.json`，因此 package 版本正确后运行时版本会自动跟随。

新仓库可以这样初始化并发布：

```bash
git init
git add .
git commit -m "Initial release v1.0.0"
git branch -M main
git remote add origin https://github.com/IS908/codex-lark-plugin.git
git push -u origin main
git tag v1.0.0
git push origin v1.0.0
```

如果你要发布到不同的 GitHub owner 或仓库名，打 tag 前同步更新 `README.md`、`README_CN.md`、`.codex-plugin/plugin.json` 和 `plugins/lark/.codex-plugin/plugin.json` 中的 URL。

---

## 记忆系统

### 三层架构

| 层级 | 名称 | 作用域 | 注入方式 | 存储位置 |
|------|------|--------|----------|----------|
| Layer 1 | Buffer（短期/工作记忆） | 当前 session，按 chatId 隔离 | 直接处理（Codex 直接读取这些消息） | 内存 `Map<chatId, Message[]>` |
| Layer 2 | 情景记忆（中期记忆） | 持久化，按 chatId / threadId 隔离 | 冷注入 -- 关键词/语义搜索取 top-N | `episodes/<chatId>/<timestamp>.md` |
| Layer 3 | 语义记忆（长期记忆） | Profile 按 userId 隔离；Skill 全局共享 | 热注入（Profile 始终注入）+ 冷注入（Skill 搜索后注入） | `profiles/<userId>.md`、`skills/<name>.md` |

### 隔离模型

| 记忆类型 | 作用域 | 可见范围 |
|----------|--------|----------|
| 用户画像 (Profile) | 按 userId | 仅在该用户发送消息或被 @提及 时注入 |
| 话题情景 (Thread Episode) | 按 chatId + threadId | 仅在该话题内的消息中注入 |
| 会话情景 (Chat Episode) | 按 chatId | 该会话内所有参与者共享 |
| 技能 (Skill) | 全局 | 可被任意用户/会话搜索和注入 |

同一个 `(chat_id, thread_id)` 下未变化的记忆块会在
`LARK_MEMORY_DEDUP_WINDOW_MS` 窗口内去重（默认 30 分钟）。Profile 被抑制时会留下一个
`<memory_context_omitted>` 小占位；episode / skill 会直接省略，直到内容变化或窗口过期。
如果投递给 Codex 失败，该 scope 的去重状态会失效，下一轮重新注入完整上下文。

### 蒸馏管道

| 阶段 | 描述 | 状态 |
|------|------|------|
| 阶段 1：Buffer -> Episode（对话蒸馏） | 静默超时或 Codex 主动调用 `save_memory` 时触发。Codex 将原始对话压缩为 3-5 句摘要，过滤寒暄和无效信息 | MVP 已实现 |
| 阶段 2：Episodes -> Profile（事实提取） | 可选启用；针对活跃用户从近期 episode 提取画像事实，受最小 episode 数、按用户冷却、L1/L2 安全网和审计日志约束 | 门控可用 |
| 阶段 3：Episode 压缩/归档 | 某会话下情景文件过多时，将最旧的合并为历史概要，删除已合并文件 | 后续迭代 |

---

## 配置参考

### 必填

| 变量 | 说明 |
|------|------|
| `LARK_APP_ID` | 飞书应用 App ID |
| `LARK_APP_SECRET` | 飞书应用 App Secret |

### 运行时访问控制

访问控制改由
`~/.codex/channels/lark/runtime-config/access-control.json` 管理，不再放在
`.env` 中。`LARK_OWNER_OPEN_ID` 仍是不可变的信任根；只有 owner 可以通过
飞书里的 `/access` 或 `manage_access_control` 工具修改运行时访问控制，且
每次尝试都会写入审计日志。

```json
{
  "version": 1,
  "revision": 3,
  "updated_at": "2026-07-11T00:00:00.000Z",
  "updated_by": "ou_owner",
  "allowed_user_ids": ["ou_xxx"],
  "allowed_chat_ids": ["oc_xxx"],
  "group_no_mention_chat_ids": ["oc_trusted"]
}
```

文件不存在时表示没有用户/群聊白名单，普通消息放行，同时没有任何群开启免
@ 触发。启动时只加载一次；owner 修改会原子持久化并立即更新内存快照。
直接改文件需要重启后生效；无效文件或失败的修改不会替换 last-known-good
快照。

白名单语义仍是 OR：`allowed_user_ids` 和 `allowed_chat_ids` 都非空时，
发送者匹配或群聊匹配任一条件即放行。文档评论事件只按
`allowed_user_ids` 过滤，因为合成的 `doc:<file_token>` chat id 无法匹配
真实群聊。

默认情况下，群聊消息仍然必须显式 @bot 才会触发。把群聊 chat id 加到
`group_no_mention_chat_ids` 后，该可信群可以免 @ 触发。未 @ 的 top-level
消息只有像明确问题或命令时才会进入；这些群里的 thread reply 可以进入
Codex，并带上 `unmentioned_group_trigger=true`，prompt 会要求 Codex 对
低置信或无关消息返回 `[LARK_NO_REPLY]`。

owner-only 飞书命令：

```text
/access
/access add user ou_xxx
/access remove user ou_xxx
/access add chat oc_xxx
/access remove chat oc_xxx
/access add chat current
/access remove chat here
/access add no-mention oc_xxx
/access remove no-mention oc_xxx
```

`current`、`here`、`当前群聊`、`当前群聊id` 会由 bridge 根据当前飞书事件解析，
不会交给模型猜测。写入 chat 类列表前必须满足 `oc_...` 格式，并通过飞书
`chat.get` 可访问性校验。

### 可选 —— 消息

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LARK_TEXT_CHUNK_LIMIT` | `4000` | 单条消息最大字符数 |
| `LARK_QUEUE_HANDLER_TIMEOUT_MS` | `LARK_CODEX_EXEC_TIMEOUT_MS + 60000` | 每个 thread 的队列兜底超时时间（毫秒）。`0` 表示关闭兜底；小于 `LARK_CODEX_EXEC_TIMEOUT_MS + 60000` 的正数会自动抬高到该下限，确保常规 exec 超时由 `codex exec` 层负责并能发送失败回复。 |
| `LARK_REPLY_OBLIGATION_TIMEOUT_MS` | `max(60000, LARK_CODEX_EXEC_TIMEOUT_MS + 60000)` | 可见回复或 defer 前的最长等待时间，超时后记录未满足的 Lark turn |
| `LARK_CODEX_EXEC_COMMAND` | `codex` | exec delivery 使用的 Codex CLI 命令 |
| `LARK_CODEX_EXEC_CWD` | `~/.codex/channels/lark/codex-exec-workdir` | `codex exec` 的工作目录；保持目录内没有 `.mcp.json`，避免递归加载当前 Lark MCP server |
| `LARK_CODEX_EXEC_TIMEOUT_MS` | `600000` | 单次 `codex exec` 超时时间 |
| `LARK_CODEX_EXEC_SANDBOX` | `workspace-write` | 传给 `codex exec` 的沙箱：`read-only`、`workspace-write` 或 `danger-full-access` |
| `LARK_CODEX_EXEC_MODEL` | （空） | exec delivery 的全局可选模型覆盖。实时 chat 可在 `LARK_CODEX_EXEC_USE_SESSIONS=true` 时通过 `/model <model-id>` 按 chat/thread 覆盖 |
| `LARK_CODEX_EXEC_PROFILE` | （空） | exec delivery 的可选 Codex 配置 profile；启动时会提示该 profile 是否疑似包含 Lark MCP server |
| `LARK_CODEX_EXEC_IGNORE_USER_CONFIG` | `true` | 传 `--ignore-user-config` 给 `codex exec`，避免递归加载当前 Lark MCP server |
| `LARK_CODEX_EXEC_USE_SESSIONS` | `true` | 为每个飞书 `chat_id` / `thread_id` 恢复一个 Codex exec session，以保留多轮上下文；这不是接管某个已经打开的终端 TUI 交互 session。 |
| `LARK_EXEC_PROGRESS_ENABLED` | `true` | 为长时间运行的可见 turn 启用有界 Codex exec 过程消息侧通道 |
| `LARK_EXEC_PROGRESS_MAX_MESSAGES` | `3` | 每个 Codex exec turn 最多发送多少条过程消息 |
| `LARK_EXEC_PROGRESS_MAX_CHARS` | `300` | 单条过程消息最大字符数 |
| `LARK_EXEC_PROGRESS_MIN_INTERVAL_MS` | `15000` | 同一 turn 内两条过程消息之间的最小间隔 |
| `LARK_EXEC_PROGRESS_POLL_INTERVAL_MS` | `250` | 父进程轮询 progress JSONL 的间隔 |
| `LARK_CODEX_EXEC_TOOL_TRACE` | `false` | 启用本地 `codex exec --json` 工具执行 trace，写入 `trace.log`；不会把工具过程渲染到飞书回复里 |
| `LARK_CODEX_EXEC_TOOL_TRACE_MODE` | `compact` | trace 模式：`compact` 写脱敏摘要；`full` 写脱敏/截断后的事件 JSON；`hidden` 是兼容模式，本地按 compact 记录且不向飞书展示工具过程 |
| `LARK_CODEX_EXEC_TRACE_LOG` | `~/.codex/channels/lark/logs/trace.log` | 本地 codex exec tool trace 文本日志路径 |
| `LARK_CARD_FOOTER_METRICS_ENABLED` | `true` | 为 Codex exec 生成的卡片回复追加紧凑运行指标 footer；纯文本回复不变 |
| `LARK_CARD_FOOTER_METRICS_TOKEN_USAGE_THRESHOLD` | `20000` | 仅当上报的 total tokens 超过该阈值时，在卡片 footer 中显示 token usage |

实时飞书/Lark chat 支持轻量模型控制命令。每次尝试都会写入审计日志：

```text
/model             查看当前 chat/thread 的实际模型
/model <model-id>  为后续实时 turn 设置 chat/thread 模型覆盖
/model reset       只清除当前 chat/thread 的模型覆盖
```

模型解析顺序是：chat/thread override，然后是 `LARK_CODEX_EXEC_MODEL`，
最后回落到 Codex CLI 默认值。override 存在现有 `codex-sessions` 记录上，
并跟随同一套 retention 生命周期。

当 `LARK_CODEX_EXEC_TOOL_TRACE=true` 时，父进程会扫描 `codex exec --json`
stdout 中的工具执行事件，并把脱敏的人类可读文本行追加到
`LARK_CODEX_EXEC_TRACE_LOG`。这只用于本地排障：飞书仍只接收最终回答或受限
progress 消息。`compact` 记录精简文本行：工具/类型、状态、trace id、耗时和
脱敏后的参数/错误摘要；`full` 记录脱敏/截断后的事件结构。trace 行靠前位置会带
log id：普通飞书消息 turn 使用 source message id，cronjob prompt turn 使用
cronjob name。debug、audit 和 trace 日志时间都使用 `LARK_CRON_TIMEZONE`
并带显式 UTC offset，三者共享[本地诊断日志文本格式](docs/local-diagnostic-logs.md)。

生成卡片回复时，`LARK_CARD_FOOTER_METRICS_ENABLED=true` 会在最终
`turn.completed` 事件可用后追加紧凑运行指标 footer，例如
`🔧4 · 🧩2 · ⏱18s · 📊 I62.4k(C48.2k) O1.3k T63.7k`。已有业务 footer
会保留在前面，runtime footer 追加在后面。usage 不可用或 `total_tokens`
未超过 `LARK_CARD_FOOTER_METRICS_TOKEN_USAGE_THRESHOLD` 时不会显示 token
段，但仍会显示耗时。

exec delivery 可以为长时间运行的可见 IM / 文档评论 turn 暴露一个有界过程消息侧通道。
父进程创建临时 JSONL 文件，并把文件路径和本 turn token 传给子 `codex exec` 进程；
子进程可以追加签名的 progress event。父进程会校验 token 和 schema，拒绝
`chat_id` / `open_id` 等身份字段，丢弃重复或低信息量的“正在处理”类 filler，并按配置限制
条数、长度和发送频率；通过校验的过程消息会在最终回复前走同一个 IM 或文档评论回复路径。
如果 progress 文件创建失败，本 turn 会自动关闭过程消息，但最终回复仍会正常发送。
progress 目录会限制为当前本地用户可访问（`0700`），JSONL 文件为当前用户读写（`0600`）。
超过 12 小时的 `.lark-progress/turn-*` 残留会在启动时清理，并由每小时一次的 best-effort
清理继续回收。

exec delivery 也内置父进程 action bridge，用于处理子 `codex exec` 进程不能安全调用当前 MCP server 的内置动作：`save_memory`、`create_job`、`list_jobs`、`update_job`、`disable_job`、`delete_job`、`upsert_job`、`run_local_cli_tool`、`manage_access_control`、`send_message` 和 `recall_message`。父进程会为每个 `codex exec` turn 创建 owner-only 的 action JSONL 侧通道，只把文件路径和 per-turn token 交给子进程；子进程把结构化 action request 写入该侧通道，stdout 始终只作为用户可见回复文本。父进程校验 token/schema，拒绝子进程提供的身份字段，使用当前飞书事件派生调用者身份，在本地执行通过校验的动作；格式错误的 action request 会被标记为失败，而不是递归加载 Lark MCP server。`send_message` 可用插件运行时身份发送本地 image/file、当前入站消息已下载的第一张图片，或 quoted/replied message 的第一张图片；也支持有序 `kind=rich` 文本+图片 parts，优先发送一条飞书富文本 post，失败时按顺序拆分消息并保持 thread context。音视频和交互卡片仍是后续独立设计切片。

外部项目管理系统写操作不再内置在 Lark plugin 核心里。创建 GitHub/GitLab issue、Jira ticket、Linear issue、PR，或周期复盘 proposal，应由用户自定义 skill、custom MCP，或 allowlisted `run_local_cli_tool` 承载。插件只提供 Lark channel、身份、cronjob、审计和通用本地工具边界；具体 provider 的策略应放在插件之外。

因为 exec delivery 是单轮流程，插件也会拦截容易误导的“回复后继续办事”承诺。最终回答不能声称 Codex 会在可见飞书回复发出后继续创建、提交、回贴链接或稍后处理，除非同一份输出里包含 structured action、`[LARK_DEFER]` / `[LARK_NO_REPLY]`，或 `create_job` 这类调度动作。如果没有这些机制却返回了高风险后续承诺，bridge 会把它替换成安全说明，避免让用户误以为后台还会继续执行。

SDK 迁移 smoke 命令、rollout 控制、rollback 步骤和兼容路径移除门槛见
[SDK channel rollout](docs/sdk-channel-rollout.md) 与
[transition compatibility matrix](docs/transition-compatibility.md)。

### 可选 -- 本地 CLI 工具

`run_local_cli_tool` 是受控 MCP 工具，用于可信的 host-local CLI 或 skill-backed workflow，
例如 `lark-cli`。它不会执行 shell 字符串，也不会改变普通 `codex exec` 的沙箱设置。每次调用都会从
`IdentitySession` 解析真实调用者，按单个工具配置授权，应用一种参数过滤模式，使用
`spawn(command, args, { shell: false })` 执行，捕获有上限的输出，脱敏常见 secret，并写审计日志。
默认情况下，子进程只会收到少量运行必需环境变量（`HOME`、`PATH`、临时目录、用户和 locale 键）。
需要父进程环境变量时使用 `envAllowlist` 显式放行；需要固定值时使用字面量 `env`；
只有完全可信且确实需要完整插件进程环境的工具才应设置 `inheritEnv: true`。

配置文件：`~/.codex/channels/lark/runtime-config/local-cli-tools.json`。

```json
{
  "tools": {
    "lark_cli": {
      "command": "/opt/homebrew/bin/lark-cli",
      "allowedSubcommands": ["doc", "drive", "sheets"],
      "paramBlocklist": ["--token", "--secret", "--app-secret", "--debug-dump-env"],
      "envAllowlist": ["LARK_APP_ID"],
      "timeoutMs": 30000,
      "maxOutputBytes": 65536,
      "allowedCallers": "owners"
    },
    "lark_doc_create": {
      "command": "/opt/homebrew/bin/lark-cli",
      "fixedArgs": ["doc", "create"],
      "paramAllowlist": ["--title", "--content", "--folder", "--format"],
      "env": { "LARK_CLI_OUTPUT": "json" },
      "timeoutMs": 30000,
      "maxOutputBytes": 65536,
      "allowedCallers": "lark_allowed_user_ids"
    },
    "my_tracker_create_item": {
      "command": "/Users/you/bin/my-tracker-create-item",
      "fixedArgs": [],
      "paramAllowlist": ["--project", "--title", "--body", "--label"],
      "timeoutMs": 30000,
      "maxOutputBytes": 65536,
      "allowedCallers": "owners"
    }
  }
}
```

`allowedCallers` 支持 `"owners"`、`"lark_allowed_user_ids"`、`"public"`，或显式
Feishu/Lark `open_id` 数组。每个工具必须且只能设置 `paramAllowlist` 或
`paramBlocklist` 其中一个。`command` 必须是绝对路径。
`envAllowlist` 和 `env` 里的环境变量名必须是 shell 兼容名称，例如 `LARK_APP_ID`
或 `CUSTOM_SAFE`。

外部 tracker 示例是用户自有 wrapper，不是插件提供的内置工具或保留 action 名。例如上面的
`my_tracker_create_item` 应是仓库外的本地脚本，并由脚本自己完成参数校验、必填字段检查、
provider CLI 能力探测，以及在开启真实写入前的参数组装 dry-run 测试。也可以通过独立的
provider-specific skill 或 custom MCP server 暴露。核心插件不解析 GitHub/GitLab/Jira/Linear
语义，也不提供内置 issue 或 PR 创建工具。

### 可选 —— 确认回应

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LARK_ACK_EMOJI` | `MeMeMe` | 收到消息时的 emoji 回应。留空可禁用 |
| `LARK_DOC_COMMENT_ACK_EMOJI` | `THUMBSUP` | 收到文档评论 @bot 事件时保留的 emoji 回应。留空可禁用 |
| `LARK_BOT_MESSAGE_TRACKER_SIZE` | `500` | 用于 reaction 事件路由和 bot 消息修改保护的 bot 消息 ID 追踪上限（FIFO） |

### 可选 -- Feishu API 可靠性

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LARK_FEISHU_API_TIMEOUT_MS` | `30000` | 单次 Feishu API 调用超时时间（毫秒） |
| `LARK_FEISHU_API_RETRY_ATTEMPTS` | `3` | 可重试的临时 Feishu/API/网络错误最多尝试次数 |
| `LARK_FEISHU_API_RETRY_BASE_DELAY_MS` | `250` | 指数退避基础延迟（毫秒） |
| `LARK_DOWNLOAD_MAX_BYTES` | `26214400` | 附件/图片下载最大字节数，超出会拒绝写入 |
| `LARK_DOWNLOAD_TIMEOUT_MS` | `60000` | 附件/图片下载超时时间（毫秒） |

### 可选 —— 定时任务

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LARK_CRON_SCAN_INTERVAL` | `60` | 定时任务扫描间隔（秒） |
| `LARK_CRON_TIMEZONE` | 系统时区 | 新建 cronjob 的默认 IANA 时区，同时用于本地 debug/audit/trace 日志时间戳（如 `Asia/Shanghai`、`UTC`）。每个 job 会在 `meta.timezone` 固化自己的时区；之后修改该环境变量不会静默改变已有任务的执行语义 |

### 可选 -- Codex Exec Session Health

Session health 提醒默认关闭，仅当 `LARK_SESSION_HEALTH_ENABLED=true`、
`LARK_OWNER_OPEN_ID` 已设置且 Codex exec session resume 启用时才运行。Session retention
只会清理本插件 `codex-sessions/` 目录里的 resume-pointer JSON 文件；不会 clear、compact、
reset 或删除 Codex CLI 自己的 transcript/session 数据。

当 Codex exec JSONL 暴露 token/context usage 时，monitor 会优先使用真实 usage；
否则 fallback 到较弱的启发式：同一 chat/thread 下的 exec turn 数和桥接层观察到的
prompt bytes。提醒只会在安静窗口发送给 owner：消息队列空闲、ack reaction 已清空、没有待
满足的 reply obligation。重复提醒会指数退避，并受每个 session episode 的次数上限约束。
当同一 chat/thread 返回新的 Codex session id（例如 stale session 恢复后新建会话）或插件进程重启时，
该 episode 计数会重置。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LARK_SESSION_HEALTH_ENABLED` | `false` | 启用长时间 Codex exec session 的 owner DM 提醒 |
| `LARK_SESSION_HEALTH_TURN_THRESHOLD` | `80` | 同一 chat/thread session 达到该 exec turn 数后提醒 |
| `LARK_SESSION_HEALTH_PROMPT_BYTES_THRESHOLD` | `524288` | 当 Codex exec JSONL 未暴露 token usage 时，桥接层累计观察到的 prompt bytes 达到该值后提醒 |
| `LARK_SESSION_HEALTH_TOKEN_THRESHOLD` | `160000` | 当 JSONL usage 可用时，报告的 Codex exec total tokens 达到该值后提醒 |
| `LARK_SESSION_HEALTH_IDLE_DELAY_MS` | `30000` | 触发后等待多久再检查 idle/quiet gates |
| `LARK_SESSION_HEALTH_COOLDOWN_MS` | `1800000` | 首次提醒后的冷却时间（毫秒） |
| `LARK_SESSION_HEALTH_MAX_COOLDOWN_MS` | `21600000` | 指数退避冷却上限（毫秒） |
| `LARK_SESSION_HEALTH_MAX_NUDGES` | `3` | 每个启发式 session episode 最多提醒次数 |

### 可选 -- Codex Exec Session Retention

插件会在 `~/.codex/channels/lark/codex-sessions/` 下为每个飞书 `chat_id` /
`thread_id` 保存一个很小的 resume pointer。Retention cleanup 只约束这个 pointer 目录；
不会删除 Codex 自己的 session transcript。只有超过 TTL 的记录才会成为候选；active、最近被
触碰、格式异常或不完整的记录都会跳过。可开启 dry-run 在日志中预览候选和统计。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LARK_CODEX_SESSION_RETENTION_DAYS` | `14` | 保留最近多少天内的 Codex exec resume-pointer 记录 |
| `LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS` | `24` | 周期清理间隔。设为 `0` 可禁用自动清理 |
| `LARK_CODEX_SESSION_RETENTION_DRY_RUN` | `false` | 只预览候选并输出统计，不删除文件 |

### 可选 -- 记忆

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LARK_MIN_SEARCH_SCORE` | `0.3` | 最低相关度分数 |
| `LARK_MAX_SEARCH_RESULTS` | `2` | 每次查询返回的最大情景数 |
| `LARK_INACTIVITY_HOURS` | `3` | 自动蒸馏触发的静默时长（小时） |
| `LARK_MAX_EPISODE_BYTES` | `65536` | 单个 episode 文件持久化前的最大 UTF-8 字节数，超出会截断 |
| `LARK_MAX_EPISODE_FILES_PER_SCOPE` | `200` | 每个 chat/thread scope 最多保留的 episode 文件数 |
| `LARK_MAX_EPISODE_SCOPE_BYTES` | `10485760` | 每个 chat/thread scope 最多保留的 episode 总字节数 |
| `LARK_PROFILE_DISTILLATION_ENABLED` | `false` | 启用阶段 2：从近期 episode 提取并写入分层 profile |
| `LARK_PROFILE_DISTILLATION_MIN_EPISODES` | `3` | 同一 chat/thread scope 至少有这么多 episode 才触发一次 profile distillation |
| `LARK_PROFILE_DISTILLATION_MAX_EPISODES` | `5` | 单次 profile distillation prompt 最多包含的近期 episode 数 |
| `LARK_PROFILE_DISTILLATION_COOLDOWN_MS` | `86400000` | 同一用户两次 profile distillation dispatch 之间的冷却时间（毫秒） |
| `LARK_MEMORY_DEDUP_WINDOW_MS` | `1800000` | 同一 chat/thread 内未变化记忆块的去重窗口（毫秒）。设为 `0` 可禁用 |

### 可选 -- 身份 / 隐私（v0.9.0+）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LARK_OWNER_OPEN_ID` | （空） | 运营者 open_id。用于终端技能（如 `$lark:jobs`）在没有活跃 Lark turn 时通过 `__terminal__` 哨兵 chat_id 解析调用者。未设置时，终端侧的敏感操作将被拒绝 |
| `LARK_IDENTITY_SESSION_TTL_MS` | `max(2h, LARK_INACTIVITY_HOURS × 2h)` | 服务端 `(chat_id, thread_id?) → open_id` 会话条目的 TTL。必须超过自动蒸馏窗口，以保证 flush 触发的工具调用仍能解析到最后的真实用户 |
| `LARK_IDENTITY_SESSION_MAX_ENTRIES` | `5000` | 服务端调用者会话的最大内存条目数，超过后按最旧条目淘汰 |
| `LARK_AUDIT_LOG` | `~/.codex/channels/lark/logs/audit.log` | 追加式文本行审计日志路径。每次敏感工具调用都会追加一行（尽力而为，写入失败不影响工具行为）（v0.11.0+）|
| `LARK_QUOTED_CARD_USER_FETCH_ENABLED` | `true` | 当 bot SDK/raw fetch 无法补齐引用的交互卡片时，尝试用 `lark-cli im +messages-mget --as user` 作为 user 身份兜底。 |
| `LARK_QUOTED_CARD_USER_FETCH_COMMAND` | `lark-cli` | 引用卡片 user fallback 使用的可执行文件。 |
| `LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS` | `10000` | 引用卡片 user fallback 的超时时间。 |
| `LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES` | `262144` | 引用卡片 user fallback 捕获 stdout/stderr 的最大字节数。 |

### 可选 -- 资源治理

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LARK_DEBUG_LOG` | `~/.codex/channels/lark/logs/debug.log` | debug 日志路径。debug 行使用 `LARK_CRON_TIMEZONE` 时间戳并去掉方括号包装，如 `2026-07-10T19:20:50.822+08:00 channel ...` |
| `LARK_LOG_MAX_BYTES` | `5242880` | debug/audit/trace 日志达到该大小后轮转 |
| `LARK_LOG_MAX_FILES` | `5` | 保留的轮转日志文件数量 |
| `LARK_LOG_ARCHIVE_RETENTION_MONTHS` | `6` | 将上个月 debug/audit/trace 日志压缩到 `archive/YYYY-MM/` 并保留这么多个月。设为 `0` 可禁用月度归档 |
| `LARK_INBOX_MAX_AGE_HOURS` | `168` | 启动清理时删除早于该时长的 inbox 下载文件 |
| `LARK_INBOX_MAX_BYTES` | `209715200` | 启动清理时按 LRU 删除 inbox 文件直到低于该总字节上限 |
| `LARK_NAME_CACHE_SIZE` | `1000` | Feishu 用户/群聊展示名缓存上限 |
| `LARK_CHAT_TYPE_CACHE_SIZE` | `1000` | Feishu chat type 缓存上限 |
| `LARK_LATEST_MESSAGE_TRACKER_SIZE` | `1000` | latest inbound message tracker 条目上限 |
| `LARK_CARD_CONTEXT_CACHE_SIZE` | `200` | fetched card 父消息 / 根消息上下文缓存条目上限 |
| `LARK_CARD_CONTEXT_CACHE_TTL_MS` | `1800000` | fetched interactive card 父消息 / 根消息上下文缓存 TTL（毫秒） |
| `LARK_QUOTED_CONTEXT_MAX_DEPTH` | `4` | 传给 Codex 前最多递归补全多少层引用 / 回复消息链 |
| `LARK_QUOTED_CONTEXT_MAX_BYTES` | `12000` | 引用消息 hydration 的 UTF-8 字节预算；超出时写入显式失败标记而不是塞入过长内容 |

---

## 交互式配置

插件内置交互式配置命令，可在 Codex 中直接使用：

| 命令 | 说明 |
|------|------|
| `$lark:configure` | 查看当前配置状态（敏感信息脱敏显示） |
| `$lark:configure <app_id> <app_secret>` | 快速配置凭据 |
| `$lark:configure setup` | 完整交互式引导配置 |
| `$lark:configure clear` | 清除所有配置 |

### `$lark:configure setup` 流程

交互式引导分 5 步，每步可选择跳过或使用默认值：

```
第 1 步：凭据
  -> LARK_APP_ID 和 LARK_APP_SECRET（已有配置时显示脱敏值，可选保留/更新）

第 2 步：运行时访问控制（可选）
  -> setup 后由 owner 通过 /access 或 manage_access_control 管理

第 3 步：CronJob（可选）
  -> LARK_CRON_TIMEZONE（新建任务的默认时区）

第 4 步：高级调优（可选）
  -> LARK_INACTIVITY_HOURS、LARK_MAX_SEARCH_RESULTS、LARK_MIN_SEARCH_SCORE、
     LARK_TEXT_CHUNK_LIMIT、LARK_QUEUE_HANDLER_TIMEOUT_MS、
     LARK_ACK_EMOJI、LARK_BOT_MESSAGE_TRACKER_SIZE、
     LARK_MAX_EPISODE_BYTES、LARK_MAX_EPISODE_FILES_PER_SCOPE、
     LARK_MAX_EPISODE_SCOPE_BYTES、LARK_CRON_SCAN_INTERVAL、
     LARK_FEISHU_API_TIMEOUT_MS、LARK_FEISHU_API_RETRY_ATTEMPTS、
     LARK_FEISHU_API_RETRY_BASE_DELAY_MS、
     LARK_DOWNLOAD_MAX_BYTES、LARK_DOWNLOAD_TIMEOUT_MS、
     LARK_IDENTITY_SESSION_MAX_ENTRIES、LARK_DEBUG_LOG、
     LARK_LOG_MAX_BYTES、LARK_LOG_MAX_FILES、LARK_LOG_ARCHIVE_RETENTION_MONTHS、
     LARK_CODEX_EXEC_TRACE_LOG、
     LARK_INBOX_MAX_AGE_HOURS、
     LARK_INBOX_MAX_BYTES、LARK_NAME_CACHE_SIZE、
     LARK_CHAT_TYPE_CACHE_SIZE、LARK_LATEST_MESSAGE_TRACKER_SIZE、
     LARK_QUOTED_CONTEXT_MAX_DEPTH、LARK_QUOTED_CONTEXT_MAX_BYTES、
     LARK_CODEX_SESSION_RETENTION_DAYS、
     LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS、
     LARK_CODEX_SESSION_RETENTION_DRY_RUN

第 5 步：写入配置
  -> ~/.codex/channels/lark/.env
```

所有配置写入 `~/.codex/channels/lark/.env`。修改后需新开 Codex session 或重启 Codex 生效。

---

## lark-cli 集成

本插件负责：消息接收 + 记忆管理 + 直接回复工具。

lark-cli 负责：完整的飞书 API（日历、文档、表格、任务、通讯录等 21 项技能）。

安装 lark-cli 后，其技能会由 Codex 与本插件一同加载。

---

## 后台守护进程

使用 tmux 在后台持续运行插件：

```bash
# 创建后台会话
tmux new-session -d -s lark 'bash scripts/start.sh'

# 查看日志
tmux attach -t lark

# 分离会话（插件继续运行）
# 按 Ctrl+B 然后按 D

# 停止
npm run stop
# 或
bash scripts/stop.sh
```

---

## 可用工具

| 工具 | 签名 | 说明 |
|------|------|------|
| `reply` | `(chat_id, text, reply_to?, files?)` | 发送文字回复，可附带图片或文件。长文本自动按段落/换行/空格分段 |
| `edit_message` | `(message_id, text, format?)` | 编辑已发送的机器人消息（支持 text 和 card_markdown 格式） |
| `react` | `(message_id, emoji)` | 对消息添加表情回复 |
| `download_attachment` | `(message_id, file_key)` | 下载消息中的附件到本地收件箱 |
| `defer_reply` | `(chat_id, reply_to?, thread_id?, marker?, reason?)` | 标记当前飞书 turn 已有意延后或无需回复，不发送可见消息 |
| `reply_doc_comment` | `(chat_id, doc_token, comment_id, content, file_type, thread_id?)` | 回复当前触发的飞书文档评论线程。仅 owner 可调用，并绑定到当前 `doc:<file_token>` turn |
| `create_doc_comment` | `(chat_id, doc_token, content, file_type, thread_id?)` | 在当前触发的飞书文档中新建顶级评论。仅 owner 可调用，并绑定到当前 `doc:<file_token>` turn |
| `save_memory` | `(type, content, reason, chat_id, thread_id?, tier?)` | 保存用户画像、会话情景或话题情景。画像写入总是针对调用者本人（v0.9.0 起）；v0.10.0 起可选 `tier` 参数（`public` / `private`，默认 `private`）决定归属哪一档 |
| `save_skill` | `(name, description, content, chat_id, thread_id?)` | 保存可复用的操作流程为全局技能。仅 owner 可用，因为技能跨用户/聊天全局可见 |
| `create_job` | `(name, type, schedule, timezone?, prompt?, content?, target_chat_id, chat_id, thread_id?)` | 创建定时任务。创建者由 session 派生，不再接受 `created_by`；`chat_id` 用于派生调用者身份并填充 `origin_chat_id`；可选 `timezone` 会写入 job 文件 |
| `list_jobs` | `(status?, chat_id, thread_id?)` | 列出当前 chat 可见的 job。私聊返回 caller 自己建的；群里返回 `target_chat_id` 为本群的（非 owner 视图脱敏 prompt）；展示每个 job 自己的时区和 UTC 时间 |
| `update_job` | `(id, status?, schedule?, timezone?, prompt?, content?, name?, chat_id, thread_id?)` | 修改 job。仅 owner 可操作 |
| `delete_job` | `(id, chat_id, thread_id?)` | 删除 job。仅 owner 可操作 |
| `what_do_you_know` | `(chat_id, thread_id?)` | 列出 bot 存储的当前调用者 profile 条目。按可见性过滤（私聊展示 public+private，群里只展示 public）。每行附带 8 位 hash，供 `forget_memory` 使用（v0.11.0+）|
| `forget_memory` | `(chat_id, thread_id?, hash, tier?, promote_to_rule?)` | 按 hash 删除 profile 里的某行。调用者本人才能操作。可选 `promote_to_rule=true` 把本次删除沉淀为 `privacy-rules.md` 的永久规则（v0.11.0+）|
| `run_local_cli_tool` | `(tool, args?, chat_id, thread_id?)` | 在插件宿主机运行已配置白名单的本地 CLI 能力。调用者身份由 `chat_id` / `thread_id` 服务端派生；参数和环境由 `local-cli-tools.json` 过滤（v1.1.0+）|
| `manage_access_control` | `(action, list?, value?, chat_id, thread_id?)` | owner-only 的运行时访问控制 list/add/remove；与 `/access` 等价，所有尝试都会写审计日志 |

---

## 环境要求

- Node.js >= 20.0.0
- Codex（已安装并可运行）
- 飞书自建应用（已启用机器人能力并配置权限）

---

## 开源协议

[Apache License 2.0](LICENSE)
L2 隐私规则位于
`~/.codex/channels/lark/runtime-config/privacy-rules.md`；本地 CLI 白名单位于
`~/.codex/channels/lark/runtime-config/local-cli-tools.json`。
