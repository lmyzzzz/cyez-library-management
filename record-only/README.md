# 学校图书馆刷卡使用登记系统

2026-10-31 需求修订：校园 API 是学生资料与登记资格的权威来源。本地 `students` 仅缓存成功刷卡得到的资料；每次有效刷卡都重新查询 API，成功时新增或覆盖缓存，失败时不使用旧缓存继续登记。下文与图册中关于“学生必须预置、先查本地授权、未知本地 ID 禁止查询”的旧规则均已撤回。生产不再需要学生 seed；集成 seed 只用于旧数据迁移和测试。

修订日期：2026-10-30。本目录现包含可运行的 Yarn 4 工作区、教师 Electron 客户端、Docker 服务端、数据库迁移、受控 seed、测试及 Windows 打包配置。正式设计仍以本目录文档为准；当前可在明确标识的集成环境运行，生产接入与发布仍需 [TBD 输入](docs/decisions.md#待定输入与延期)。实际验证见[测试报告](docs/verification-report.md)，启动和升级见[运行说明](docs/operations.md)。

本阶段仅由教师 Electron 客户端、Docker 化 Node.js 服务端和 PostgreSQL 组成。教师端通过独立读卡进程接收 Wiegand-34 UID 与人工操作；服务端决定身份、登记、占用、结束和批量修改。设备是被登记使用的资源，本阶段没有学生客户端、锁机、截图、人脸识别或学生端 Rust 服务；读卡 mock 为教师端启动的 Rust 子进程。本目录是独立设计范围，其他目录的状态机和通信规则不作为本版实施依据。

| 正式文档 | 内容 |
| --- | --- |
| [需求与业务规格](docs/specification.md) | 范围、登记/结束流程、数据字典、事务、业务 API、异常与日志 |
| [决策、依据与待定项](docs/decisions.md) | 草图逐项追踪；已决定的问题及来源；待定需求与上线影响 |
| [Docker 部署设计](docs/deployment.md) | 五类服务、网络/卷、.env 共享口令、证书指纹、ORM 迁移、健康与验收 |
| [实施与问题处理计划](docs/implementation-plan.md) | 审查修正、8 个工作项、故障/容量处理、实施顺序与验收依赖 |
| [测试设计](docs/testing.md) | 服务端与客户端分别覆盖单元/集成；真实 PostgreSQL、真实 Electron、CI 门禁 |
| [UI 与 cyez-ui 接入](docs/ui.md) | 登记/设置两个入口、设备编辑、只读历史、10 秒空闲取消、包入口与 Yarn 消费 |
| [正式图册](docs/diagrams.md) | 八张详细 SVG 和统一可编辑 draw.io；黄色标出待定项 |
| [独立读卡进程接口](docs/reader-process.md) | Wiegand-34 UID、继承管道协议、Rust 窗口 mock 和硬件替换 |
| [运行说明](docs/operations.md) | 集成环境启动、缓存迁移、生产配置及升级 |
| [测试报告](docs/verification-report.md) | 本次真实环境验证、覆盖率及未完成验收 |

![刷卡登记版总体架构](docs/architecture.svg)

服务端采用 **Fastify + Sequelize + PostgreSQL**，通过库 API 查询和迁移，不手写 SQL；客户端采用 **Electron + React + cyez-ui**；工程使用 **Yarn 4 workspaces**。UI 实际包名为 `@series/ui` 和 `@series/electron`，使用授权已由用户确认。

所有教师共用一个业务账号，可分配所有设备，无 admin/机房权限。设置页配置 IP、叶证书 SHA-256 指纹和账号密码，应用内固定证书，不安装系统自签名证书；服务端在 `.env` 修改密码后重建 API。

Electron main 收到独立读卡进程的 4 字节 UID 后立即计算固定盐 SHA-256，直接用作学生 ID；卡号与学生资料模型分开，原卡号只在本次经 HTTPS 传给服务端查询校园 API，查询后释放、不落库。服务端重算 ID 校验绑定，每次有效刷卡从校园 API 获取权威资料，成功时新增或覆盖本地缓存；失败时不使用旧缓存继续登记。历史只查内部缓存且不可编辑/删除。登记为连续 10 秒无操作取消，刷卡结束仍为 5 秒确认。设置提供设备添加/编辑/软删除与只读历史列表，无备份/导出功能。

待定项在图中标黄：学生字段、校园 API、真实读卡器接入、部署和发布输入。TBD-02 保留校园 API 的协议、认证、原卡号格式、学生拒绝语义和字段等接入输入，不要求 API 接受哈希。原 TBD-07 预置要求已撤回；跨卡身份迁移 NEXT-01 仍延期，新卡按新哈希 ID 建立独立缓存，不自动合并旧历史。

工作区入口在本目录运行：首次执行 `corepack yarn install --immutable`，日常开发直接执行 `corepack yarn dev`（自动准备 Rust mock、共享包并启动带热更新的 Electron/Vite 开发环境）；`corepack yarn typecheck`，`corepack yarn test:coverage:server`（需要真实 PostgreSQL），`corepack yarn test:coverage:client`，`corepack yarn build`。Windows 需 Rust 1.94.0 + MSVC Build Tools；客户端用 `corepack yarn package:win` 生成 `release/` 内安装包；该目录为本地构建产物，不入源码仓库。GitHub Actions 检查入口为仓库根目录 `.github/workflows/record-only.yml`。
