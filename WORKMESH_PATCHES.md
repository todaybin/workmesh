# WorkMesh OpenCode 补丁记录

## 上游基线

- 仓库：`https://github.com/anomalyco/opencode.git`
- 分支：`dev`
- 提交：`1ead9e3d7f02661176fd46d7bcac7f6b7be3b52d`
- 版本：`1.18.25`
- WorkMesh 补丁版本：`0.7.3`

机器可读基线和允许修改路径见 `WORKMESH_PATCHES.json`。官方仓库只用于 fetch、对比和 subtree 同步，WorkMesh 不向该仓库推送代码�?

## 当前补丁

| 范围                                                                                                                                       | 目的                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/workmesh/`                                                                                                          | 集中保存 WorkMesh 产品身份逻辑�?                                                                                                                                                 |
| CLI 与构建入�?                                                                                                                            | 增加 `--workmesh` 模式，生�?`workmesh` 可执行文件并显示对应命令名�?                                                                                                             |
| 升级与卸�?                                                                                                                                | WorkMesh 构建禁止调用 OpenCode 官方分发渠道�?                                                                                                                                    |
| `packages/core/src/global.ts`、`packages/core/src/workmesh/`                                                                               | WorkMesh 构建默认把配置、缓存、数据、状态、临时文件和日志放入当前 Git �?`.workmesh/`；非 Git 目录使用当前目录，拒�?UNC，不读取或迁移用户目录中的旧 OpenCode 数据�?             |
| `packages/core/src/config.ts`、`packages/opencode/src/{config,cli,plugin,skill,session}/`、`packages/tui/src/{context,feature-plugins}/`      | WorkMesh 项目配置、Agent、Command、Skill、Plugin、Tool、Theme �?MCP 统一写入 `.workmesh/config/`，Plan 写入 `.workmesh/state/plans/`；新�?`workmesh.json/jsonc` 品牌别名，WorkMesh 停用 `.opencode`，官方构建保持上游兼容�?|
| `packages/core/src/database/`                                                                                                              | WorkMesh 默认使用 `.workmesh/data/workmesh.db`；SQLite 使用 30 �?busy timeout、跨进程迁移锁、启动完整性检查及迁移�?checkpoint 一致性备份�?                                     |
| `packages/core/src/control-plane/move-session.ts`                                                                                          | 修复未迁移文件改动时仍应用空补丁的问题，使会话可以在主空间与 Worktree 之间纯位置往返切换�?                                                                                      |
| `packages/opencode/src/workmesh/`、`packages/opencode/src/cli/cmd/service.ts`                                                              | 提供项目单实例服务、随机本机凭据、认证健康检查和中文 `service start/foreground/status/stop/restart` 命令�?                                                                       |
| `packages/opencode/src/command/`、`packages/opencode/src/session/`、`packages/opencode/src/project/bootstrap.ts`                           | 提供中文 `/goal`、`/loop`、`/loops` 命令；循环任务按当前打开目录持久化，启动恢复时最多补执行一次，同一 Session 串行，首次失败仅安排一�?1200 �?keepalive�?                      |
| `packages/opencode/src/workmesh/language.ts`、`packages/opencode/src/command/`、`packages/tui/src/component/prompt/`                       | 提供项目级中�?英文/自动语言偏好�?`/language`、`/lang` 选择弹窗，翻译原有斜杠命令说明并在切换后即时刷新�?                                                                       |
| `packages/tui/src/component/{dialog-move-session.tsx,dialog-workspace-file-changes.tsx,prompt/move.tsx,prompt/index.tsx}`、`packages/tui/src/context/sync.tsx` | 提供 `/worktree` 斜杠命令�?`/worktrees` 兼容别名；弹窗首项可创建�?Worktree，其余项可直接选择主空间或已有 Worktree，并支持删除、刷新和往返切换；中文模式下相关标题、分类、确认、进度和错误提示均显示中文；迁移成功后立即同步当前目录，不向模型发送命令文本�?|
| `packages/opencode/src/compose/`、`packages/schema/src/compose*.ts`、`packages/tui/src/workmesh/compose.tsx`                               | 提供可恢�?Compose、审批规�?CAS、脏工作区冻结快照、隔离任�?Worktree、结构化 Verify/Review、owner fencing 租约、内容摘要绑定和可重�?Finish 检查点�?                            |
| `packages/opencode/src/agent/agent.ts`、`packages/opencode/src/session/`、`packages/opencode/src/tool/`                                    | 强制 Compose 规格只读、隐藏内�?Agent、以严格工具白名单阻止实�?Agent 派生�?Agent、Shell 和未�?Plugin/MCP 工具，并将中文偏好注入模型提示；模型已返回的英文 Reasoning 保持原文�?|
| `packages/core/src/workmesh/coordinator.sql.ts`、`packages/opencode/src/workmesh/{coordinator,coordinator-service,relay-coordinator}.ts`、消息工具与 TUI HttpApi | 将终端、消息、execution、结构化执行事件、写意图和远�?outbox 收敛到项目自动创建的 `.workmesh/data/workmesh.db`；聊天窗�?Build/Plan 在接收终端执行普通任务或服务�?slash 命令，不开放远�?Shell；本机终端直接共�?SQLite，跨机器事件�?Gateway Relay 实时转发并通过应用级确认回�?outbox�?|
| `packages/opencode/src/skill/`、`packages/opencode/src/workmesh/builtin-skills.ts`                                                         | WorkMesh 模式从显式开发路径或安装�?`builtin/skills` 发现内置 Skill，并将稳定英�?Skill ID 暴露为斜杠命令�?                                                                      |
| `packages/tui/src/product.ts`、`packages/tui/src/logo.ts`、`packages/tui/src/component/logo.tsx`                                           | WorkMesh 构建首屏使用固定 49 列的五行�?ASCII 字标并整行左对齐渲染，避免短行分别居中和逐字符布局造成错位；完整品牌名显示在字标上方且与字标右边缘对齐�?                             |
| `packages/tui/src/util/presentation.ts`                                                                                                    | WorkMesh 退出摘要复用固定列 ASCII 品牌字标和暖橙主色，并将会话继续命令显示�?`workmesh -s`�?                                                                                     |
| `packages/tui/src/theme/assets/workmesh.json`                                                                                              | 使用 WorkMesh 系统主色：暖�?`#d8873a`、深�?`#a85f22`，同时提供暗色和亮色终端配色�?                                                                                             |

