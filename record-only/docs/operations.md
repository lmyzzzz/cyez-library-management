# 运行、部署与升级

本目录是独立的 Yarn 4 工作区。需要 Node.js 22、Corepack；Windows 教师端构建需要 Windows、Rust 1.94.0 与 MSVC C++ Build Tools，服务端需要 Linux Docker Engine + Compose。`nodeLinker: node-modules` 和 `yarn.lock` 固定依赖。无真实校园 API、读卡器或学校授权名单时，只能运行显式 `integration` 环境。

## 集成环境启动

在 `record-only/` 目录执行：

```powershell
corepack yarn install --immutable
corepack yarn tsx scripts/prepare-integration.ts
```

准备脚本只在 `.env.integration` 不存在时创建本地测试证书、随机口令、数据库连接文件和 `runtime/integration-connection.json`，文件均被 Git 忽略；不会覆盖现有数据库凭证。若端口或卷名前缀已被占用，在首次启动前编辑 `.env.integration` 的 `HTTPS_PORT`、`DATA_PREFIX`，并同步 `runtime/integration-connection.json` 的端口。已有卷使用过固定盐后不得直接改变身份参数。

```bash
docker compose --env-file .env.integration build
docker compose --env-file .env.integration up -d
docker compose --env-file .env.integration run --rm --no-deps migrate node apps/server/dist/cli.js seed --integration
docker compose --env-file .env.integration ps
```

受控 seed 必须用 `migrate` 服务的迁移数据库角色运行。`api` 运行角色不能新增学生；重复执行测试 seed 应返回 `inserted:0`。教师端先执行 `corepack yarn build:reader:mock` 和 `corepack yarn build:client`，设置 `$env:CYEZ_CLIENT_CONFIG = (Resolve-Path config/client.integration.json).Path` 后运行 `corepack yarn start:client`；也可运行 `corepack yarn package:win` 后启动 `release/win-unpacked/图书馆使用登记.exe`。应用设置页按 `runtime/integration-connection.json` 输入 IP、端口、指纹和共享账号。Electron 会自动启动 Rust UID 输入窗口，输入 `00000001` 并点击 Send scan；详情见[读卡进程协议](reader-process.md)。测试卡按钮仅在开发/集成客户端出现；生产客户端配置拒绝缺少真实读卡适配器，生产服务端配置拒绝 fake provider。

开发验证命令：

```powershell
corepack yarn test:reader:mock
corepack yarn build:reader:mock
corepack yarn typecheck
corepack yarn format:check
corepack yarn test:coverage:server
corepack yarn test:coverage:client
corepack yarn build
corepack yarn test:integration:client
corepack yarn package:win
```

服务端集成测试需要独立真实 PostgreSQL，默认 `postgres://cyez_test:integration-only@127.0.0.1:55432/cyez_test`；可用 `TEST_DATABASE_URL` 覆盖。测试会新建随机数据库并迁移，所用账号须有 `CREATEDB`。打包端到端联调需先完成上述 Compose、seed 和 Windows 包，再设置 `COMPOSE_E2E=1`、`TEST_TEACHER_USERNAME`、`TEST_TEACHER_PASSWORD` 与 `COMPOSE_HTTPS_PORT`，运行 `corepack yarn test:integration:client --grep '打包 Electron'`。此入口只用于隔离测试部署，绝不指向生产。

## 生产接入

复制 `.env.example` 为宿主受限 `.env`，填入真实部署输入。提供 `secrets/db-password`、`secrets/migration-database-url`、`secrets/runtime-database-url`、`secrets/provider-credential`、`secrets/server.crt`、`secrets/server.key`，并在 `runtime/adapters/` 放置符合 `CampusProvider` 接口的真实模块。模块按供应方协议把临时原卡号发送到固定、可信 HTTPS 目的地，不得记录原卡号或完整请求/响应。先完成 TBD-01/02/03/04/07 的实际输入核对和独立验收；`PROFILE_CONTRACT_CONFIRMED=true` 仅在字段契约确认后设置。生产配置不得使用 `PROVIDER_MODE=fake`、集成 seed、测试证书或测试卡按钮。

合法学生预置文件通过 `node apps/server/dist/cli.js seed /path/to/seed.json` 交给 `migrate` 容器处理。格式为 `source`、`compatibleIdentityConfirmed:true`、`students` 数组，每项含 64 位十六进制哈希 `id`、`hashVersion`、`issuer` 和已确认白名单 `profile`。文件不得含原卡号。重复同一输入不覆盖资料；冲突整批回滚。来源和授权核验由 TBD-07 责任方提供。

教师端生产 `client-config.json` 位于 Electron userData，字段为 `environment:"production"`、共享 `identity` 参数和 `readerProcess:{kind:"external",executable:"C:/Program Files/cyez-library-reader/reader.exe"}`。原生进程实现[管道协议 v1](reader-process.md)，只交付 Wiegand-34 中间 4 字节 UID；main 不加载 JavaScript 硬件模块。生产配置及握手均拒绝 mock；`identity.uidByteLengths` 必须为 `[4]`。旧 `readerModule` 配置须替换。Windows 包当前未签名；签名、目标系统安装升级和多 DPI 验收需 TBD-06。证书更换时按受信任渠道分发新的叶证书指纹，在教师端重新配置连接。

## 升级与故障

升级时保留 `DATA_PREFIX`、所有命名卷、身份参数和 secrets；用同版镜像执行单个 `migrate` 作业，再重建 API/gateway。正常升级不得使用 `down -v`。先在临时数据副本上验证扩展迁移。改共享密码需要编辑 `.env` 后 `docker compose up -d --force-recreate api`，旧内存会话失效，教师重新登录可查原请求结果。固定盐、版本或卡身份变化属于延期的 NEXT-01，不能当普通配置升级。

DB 不可用时 gateway readiness 返回 503，恢复后自动返回 200；已提交操作按原 `clientId/requestId` 查询。服务状态受限时只允许可持久化的查询/结束，读卡和新登记暂停。检查 DB、各 spool 和容量水位后扩容并观察归集追赶；未 ACK 日志、持久操作结果和历史记录不能因清理卷而丢失。TBD-05 未确认前没有自动删除策略。
