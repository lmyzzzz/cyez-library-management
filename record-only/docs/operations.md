# 运行、部署与升级

服务端主分支 CI 在测试与构建通过后，将 API、PostgreSQL、HTTPS 网关镜像分别发布到 `ghcr.io/lmyzzzz/cyez-record-only-api`、`ghcr.io/lmyzzzz/cyez-record-only-postgres17`、`ghcr.io/lmyzzzz/cyez-record-only-https-gateway`，各有 `sha-<完整提交号>` 和 `latest` 标签。正式部署建议固定 SHA：在宿主 `.env` 中按 `.env.example` 设置三个 `*_IMAGE` 和同一个 `RELEASE_TAG=sha-<完整提交号>`，保留原 secrets、配置、`DATA_PREFIX` 和命名卷。执行 `docker compose --env-file .env pull` 后，先在临时数据副本验证迁移，再执行 `docker compose --env-file .env up -d --no-build`。如 GHCR 包未设为公开，拉取机器须先以具有 `read:packages` 权限的账号运行 `docker login ghcr.io`。`latest` 适合临时检查，不用于需可复现的部署；本地默认镜像名和构建流程不变。CI 在构建前用临时 dummy env/secrets 执行 `docker compose --env-file <临时文件> config -q`，只校验 Compose 文件，不启动容器、不拉取或构建镜像。

2026-11-07 发布流程：`corepack yarn package:win` 生成无调试入口的正式安装包（当前 `0.1.7`），打包手动输入、串口和 ACR1552U 三个读卡进程，禁止以 integration/development 配置启动。开发用 `corepack yarn dev`；自动化业务回归先运行 `corepack yarn build:client:integration` 再运行 `corepack yarn test:integration:client`，随后构建正式包并执行 `corepack yarn test:release:client`。两种构建共用 `out/`，发布前必须由 `package:win` 重新生产构建，不能直接把集成产物交给 electron-builder。已有合法 production 配置和用户数据保留。教师端运行时版本以 `app.getVersion()` 为准（由另一并行修正项接入），日志与界面不再写死版本号。

2026-11-05：内置 Concard SQL Server 接入已经实现，部署/升级前准备新的服务端加密密钥并运行 `003-provider-config` 迁移。教师端在“设置 → 校园数据源”一次性提交完整新配置。固定只读取卡号、姓名、班级；表内账号不使用。详细字段、单向边界、密钥与命令见[Concard 接入](campus-sqlserver.md)。下文外置 module 仍是可选兼容路径，不是本次 SQL 接入的前置。

2026-10-31 修订：生产不再预置学生，校园 API 成功查询时自动建立或刷新本地缓存。下文 `seed` 示例仅作为集成测试或旧库兼容工具；生产 CLI 已拒绝 `seed`。运行既有服务时先执行新增的 `002-student-cache` ORM 迁移和 `002-student-cache-insert` 权限迁移，再重建 API。不得删除卷；真实 API 的未找到/拒绝响应仍待 TBD-02 确认。

本目录是独立的 Yarn 4 工作区。需要 Node.js 22、Corepack；Windows 教师端构建需要 Windows、Rust 1.94.0 与 MSVC C++ Build Tools，服务端需要 Linux Docker Engine + Compose。`nodeLinker: node-modules` 和 `yarn.lock` 固定依赖。无真实校园 API 或读卡器时，只能运行显式 `integration` 环境；生产不再依赖学生预置名单。

## 集成环境启动

在 `record-only/` 目录执行：

```powershell
corepack yarn install --immutable
corepack yarn tsx scripts/prepare-integration.ts
```