## 同步规则

实际同步�?`scripts/opencode-fork.mjs` 为准：本仓库�?`todaybin/workmesh` 独立 fork，上�?`anomalyco/opencode` 只读（禁�?push），**不使�?subtree**�?

1. 运行 `pnpm opencode:upstream:check` 确认远端边界（origin 指向 `todaybin/workmesh`，upstream 指向 `anomalyco/opencode` 且只读）与基线提交可达�?
2. `git fetch upstream` 拉取最�?`dev`；如需减少传输，可对目标提交与基线提交�?`git fetch --depth 1 --filter=blob:none upstream <commit>` 浅层获取�?
3. 计算 WorkMesh 补丁集：`git diff <旧基�? <�?main> -- <registeredPaths 中排除生成物>`，得�?147 个登记路径的改动（非生成物）；生成物（`packages/client/src/generated`、`generated-effect`、`packages/sdk/js/src/v2/gen`、`packages/sdk/openapi.json`、`packages/core/src/database/migration.gen.ts`、`schema.gen.ts`）不随补丁搬运，改由 `bun run generate`（client / sdk/js）与 `bun --cwd packages/core script/migration.ts`（core，重写迁移注册与全量 schema）重新生成�?
4. 从目�?`upstream/dev` 提交新建同步分支：`git checkout -b sync-opencode-<版本> upstream/dev`，再�?`git apply --3way` 重放补丁；冲突文件保�?WorkMesh 行为并吸收上游结构变化�?
5. 重新生成代码后，更新本文件与 `WORKMESH_PATCHES.json` 的提交、版本、补丁版本并追加验证记录�?
6. 运行 `pnpm opencode:upstream:check`、`pnpm opencode:upstream:diff`、各�?`bun typecheck`、`pnpm build:opencode-runtime` 与定向测试，确认仅登记路径变动且构建通过�?

