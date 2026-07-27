# 配置参考

此文件由 `src/config-schema.ts` 生成。请修改 schema，然后运行 `npm run generate:config`。

## 凭据

| 配置项 | 类型 | 必填 | 默认值 | 敏感 | 约束 | 说明 | 适用功能 |
|---|---|---:|---|---:|---|---|---|
| `LARK_APP_ID` | string | 是 | - | 否 | - | 飞书/Lark 应用 ID。 | bootstrap |
| `LARK_APP_SECRET` | string | 是 | - | 是 | - | 飞书/Lark 应用密钥。 | bootstrap |

## 消息

| 配置项 | 类型 | 必填 | 默认值 | 敏感 | 约束 | 说明 | 适用功能 |
|---|---|---:|---|---:|---|---|---|
| `LARK_CARD_FOOTER_METRICS_ENABLED` | boolean | 否 | true | 否 | true/false, 1/0, yes/no, on/off | 在生成的卡片回复底部附加紧凑运行指标。 | messaging |
| `LARK_CARD_FOOTER_METRICS_TOKEN_USAGE_THRESHOLD` | number | 否 | 20000 | 否 | a non-negative number | 在卡片页脚显示 token 用量的阈值。 | messaging |
| `LARK_CODEX_EXEC_COMMAND` | string | 否 | codex | 否 | - | exec 投递使用的 Codex CLI 命令。 | messaging |
| `LARK_CODEX_EXEC_CWD` | string | 否 | ~/.codex/channels/lark/codex-exec-workdir | 否 | - | 前台 Codex exec 回合的工作目录。 | messaging |
| `LARK_CODEX_EXEC_IGNORE_USER_CONFIG` | boolean | 否 | true | 否 | true/false, 1/0, yes/no, on/off | 阻止子 exec 回合加载用户 Codex 配置。 | messaging |
| `LARK_CODEX_EXEC_MODEL` | string | 否 | (empty) | 否 | - | Codex exec 的可选全局模型覆盖。 | messaging |
| `LARK_CODEX_EXEC_PROFILE` | string | 否 | (empty) | 否 | - | 可选的 Codex 配置 profile。 | messaging |
| `LARK_CODEX_EXEC_SANDBOX` | enum(read-only, workspace-write, danger-full-access) | 否 | workspace-write | 否 | read-only, workspace-write, danger-full-access | 传给前台 Codex exec 的沙盒模式。 | messaging |
| `LARK_CODEX_EXEC_TIMEOUT_MS` | number | 否 | 600000 | 否 | a positive number | 单次前台 Codex exec 运行超时。 | messaging |
| `LARK_CODEX_EXEC_TOOL_TRACE` | boolean | 否 | false | 否 | true/false, 1/0, yes/no, on/off | 在本地写入脱敏后的 Codex 工具执行 trace。 | messaging |
| `LARK_CODEX_EXEC_TOOL_TRACE_MODE` | enum(compact, full, hidden) | 否 | compact | 否 | compact, full, hidden | 本地 Codex 工具 trace 的详细程度。 | messaging |
| `LARK_CODEX_EXEC_TRACE_LOG` | string | 否 | ~/.codex/channels/lark/logs/trace.log | 否 | - | 本地 Codex 工具 trace 日志路径。 | messaging |
| `LARK_CODEX_EXEC_USE_SESSIONS` | boolean | 否 | true | 否 | true/false, 1/0, yes/no, on/off | 每个飞书会话或话题复用一个 Codex session。 | messaging |
| `LARK_CODEX_SESSION_RETENTION_DAYS` | number | 否 | 14 | 否 | a positive number | Codex exec session 指针的保留天数。 | messaging |
| `LARK_CODEX_SESSION_RETENTION_DRY_RUN` | boolean | 否 | false | 否 | true/false, 1/0, yes/no, on/off | 仅预览 Codex session 清理而不删除记录。 | messaging |
| `LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS` | number | 否 | 24 | 否 | a non-negative number | 扫描过期 Codex session 指针的间隔。 | messaging |
| `LARK_CONTINUATION_ENABLED` | boolean | 否 | true | 否 | true/false, 1/0, yes/no, on/off | 启用持久化后台 continuation 的创建与执行。 | continuation |
| `LARK_CONTINUATION_MAX_ATTEMPTS` | number | 否 | 5 | 否 | an integer between 1 and 20 | 每个 continuation Job 的最大 attempt 数。 | continuation |
| `LARK_CONTINUATION_MAX_CONCURRENCY` | number | 否 | 1 | 否 | an integer between 1 and 4 | continuation 的最大并发执行数。 | continuation |
| `LARK_CONTINUATION_MAX_RETRIES` | number | 否 | 3 | 否 | an integer between 0 and 10 | attempt 预算内允许的可重试失败次数。 | continuation |
| `LARK_CONTINUATION_MAX_TOTAL_MINUTES` | number | 否 | 30 | 否 | an integer between 5 and 1440 | 单个 continuation Job 的最长生命周期。 | continuation |
| `LARK_CONTINUATION_RETENTION_DAYS` | number | 否 | 30 | 否 | an integer between 1 and 3650 | 终态 continuation 详情与产物的保留天数。 | continuation |
| `LARK_CONTINUATION_WORKING_ROOT` | absolute path | 否 | LARK_CODEX_EXEC_CWD | 否 | absolute path | continuation 工作目录允许使用的绝对根路径。 | continuation |
| `LARK_EXEC_PROGRESS_ENABLED` | boolean | 否 | true | 否 | true/false, 1/0, yes/no, on/off | 为长时间前台回合启用有界过程消息。 | messaging |
| `LARK_EXEC_PROGRESS_MAX_CHARS` | number | 否 | 300 | 否 | a positive number | 单条过程消息的最大字符数。 | messaging |
| `LARK_EXEC_PROGRESS_MAX_MESSAGES` | number | 否 | 3 | 否 | a positive number | 每个前台回合最多发送的过程消息数。 | messaging |
| `LARK_EXEC_PROGRESS_MIN_INTERVAL_MS` | number | 否 | 15000 | 否 | a non-negative number | 过程消息之间的最小间隔。 | messaging |
| `LARK_EXEC_PROGRESS_POLL_INTERVAL_MS` | number | 否 | 250 | 否 | a positive number | 父进程轮询过程消息侧通道的间隔。 | messaging |
| `LARK_QUEUE_HANDLER_TIMEOUT_MS` | number | 否 | LARK_CODEX_EXEC_TIMEOUT_MS + 60000 | 否 | a non-negative number | 每个会话队列的超时；0 表示关闭，正值会被提升到 exec 超时以上。 | messaging |
| `LARK_REPLY_OBLIGATION_TIMEOUT_MS` | number | 否 | max(60000, LARK_CODEX_EXEC_TIMEOUT_MS + 60000) | 否 | a positive number | 等待可见回复或 defer 结果的最长时间。 | messaging |
| `LARK_SESSION_HEALTH_COOLDOWN_MS` | number | 否 | 1800000 | 否 | a positive number | session 健康提醒的初始冷却时间。 | messaging |
| `LARK_SESSION_HEALTH_ENABLED` | boolean | 否 | false | 否 | true/false, 1/0, yes/no, on/off | 启用长时间 Codex session 的 owner 提醒。 | messaging |
| `LARK_SESSION_HEALTH_IDLE_DELAY_MS` | number | 否 | 30000 | 否 | a non-negative number | 检查 session 健康门槛前的空闲延迟。 | messaging |
| `LARK_SESSION_HEALTH_MAX_COOLDOWN_MS` | number | 否 | 21600000 | 否 | a positive number | session 健康提醒的最大指数冷却时间。 | messaging |
| `LARK_SESSION_HEALTH_MAX_NUDGES` | number | 否 | 3 | 否 | a positive number | 每个 session 阶段最多发送的健康提醒数。 | messaging |
| `LARK_SESSION_HEALTH_PROMPT_BYTES_THRESHOLD` | number | 否 | 524288 | 否 | a positive number | 触发 session 健康提醒的 prompt 字节数阈值。 | messaging |
| `LARK_SESSION_HEALTH_TOKEN_THRESHOLD` | number | 否 | 160000 | 否 | a positive number | 触发 session 健康提醒的已报告 token 阈值。 | messaging |
| `LARK_SESSION_HEALTH_TURN_THRESHOLD` | number | 否 | 80 | 否 | a positive number | 触发 session 健康提醒的回合数阈值。 | messaging |
| `LARK_TEXT_CHUNK_LIMIT` | number | 否 | 4000 | 否 | a positive number | 每个文本消息分片的最大字符数。 | messaging |