准备脚本只在 `.env.integration` 不存在时创建本地测试证书、随机口令、数据库连接文件和 `runtime/integration-connection.json`，文件均被 Git 忽略；不会覆盖现有数据库凭证。`secrets/` 目录为 `0700`，其中的 secret 文件为 `0444`（原因见[生产接入](#生产接入)的文件式 secret 说明）。若端口或卷名前缀已被占用，在首次启动前编辑 `.env.integration` 的 `HTTPS_PORT`、`DATA_PREFIX`，并同步 `runtime/integration-connection.json` 的端口。已有卷使用过固定盐后不得直接改变身份参数。

```bash
docker compose --env-file .env.integration build
docker compose --env-file .env.integration up -d
# 可选：仅为旧库兼容回归生成集成测试缓存；验证首次刷卡建缓存时应跳过 seed。
# docker compose --env-file .env.integration run --rm --no-deps migrate node apps/server/dist/cli.js seed --integration
docker compose --env-file .env.integration ps
```

集成 seed 仅用于测试或旧库兼容检查，不是启动前置；若运行，须使用 `migrate` 服务的迁移数据库角色。`api` 运行角色可在 provider 成功后新增学生缓存，不提供任意导入接口。教师端先执行 `corepack yarn build:readers` 和 `corepack yarn build:client:integration`，设置 `$env:CYEZ_CLIENT_CONFIG = (Resolve-Path config/client.integration.json).Path` 后运行 `corepack yarn start:client`。应用设置页按 `runtime/integration-connection.json` 输入 IP、端口、指纹和共享账号。Electron 会自动启动 Rust UID 输入窗口，输入 `00000001` 并点击 Send scan；也可在设置/读卡器里覆盖选择串口进程或外部进程。详情见[读卡进程协议](reader-process.md)。测试卡按钮仅在开发/集成构建出现；正式安装包拒绝集成客户端配置，生产服务端配置拒绝 fake provider。

日常开发在 `record-only/` 运行 `corepack yarn dev` 即可：自动增量构建 Rust mock、准备共享包并启动 Electron/Vite。默认使用集成配置和独立的 `runtime/teacher-dev` 数据目录（可用 `CYEZ_CLIENT_CONFIG` / `CYEZ_USER_DATA` 覆盖）。React 与客户端共享源码修改自动热更新，main/preload 修改自动重建并重启/刷新；修改 Rust 后重新运行 `dev` 即自动增量编译。首次安装依赖仍需 `corepack yarn install --immutable`。后端沿用上面的 Compose 启动方式，开发脚本不会创建数据库或预置数据。

开发验证命令：

```powershell
corepack yarn test:reader:mock
corepack yarn test:reader:serial
corepack yarn build:readers
corepack yarn typecheck
corepack yarn format:check
corepack yarn test:coverage:server
corepack yarn test:coverage:client
corepack yarn build:server
corepack yarn build:client:integration
corepack yarn workspace @record/teacher exec install-electron
corepack yarn test:integration:client
corepack yarn package:win
corepack yarn test:release:client
```

服务端集成测试需要独立真实 PostgreSQL，默认 `postgres://cyez_test:integration-only@127.0.0.1:55432/cyez_test`；可用 `TEST_DATABASE_URL` 覆盖。测试会新建随机数据库并迁移，所用账号须有 `CREATEDB`。Compose 端到端联调先完成上述 Compose、`build:readers` 和 `build:client:integration`，无需 seed，不设置 `CYEZ_ELECTRON_EXECUTABLE`；再设置 `COMPOSE_E2E=1`、`TEST_TEACHER_USERNAME`、`TEST_TEACHER_PASSWORD` 与 `COMPOSE_HTTPS_PORT`，运行 `corepack yarn test:integration:client --grep '集成 Electron 连接 Compose'`。正式 exe 由 `test:release:client` 单独验收。测试入口只用于隔离测试部署，绝不指向生产。

## 生产接入

复制 `.env.example` 为宿主受限 `.env`，填入真实部署输入。提供 `secrets/db-password`、`secrets/migration-database-url`、`secrets/runtime-database-url`、`secrets/server.crt`、`secrets/server.key`；SQL 模式另需 `secrets/provider-config-key`。Compose 不再挂载未使用的 `provider_credential` secret，服务端也不读取它；只有显式使用外置 `module` 适配器且该适配器确需运维凭证时，才由运维在本地 compose override 中自行加入只读挂载或环境变量，默认部署不代持该凭证。使用外置 `module` 模式时在 `runtime/adapters/` 放置符合 `CampusProvider` 接口的真实模块；SQL 模式为内置实现，不需要外置模块。模块按供应方协议把临时原卡号发送到固定、可信 HTTPS 目的地，不得记录原卡号或完整请求/响应；仅在 API 确认学生可登记时返回资料，明确拒绝映射为 `STUDENT_NOT_ALLOWED`。先完成 TBD-01/02/03/04 的实际输入核对和独立验收；`PROFILE_CONTRACT_CONFIRMED=true` 仅在字段契约确认后设置。生产配置不得使用 `PROVIDER_MODE=fake`、集成 seed、测试证书或测试卡按钮。

文件式 Compose secrets 不是 Swarm secrets，只是把宿主文件绑定挂载到 `/run/secrets/<名称>`，宿主属主和权限原样保留。`secrets/` 目录必须为 `0700`，每个 secret 文件为 `0444`：这样宿主其他用户不能穿透目录，而容器内非 root UID（db 999、gateway/nginx 101、api/log-ingest/migrate 的 node 1000）可以读取。`scripts/prepare-integration.ts` 与 `scripts/prepare-provider-key.ts` 已按此创建新文件。已有 `0600` 文件的部署须由运维修正：`chmod 0700 secrets && find secrets -maxdepth 1 -type f -exec chmod 0444 {} +`；不改宿主文件属主、不把容器改为 root。文件内容本身未加密，仍须宿主访问控制；已废弃的 `secrets/provider-credential` 可直接删除。

`api` 由 Compose 转发以下可调参数，默认值与 `apps/server/src/config.ts` 一致，可在宿主 `.env` 覆盖：`PREVIEW_TTL_MS=120000`、`PREVIEW_LIMIT=10000`、`BATCH_LIMIT=500`、`SESSION_TTL_MS=3600000`、`PROVIDER_TIMEOUT_MS=5000`、`CAPACITY_OLDEST_WARN_MS=3600000`。改值后 `docker compose up -d --force-recreate api` 生效。`migrate`/`log-ingest` 不继承这些可调值，避免把业务/预览配置扩到日志归集进程。

生产环境不运行学生 seed。`seed` CLI 在生产配置下直接拒绝；学生缓存由每次成功的校园 API 查询新增或覆盖。`migrate` 作业包含 `002-student-cache` 和 `002-student-cache-insert`，并首次写入固定盐等身份配置的指纹；API 要求该指纹存在且匹配，防止在不再运行 seed 后意外更改身份参数。升级既有库时保留旧学生资料和历史，只放宽旧预置列并赋予运行账号学生插入权限。真实 API 对“不存在/无资格”和故障的响应映射须在 TBD-02 输入后完成。

安装包在空白 Windows 用户数据目录可直接启动，显示“首次配置”。输入与服务端完全一致的身份版本（`HASH_VERSION`）、固定盐（`FIXED_SALT_HEX`）和发卡方（`CARD_ISSUER`）；UID 长度固定为 4 字节。确认后客户端仅在缺失时创建 `%APPDATA%/图书馆使用登记/client-config.json`，环境为 `production`，随后进入设置页手动填写服务器 IP、HTTPS 端口、证书指纹和登录信息，再选择读卡进程。首次配置前禁用刷卡和业务动作；界面不读取/回填已保存的身份值，也不覆盖已有配置。固定盐需从受信任的部署渠道取得，不使用集成模板中的测试值。

运维仍可预置 `client-config.json`（或通过 `CYEZ_CLIENT_CONFIG` 指定现有文件），字段为 `environment:"production"`、共享 `identity` 参数及可选 `readerProcess`。显式指定的配置文件缺失或内容无效时仍启动失败，避免误入另一个配置目录。默认读卡进程可为 ACR1552U PC/SC、串口、手动输入或外部进程；未预设读卡进程也可进入设置页，但刷卡不可用。内置进程配置见[管道协议](reader-process.md)。main 不加载 JavaScript 硬件模块。生产仅对显式选择的内置手动输入接受 mock 握手，外部进程不得伪装；`identity.uidByteLengths` 必须为 `[4]`。旧 `readerModule` 配置须替换。Windows 包当前未签名；签名、目标系统安装升级和实物读卡验收需 TBD-03/06。证书更换时按受信任渠道分发新的叶证书指纹，在教师端完整覆盖连接配置；原表单不回填。启动自动登录仅对显式加密保存的密码有效，退出登录后需重新勾选。

## 升级与故障

升级时保留 `DATA_PREFIX`、所有命名卷、身份参数和 secrets；用同版镜像执行单个 `migrate` 作业，再重建 API（仅在 nginx/证书/网关镜像变更时才重建 gateway）。正常升级不得使用 `down -v`。先在临时数据副本上验证扩展迁移。`init-volumes` 会在 db/api/gateway/log-ingest 启动前幂等执行卷属主初始化；若宿主或卷驱动已预置正确属主，可用 `INIT_VOLUMES_MODE=skip` 跳过。改共享密码需要编辑 `.env` 后 `docker compose up -d --force-recreate api`，旧内存会话失效，教师重新登录可查原请求结果。gateway 不再缓存 api 容器 IP：nginx 每 10 秒重新解析 Docker DNS，重建 api 后无需重建 gateway，最多约 10 秒内可能出现短暂 502。固定盐、版本或卡身份变化属于延期的 NEXT-01，不能当普通配置升级。

角色迁移与运行角色口令：`migrate` 只有在设置 `RUNTIME_DATABASE_URL_FILE` 时才执行 `apps/server/src/roles` 下的角色/授权迁移；Compose 已注入 `/run/secrets/runtime_database_url`。在 Compose 外直接运行 `node apps/server/dist/cli.js migrate` 时必须显式提供该变量，否则 runtime 角色不会创建或更新，随后 api/log-ingest 会因认证失败而不可用。运行角色口令轮换不是自动的：修改 `secrets/runtime-database-url` 不会 `ALTER ROLE`（已记录的迁移不会重跑）。轮换须由迁移账号手工 `ALTER ROLE cyez_runtime PASSWORD ...`（或删除角色后重建并重新授权），按 URL 编码规则把新口令写入 `secrets/runtime-database-url` 并重建 api/log-ingest；如权限被重置，按 `apps/server/src/roles/001-runtime-role.ts` 的授权重新 GRANT，不要删除 `role_migrations` 或业务表来强迫迁移重跑。

日志轮转、游标重置与隔离文件：gateway/DB 源日志先写各自 spool 卷，`log-ingest` 的 `FileCollector` 按文件字节偏移把游标保存在 `ingest_cursors` 卷（`<source>-<hash>.json`，含 offset、generation 和可用时无损字符串形式的 inode），只有 PostgreSQL 提交后才推进。同一文件名下 inode 变化或文件被截断时，归集器会从 0 重读并递增 generation，新行使用不同 generation 的稳定 logId，不会与旧行冲突；轮转为新文件名时使用新游标并从 generation 0 开始。通常不需要手工删除游标。手工删除游标会丢失 generation 信息：同一文件已按更高 generation 归集的行可能以 generation 0 的 logId 重新写入（去重只覆盖完全相同的来源+logId），仅在可接受重复计数风险时才这样做；需要重新归集时先停 `log-ingest`。generation 0 保持旧版日志 ID 公式，升级后的重放继续去重。无法解析的游标先保存 `<游标>.corrupt-<时间戳>` 副本，再持久保存 offset 0 和新 generation；确认游标已落盘后才归集，数据库中断或重启不会退回旧代号。无法恢复旧代号时采用时间戳新代号，原内容保留供检查。spool 的提交文件是 `<logId>.json`；新写入器先把内容写进唯一的 `<logId>.json.<uuid>.tmp` 再原子改名，`.tmp` 不被扫描，确认没有写入进程后可清理崩溃遗留的 `.tmp`。归集器扫描 `.json` 提交文件，并额外处理旧版本写入器遗留的 `<logId>.json.pending` 暂存文件：下一轮归集立即校验内容，合法的照常投递，非法的改名为 `<原文件名>.corrupt-<时间戳>`（如 `<logId>.json.pending.corrupt-<时间戳>`）隔离保留，没有静置时长或年龄门槛。损坏的 `<logId>.json` 会改名为 `<logId>.json.corrupt-<时间戳>` 并保留，不会自动删除。新写入器不再产生 `.pending`；滚动升级时旧版 API 仍可能写入 `.pending`，须先停旧 API 再启动新 `log-ingest`（或另行确保没有旧写入器仍在写 `.pending`），否则可能读到写了一半的文件而误隔离，并打断旧写入器的改名。上述隔离文件确认无未交付数据后再按 TBD-05 处理，绝不能为清理删除整个卷。gateway access/error 日志不会自动轮转；需要时在确认已归集后重建 gateway 或让 nginx 重新打开日志（api IP 已由 resolver 处理），DB 源日志按 `log_rotation_age=60` 分钟轮转。

DB 不可用时 gateway readiness 返回 503，恢复后自动返回 200；已提交操作按原 `clientId/requestId` 查询。服务状态受限时只允许可持久化的查询/结束，读卡和新登记暂停。检查 DB、各 spool 和容量水位后扩容并观察归集追赶；未 ACK 日志、持久操作结果和历史记录不能因清理卷而丢失。TBD-05 未确认前没有自动删除策略。