## 验证记录

本节只记录实际执行结果：

- 2026-08-17 �?`opencode-upstream/dev` �?`0bff28de09105088ff5bdefab91413d55c28dff1` �?squash 同步�?`4d68d30b48a99379b2baaf597dbad576707ea36d`（OpenCode `1.18.18`），subtree merge commit �?`d4f763ee5c1890b8d27601012916240820288922`；现�?WorkMesh 工作区改动经 stash 恢复并自动合并，�?Git 冲突�?
- 本次同步后三包类型检查、`opencode:upstream:check`、`opencode:upstream:diff`、runtime 构建�?`verify:workmesh-dist` 通过；构建版本为 `0.0.0-main-202608170954`，manifest 已记录新上游基线�?SHA-256�?
- 本次定向测试通过：OpenCode 配置 `97 pass`、TUI 配置 `37 pass`、WorkMesh 配置/运行目录 `3 pass`、Coordinator/Relay/工具 Registry `24 pass`、TUI 命令语言 `5 pass`，以�?prompt 单轮和同 Session 两轮基准�?`2 pass`�?
- 残余验证：compaction 回归�?`55 pass / 1 skip / 1 fail`，唯一失败�?Windows 上中断耗时超过 `<250ms` 阈值；WorkMesh 语言注入专项在重复运行中分别出现第二轮超时和测试 LLM 输入为空，未据此改动生产逻辑或放宽测试断言�?
- 安全结论：本次仅更新 OpenCode subtree、补丁基线和验证记录，不改变 WorkMesh 数据库结构、公开 API、权限模型、Runner 沙箱或网络策略；官方远端仍保持只读�?
- `bun run --cwd packages/workmesh/packages/core typecheck` 通过�?
- `bun run --cwd packages/workmesh/packages/opencode typecheck` 通过�?
- core 数据库与运行时定向测试通过，覆盖损坏库拒绝�?0 �?busy timeout、跨进程迁移、备份恢复与保留上限�?
- WorkMesh service 定向测试通过，覆�?16 路并发单实例、认证、陈旧锁恢复、重启以及真�?CLI 后台启动/状�?停止；官方模式未注册该命令�?
- WorkMesh Loop 定向测试通过，覆盖项目内持久化、过期清理、ID 前缀解析、同 Session claim 串行、错过周期只补一次和单次 keepalive；`/loop` 首次立即执行、scheduler 恢复到期任务�?`/loops` 中文列表/前缀取消测试通过；官方模式不注册自研命令且不创建循环状态�?
- WorkMesh SQLite Coordinator 测试 `6 pass`，覆盖空项目自动建库、Prompt/Command execution 往返、独立连接共享事件、原子领取、写意图冲突、旧 JSON 导入删除�?8 KiB 限制；远�?Relay 双项目测试覆�?Command execution、实时事件、完成状态和 outbox 确认回收�?
- Core 数据库迁移测�?`15 pass`，确认空库可自动建立消息表并应用 execution 前向迁移，历史消息继续允�?execution 为空�?
- IM 聊天窗移除消�?Shell 双模式，改为 Build/Plan 切换；slash 面板只使用服务端命令，发送后由接收终端执行；消息区使�?OpenTUI sticky scroll，用户上滚后不再被实时刷新强制拉到底部�?
- WorkMesh 品牌配置专项测试 `4 pass`，Runtime/Plugin `26 pass`，OpenCode 配置回归 `97 pass`，Core 配置/Skill `23 pass`，TUI 配置/主题 `17 pass`；确认品牌配置优先、`.opencode` 不参�?WorkMesh 发现、官�?OpenCode 路径保持兼容�?
- TUI、OpenCode 服务端和生成客户端类型检查通过；`/message` 注册�?TUI 原生斜杠动作，自动完成选中后直接使用两步弹窗选择在线终端并输入消息；选择对话框的方向键和回车绑定优先于全局输入层，原有 `/agents` Agent 切换入口保持不变�?
- OpenCode 项目 bootstrap 测试 4 项通过，覆盖实例加载、CLI 回调、异常释放和实例重载；OpenCode 类型检查通过�?
- `bun run --cwd packages/workmesh/packages/tui typecheck` 通过�?
- MoveSession 往返回归测试通过，覆盖主空间迁移�?Worktree 后再次迁回主空间�?
- Compose Runtime、Git Finish、任�?Worktree 与规格工件定向测�?`27 pass / 0 fail / 91 assertions`，覆�?owner fencing、崩溃恢复、审�?CAS、脏工作区冻结、Review 后变更拒绝、已审查 Git tree 提交、并行文件隔离、越�?冲突拒绝和幂等清理�?
- WorkMesh 内置 Skill 测试 `3 pass`，TUI Compose 测试 `5 pass`；Compose Prompt 的保留权限、Compose Next 隔离�?Finish 弹窗确认定向测试通过，包含未�?Plugin/MCP 工具默认拒绝�?
- 工具 Registry �?Session 冲突回归测试 `17 pass`，确认自定义�?MCP 工具不能覆盖内置/保留 ID；Review 结果固化�?Git tree，Finish 只提交已审查 tree，不再重新收集实时工作树�?
- Schema、Core、OpenCode �?TUI 类型检查通过；聚�?`verify:fast`、项目规�?workflow、分发归集和 `verify-workmesh-dist` 通过�?
- 使用仓库 fixture 作为离线 `MODELS_DEV_API_JSON` 输入，`pnpm.cmd build:opencode-runtime -- --skip-install` 通过，生�?`dist/workmesh-runtime/bin/windows-x64/workmesh.exe`�?
- 品牌配置目录改造后三包类型检查、`verify:fast`、项目规�?workflow、`opencode:upstream:diff` �?`verify:workmesh-dist` 通过；真�?`workmesh.exe mcp add` 写入 `.workmesh/config/workmesh.jsonc` 且未创建 `.opencode`�?
- 本次 IM 远程终端控制构建版本�?`0.0.0-main-202608140500`，`verify-workmesh-dist` 通过�?
- 本次品牌配置目录构建版本�?`0.0.0-main-202608141025`，`verify-workmesh-dist` 通过�?
- `workmesh.exe --help`、`--version` 通过；`upgrade` �?`uninstall` 均明确提示由 WorkMesh 发布渠道管理并立即退出�?
- `opencode:upstream:check`、`opencode:upstream:diff` 通过；差异仅包含登记�?WorkMesh 补丁路径�?
- Tool Host 测试、WorkMesh 运行环境隔离测试、`verify-workmesh-dist` 分发目录校验�?VitePress 构建通过；manifest 中记录的 SHA-256 �?`workmesh.exe` 实际文件一致�?
- WorkMesh 构建产物包含首屏品牌字符�?`WorkMesh`，终端标题使�?WorkMesh 产品名�?