## 确认反馈

| 配置项 | 类型 | 必填 | 默认值 | 敏感 | 约束 | 说明 | 适用功能 |
|---|---|---:|---|---:|---|---|---|
| `LARK_ACK_EMOJI` | string | 否 | MeMeMe | 否 | empty allowed | 收到消息时添加的 emoji reaction。 | acknowledgement |
| `LARK_BOT_MESSAGE_TRACKER_SIZE` | number | 否 | 500 | 否 | a non-negative number | 为路由与消息变更保护保留的 bot message ID 上限。 | reactions, message-mutation |
| `LARK_DOC_COMMENT_ACK_EMOJI` | string | 否 | THUMBSUP | 否 | empty allowed | 文档评论提及消息使用的持久 reaction。 | acknowledgement, doc-comment |

## 可靠性

| 配置项 | 类型 | 必填 | 默认值 | 敏感 | 约束 | 说明 | 适用功能 |
|---|---|---:|---|---:|---|---|---|
| `LARK_DOWNLOAD_MAX_BYTES` | number | 否 | 26214400 | 否 | a positive number | 单个下载附件允许的最大字节数。 | lark-api |
| `LARK_DOWNLOAD_TIMEOUT_MS` | number | 否 | 60000 | 否 | a non-negative number | 附件和图片下载超时。 | lark-api |
| `LARK_FEISHU_API_RETRY_ATTEMPTS` | number | 否 | 3 | 否 | a positive number | 飞书 API 可重试失败的尝试次数。 | lark-api |
| `LARK_FEISHU_API_RETRY_BASE_DELAY_MS` | number | 否 | 250 | 否 | a non-negative number | 飞书 API 指数退避重试的基础延迟。 | lark-api |
| `LARK_FEISHU_API_TIMEOUT_MS` | number | 否 | 30000 | 否 | a non-negative number | 单次飞书 API 调用超时。 | lark-api |

