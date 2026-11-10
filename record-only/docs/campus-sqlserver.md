# Concard 校园数据源

2026-11-05：正式数据源为 SQL Server 的 `[Concard].[dbo].[v_ViewCardInfo]`。服务端通过 TDS + TLS 访问，教师端仍只通过固定证书的 HTTPS 连接本系统服务端。

## 固定读取契约

```sql
SELECT TOP (2) [卡号] AS [card], [姓名] AS [name], [班级] AS [className]
FROM [Concard].[dbo].[v_ViewCardInfo]
WHERE [卡号] = @uid
```

`@uid` 是驱动绑定的 `varchar(20)` 参数。配置验证用相同查询的 `TOP (0)`，不读取学生资料或元数据。只允许上述三列，账号、证件号、身份证号、卡状态、身份均不读取或用于筛选。无 `SELECT *`、自定义 SQL 或列映射；SQL Server 登录建议仅授予此视图三列 SELECT 权限。本外部只读查询使用 `mssql` 驱动；内部 PostgreSQL 业务仍用 Sequelize 结构化 API。

学生 ID 保留既有固定盐 SHA-256；不使用校园表的“账号”。仅提供姓名和班级，兼容 DTO 的 `schoolNumber` 为空字符串，不映射账号或证件号。卡号只在当前查询与匹配校验的内存中存在，不进缓存、历史、预览或日志。零行返回 `STUDENT_NOT_ALLOWED`；多行、卡号不符、空/null 姓名或 null 班级返回 `PROFILE_MISMATCH`。唯一有效资料行允许继续登记，卡状态和身份不参与资格判断。

UI 要求显式选择卡号表示：`decimal` 将规范四字节 UID 转为无符号十进制文本、不补零；`hex8` 使用八位小写十六进制、保留前导零。均不反转字节序。脱敏样本不足以确认实际表示，须逐卡对照后选择，不猜测或尝试多个卡号。

## 教师端仅完整覆盖

登录后打开“设置 → 校园数据源”，填写地址、TCP 端口、SQL Server 登录账号/密码、证书校验方式、卡号表示。当前支持 SQL Server 认证，始终启用 TLS。默认验证服务端证书：可填写 PEM CA，留空则使用服务端默认信任根，地址须符合远端证书。也可显式选择“跳过证书校验”：TLS 仍加密，但不验证 SQL Server 的证书链或主机名，且不得同时提交 CA。旧配置缺少该字段时仍使用验证模式。该选项仅影响服务端到校园 SQL Server 的连接，不改变教师端连接本系统服务端时的证书校验。当前驱动没有稳定的精确 SHA-256 证书指纹验证接口，因此此模式不是指纹绑定；如需指纹绑定，不能把跳过校验视为等价实现。数据库、视图和列固定。

已认证 `POST /api/v1/provider-config` 只接受完整严格对象；没有 GET/PATCH、配置下载、现有值回填或找回接口。未知键/字段映射拒绝。仅返回 `{ "ok": true }` 或固定错误码。沿用共享账号，不新增管理员体系；这是用户允许的校园数据源配置例外，不是通用运维 API。

教师端仅在本次表单、IPC 和 HTTPS 发送所需内存中持有输入：提交时清空表单，preload 传递后清空 IPC 输入，main 请求序列化发送后清空对象，不等待响应。输入不写 SQLite、配置文件、日志、缓存、操作表或离线队列，不自动重试；取消不保存草稿。失败后重新输入。响应丢失时结果可能未确认，可重新提交完整配置。JavaScript/Chromium 不可变字符串及系统副本无法保证物理擦除，销毁指清空可变输入并释放引用。

服务端串行覆盖：验证新连接与三列查询 → AES-256-GCM 加密 → 配置与不含配置值的审计同事务提交 → 后续查询切换。验证/持久化失败保留旧配置。已开始的刷卡完成原查询，后续刷卡使用新配置。不把原始配置放进业务幂等表。未配置时仍可登录和查历史，刷卡拒绝，无 fake 兜底。

2026-11-09 修复：校园配置审计插入显式关闭 Sequelize `RETURNING`。生产 runtime 对 `audit_events` 仍只有 INSERT；不能通过增加 SELECT 权限来绕过旧版本的插入故障。`provider_configs` 仍按已有迁移授予 SELECT/INSERT/UPDATE，无新增权限或业务迁移。

失败阶段可以从响应码和服务端归集日志区分：

| 响应 | 阶段与处理 |
| ---- | ---------- |
| `422 INPUT_INVALID` | 完整输入校验失败，尚未探测 SQL Server |
| `422 PROVIDER_CONFIGURATION_INVALID` | SQL Server 连接、TLS、登录或固定三列 `TOP (0)` 探测失败，未进入 PostgreSQL 保存 |
| `503 PROVIDER_CONFIGURATION_SAVE_FAILED` | SQL Server 探测已通过，内部 PostgreSQL 配置/审计事务未能确认完成；检查本系统数据库权限和存储状态 |
| `429 RATE_LIMITED` | 超过配置接口的每分钟请求上限，稍后重新输入提交 |
| 客户端网络/超时错误 | 没有收到确定响应，不能据此认定服务端未保存；没有自动重发 |