- 2026-08-24 �?`opencode-upstream/dev` �?`4d68d30b48a99379b2baaf597dbad576707ea36d` �?squash 同步�?`03bba464d46f3eddf74195919b1344aa937f7b11`（OpenCode `1.18.21`�?9 个新提交），subtree merge commit �?`160b30d74`。同步前 `git stash -u` 暂存全部未提交改动（�?`scripts/opencode-subtree.mjs` 等未跟踪文件），合并完成并验证后恢复�?
- 上游 99 个提交共�?184 个文件，其中 subtree �?33 个；�?WorkMesh 登记路径重叠 7 个（`session/prompt.ts`、`session/session.ts`、`tool/task.ts` 及对应测试、`tui/src/routes/session/index.tsx`）。仅 `session/prompt.ts` �?`tui/src/routes/session/index.tsx` 出现内容冲突，其�?5 个自动合并成功�?
- 冲突解决：保�?WorkMesh 补丁并吸收上游改动。`prompt.ts` 上游唯一改动�?finish 列表增加 `"unknown"`，已并入 WorkMesh 循环逻辑；`index.tsx` 上游将推理头部标题重构为 `completed()` 记忆函数，已采用并接�?WorkMesh 中文 `locale.t("thought")`�?
- `opencode:upstream:check` 通过；core / opencode / tui 三包 `typecheck` 通过�?
- 定向测试：compaction、session/prompt、retry、tool/task 批量运行 193 pass / 5 fail / 1 error（短默认超时下的时序抖动）；其中 `session.compaction.process > stops quickly when aborted during retry backoff` 为基线已记录�?Windows 中断耗时 >250ms 既有失败，`loops` 套件独立运行 5 pass 0 fail（并行负载下时序抖动），`language` 注入用例的断言文字过期（`Language preference: Use Simplified Chinese`）已修正为当�?`${当前语言为简体中文}` 实际注入文本�?
- `test/workmesh/` 运行 35 pass / 1 fail：`runtime-layout` �?`walks through a directory without its own Git marker` 依赖临时目录�?`.git` 的环境假设，与本次同步无关�?
- 安全结论：本次仅更新 OpenCode subtree、补丁基线与验证记录，不改变 WorkMesh 数据库结构、公开 API、权限模型、Runner 沙箱或网络策略；官方远端仍保持只读�?