## 定时任务

| 配置项 | 类型 | 必填 | 默认值 | 敏感 | 约束 | 说明 | 适用功能 |
|---|---|---:|---|---:|---|---|---|
| `LARK_CRON_SCAN_INTERVAL` | number | 否 | 60 | 否 | a positive number | Cron 调度扫描间隔（秒）。 | cron |
| `LARK_CRON_TIMEZONE` | string | 否 | system timezone | 否 | - | 新 CronJob 与本地日志使用的默认 IANA 时区。 | cron, logging |

## 记忆

| 配置项 | 类型 | 必填 | 默认值 | 敏感 | 约束 | 说明 | 适用功能 |
|---|---|---:|---|---:|---|---|---|
| `LARK_INACTIVITY_HOURS` | number | 否 | 3 | 否 | a positive number | 刷新缓冲会话记忆前的空闲小时数阈值。 | memory |
| `LARK_MAX_EPISODE_BYTES` | number | 否 | 65536 | 否 | a non-negative number | 单个 episode 文件持久化的最大字节数。 | memory |
| `LARK_MAX_EPISODE_FILES_PER_SCOPE` | number | 否 | 200 | 否 | a non-negative number | 每个会话或话题范围保留的 episode 文件上限。 | memory |
| `LARK_MAX_EPISODE_SCOPE_BYTES` | number | 否 | 10485760 | 否 | a non-negative number | 每个范围保留的 episode 总字节数上限。 | memory |
| `LARK_MAX_SEARCH_RESULTS` | number | 否 | 2 | 否 | a positive number | 单个回合最多注入的 episode 搜索结果数。 | memory |
| `LARK_MEMORY_DEDUP_WINDOW_MS` | number | 否 | 1800000 | 否 | a non-negative number | 抑制未变化记忆块的时间窗口。 | memory |
| `LARK_MIN_SEARCH_SCORE` | number | 否 | 0.3 | 否 | a non-negative number | episode 搜索结果的最低相关度分数。 | memory |
| `LARK_PROFILE_DISTILLATION_COOLDOWN_MS` | number | 否 | 86400000 | 否 | a non-negative number | 每个用户两次 profile 提炼之间的冷却时间。 | memory |
| `LARK_PROFILE_DISTILLATION_ENABLED` | boolean | 否 | false | 否 | true/false, 1/0, yes/no, on/off | 启用从近期 episode 进行 profile 提炼。 | memory |
| `LARK_PROFILE_DISTILLATION_MAX_EPISODES` | number | 否 | 5 | 否 | a positive number | 单次提炼 prompt 包含的近期 episode 上限。 | memory |
| `LARK_PROFILE_DISTILLATION_MIN_EPISODES` | number | 否 | 3 | 否 | a positive number | 启动 profile 提炼所需的最少 episode 数。 | memory |

## 身份