API spool 对探测失败和保存失败分别写入同名固定日志码，只有事件类型、时间和日志标识，不写请求正文、路径、数据库地址、账号、密码或驱动错误详情。Nginx access 仍仅含状态与耗时，不能单凭其中的一条 422/503 推断请求路径。旧服务端的 `SERVICE_UNAVAILABLE` 在 0.1.8 教师端也有明确的服务异常提示。

从 `sha-07a6f464bdf410411e77a6ba137c14c33e713d72` 升级时，保留原卷、`.env`、身份参数和加密密钥，切换到修复版镜像后重建 `api` 与 `log-ingest`（后者同步识别新增日志码）。不需要变更 SQL Server 三列权限，也不需要对审计表授予 SELECT。若使用仓库的预构建镜像配置，先更新 `.env` 的 `RELEASE_TAG`，执行 `docker compose --env-file .env pull api log-ingest`，再执行 `docker compose --env-file .env up -d --no-deps --force-recreate api log-ingest`。教师端重新输入完整配置验证；旧客户端也可使用修复后的保存接口，新客户端提供阶段提示。

## 部署和升级

在 `record-only/` 执行 `corepack yarn tsx scripts/prepare-provider-key.ts`。仅在不存在时创建 `secrets/provider-config-key`，不读取、输出或覆盖已有密钥。该文件为服务器独有的 32 字节随机密钥（64 位十六进制），不分发给教师端，由运维限制文件权限。

`.env` 设置 `PROVIDER_MODE=sqlserver`、`PROVIDER_CONFIG_KEY_HOST_PATH=./secrets/provider-config-key`。Compose 将密钥挂到 API 的 `/run/secrets/provider_config_key`；非 Compose 用 `PROVIDER_CONFIG_KEY_FILE` 指定文件。SQL 模式不需外置模块或 `PROFILE_CONTRACT_CONFIRMED`。旧 `module` 模式仍可显式使用；`provider_credential` 挂载仅为兼容，在 SQL 模式未使用。

保留卷、身份参数和服务器密钥，升级命令：

```bash
docker compose --env-file .env build
docker compose --env-file .env run --rm migrate
docker compose --env-file .env up -d --force-recreate api gateway log-ingest
```

`003-provider-config` ORM 迁移创建 `provider_configs`；同名权限迁移仅授予 runtime 对该表的 SELECT/INSERT/UPDATE。表内保存密文与时间，重启解密恢复。密钥缺失/错误或密文认证失败拒绝启动，不能重新生成已使用密钥。旧集成部署升级也先准备密钥，继续显式 `PROVIDER_MODE=fake`，不会自动连接学校。Docker egress 须能访问 SQL Server 配置的 TCP 端口。

尚待目标验收：学校数据库地址和认证方式、TLS 信任链、真实 UID 与卡号文本对照、查询时延及安装验证。本地隔离测试不能代替正式库联通验收。

## 真实驱动测试入口

仅在独立开发/CI 环境使用 SQL Server Developer 测试实例，不能指向校园数据库：

```bash
yarn tsx scripts/prepare-sqlserver-test.ts
TEST_SQLSERVER_CONFIG=runtime/sqlserver-test/connection.json yarn test:coverage:server
```

脚本用锁定 digest 镜像在 `127.0.0.1:51433` 启动 `cyez-sqlserver-test`，生成测试证书、随机账号和合成资料；同名容器已存在则拒绝替换。Windows WSL Docker 先设 `$env:CYEZ_DOCKER_WSL='1'`；PowerShell 测试变量为 `$env:TEST_SQLSERVER_CONFIG='runtime/sqlserver-test/connection.json'`。Electron 集成也读取此变量；未设置时其 SQL 层使用显式替身，服务端真实 SQL 用例显式跳过。Linux CI 必须设置它执行真实 SQL 测试。可在测试结束后删除此专用容器；测试资料位于 Git 忽略的 `runtime/sqlserver-test/`。

`provider-runtime.test.ts` 使用真实 HTTPS、SQL Server 驱动和正式权限迁移生成的受限 PostgreSQL runtime 账号；验证首次/重复覆盖、重启、刷卡、真实撤销配置 UPDATE 与审计 INSERT 后回滚、阶段日志及不泄露配置值。原 `provider-settings.test.ts` 和 Electron 校园配置测试也使用 runtime 账号运行应用，只有建库、迁移、故障注入及结果检查使用测试 owner。测试部署账号须能创建数据库和角色，可用 `TEST_RUNTIME_ADMIN_URL` 单独提供；它仅用于隔离测试，不是应用的运行凭据。