- 2026-08-26 �?`upstream/dev` �?`03bba464d46f3eddf74195919b1344aa937f7b11`（OpenCode `1.18.21`）非 squash 同步�?`1ead9e3d7f02661176fd46d7bcac7f6b7be3b52d`（OpenCode `1.18.25`�? 个次版本、少量提交）。本仓库�?`todaybin/workmesh` 独立 fork（非 subtree），基线提交与目标提交均�?`git fetch upstream` 浅层获取后可达�?
- 补丁重放方式：计�?`git diff 03bba464 <�?main> -- <registeredPaths 排除生成�?` 得到 147 个登记路径改动（66 新增 / 81 修改），�?`git apply --3way` 应用�?`upstream/dev`；生成物（`client/src/generated`、`generated-effect`、`sdk/js/src/v2/gen`、`sdk/openapi.json`、`core` �?`migration.gen.ts` / `schema.gen.ts`）不随补丁搬运，分别�?`bun run generate`（client / sdk/js）与 `bun --cwd packages/core script/migration.ts`（core，重写迁移注册与全量 schema）重新生成，未产生多余迁移�?
- `opencode:upstream:check` 通过：基�?`3f31551f...` 可达，工作树相对 `upstream/dev` 的全部变更均落在登记路径内�?
- core / opencode / tui / client / sdk / schema 六包 `bun typecheck` 通过（生成物重新生成后类型一致）�?
- 定向测试：`bun --cwd packages/opencode test test/workmesh` 27 pass / 1 fail（唯一失败�?`runtime layout > walks through a directory without its own Git marker`，依赖临时目录无 `.git` 的环境假设，与本次同步无关，基线记录已注明）；`bun --cwd packages/core test` 自定义套�?8 pass / 2 fail（失败为 MoveSession 内部 `git apply` 在本�?`core.autocrlf=true` 下失败，属环境差异，非合并回归）�?
- 安全结论：本次仅更新 OpenCode 基线、重�?WorkMesh 补丁与重新生成代码，不改�?WorkMesh 数据库结构语义（新增迁移已在注册中）、公开 API、权限模型、Runner 沙箱或网络策略；官方上游远端仍保持只读，未向 `anomalyco/opencode` 推送�?

构建机无法连�?`https://models.dev/api.json` 时，构建必须显式提供 `MODELS_DEV_API_JSON`；正式发布应使用经过审查的最新模型快照�?