| 配置项 | 类型 | 必填 | 默认值 | 敏感 | 约束 | 说明 | 适用功能 |
|---|---|---:|---|---:|---|---|---|
| `LARK_IDENTITY_SESSION_MAX_ENTRIES` | number | 否 | 5000 | 否 | a positive number | 服务端派生调用者身份 session 条目上限。 | identity |
| `LARK_IDENTITY_SESSION_TTL_MS` | number | 否 | max(2h, LARK_INACTIVITY_HOURS x 2h) | 否 | a positive number | 服务端派生调用者身份 session 的生命周期。 | identity |
| `LARK_OWNER_OPEN_ID` | string | 否 | (empty) | 否 | - | 不可变的 operator 身份与终端 skill 信任根。 | identity, authorization |

## 隐私

| 配置项 | 类型 | 必填 | 默认值 | 敏感 | 约束 | 说明 | 适用功能 |
|---|---|---:|---|---:|---|---|---|
| `LARK_AUDIT_LOG` | string | 否 | ~/.codex/channels/lark/logs/audit.log | 否 | - | 敏感操作追加式审计日志的路径。 | audit |

## 引用卡片

| 配置项 | 类型 | 必填 | 默认值 | 敏感 | 约束 | 说明 | 适用功能 |
|---|---|---:|---|---:|---|---|---|
| `LARK_CARD_CONTEXT_CACHE_SIZE` | number | 否 | 200 | 否 | a non-negative number | 缓存的父级或根卡片上下文上限。 | quoted-context |
| `LARK_CARD_CONTEXT_CACHE_TTL_MS` | number | 否 | 1800000 | 否 | a non-negative number | 已拉取卡片上下文缓存条目的生命周期。 | quoted-context |
| `LARK_QUOTED_CARD_USER_FETCH_COMMAND` | string | 否 | lark-cli | 否 | - | 引用卡片 user 身份回退使用的 lark-cli 命令。 | quoted-context |
| `LARK_QUOTED_CARD_USER_FETCH_ENABLED` | boolean | 否 | true | 否 | true/false, 1/0, yes/no, on/off | bot 身份补齐卡片失败时允许使用 user 身份回退。 | quoted-context |
| `LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES` | number | 否 | 262144 | 否 | a positive number | 引用卡片 user 身份回退可捕获的最大输出字节数。 | quoted-context |
| `LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS` | number | 否 | 10000 | 否 | a positive number | 引用卡片 user 身份回退的超时。 | quoted-context |
| `LARK_QUOTED_CONTEXT_MAX_BYTES` | number | 否 | 12000 | 否 | a positive number | 补齐后的引用消息上下文 UTF-8 字节预算。 | quoted-context |
| `LARK_QUOTED_CONTEXT_MAX_DEPTH` | number | 否 | 4 | 否 | a positive number | 为 Codex 补齐的引用消息链最大深度。 | quoted-context |

## 资源治理

| 配置项 | 类型 | 必填 | 默认值 | 敏感 | 约束 | 说明 | 适用功能 |
|---|---|---:|---|---:|---|---|---|
| `LARK_CHAT_TYPE_CACHE_SIZE` | number | 否 | 1000 | 否 | a non-negative number | 缓存的飞书会话类型上限。 | resource-governance |
| `LARK_DEBUG_LOG` | string | 否 | ~/.codex/channels/lark/logs/debug.log | 否 | - | 本地运行时 debug 日志路径。 | resource-governance |
| `LARK_INBOX_MAX_AGE_HOURS` | number | 否 | 168 | 否 | a non-negative number | 清理时下载 inbox 文件允许保留的最大小时数。 | resource-governance |
| `LARK_INBOX_MAX_BYTES` | number | 否 | 209715200 | 否 | a non-negative number | 下载 inbox 文件的 LRU 字节上限。 | resource-governance |
| `LARK_LATEST_MESSAGE_TRACKER_SIZE` | number | 否 | 1000 | 否 | a non-negative number | 最新入站消息追踪器的条目上限。 | resource-governance |
| `LARK_LOG_ARCHIVE_RETENTION_MONTHS` | number | 否 | 6 | 否 | a non-negative number | 保留的月度日志归档目录数。 | resource-governance |
| `LARK_LOG_MAX_BYTES` | number | 否 | 5242880 | 否 | a non-negative number | 触发日志轮转的文件大小阈值。 | resource-governance |
| `LARK_LOG_MAX_FILES` | number | 否 | 5 | 否 | a non-negative number | 保留的轮转日志文件数。 | resource-governance |
| `LARK_NAME_CACHE_SIZE` | number | 否 | 1000 | 否 | a non-negative number | 缓存的用户与会话显示名称上限。 | resource-governance |
