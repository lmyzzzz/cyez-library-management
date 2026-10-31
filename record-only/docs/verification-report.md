# 产品验证报告

2026-10-29，Windows 11 / WSL Linux Docker Engine，Node 22、Yarn 4.10.3、PostgreSQL 17。测试仅使用随机凭证、测试证书和集成学生，无生产资料。此报告区分真实基础设施联调与受控替身；不代表目标学校的实机验收。

| 项目 | 实际结果 |
| --- | --- |
| 不可变依赖、类型、格式 | `yarn install --immutable` 已在 Docker 构建中通过；`yarn typecheck`、`yarn format:check` 通过 |
| 服务端单元/集成 | 32 项通过；真实 PostgreSQL 随机测试库、Sequelize 事务、迁移、条件唯一约束、并发、幂等、seed、容量状态和日志去重 |
| 服务端覆盖率门禁 | statements 93.43%、branches 89.68%、functions 97.43%、lines 94.84%；`service.ts` 分支 91.11%，通过 |
| 客户端单元/组件 | 39 项通过；读卡哈希/计时、设置/登记/批量/历史交互、SQLite 重启及边界、协调器恢复、固定目标传输 |
| 客户端覆盖率门禁 | statements 87.24%、branches 83.24%、functions 85.55%、lines 88.24%；pin/reader/timers 关键分支门禁通过 |
| 真实 Electron 集成 | 6 项通过、1 项专用 Compose 用例单独通过；Windows main/preload/renderer、cyez-ui、真实 SQLite、OS 加密、实际 TLS 握手，错误 pin/过期/SAN/重定向/HTTP 拒绝，业务闭环和只读历史；另验证 IPC 白名单/schema、实际新窗口拒绝及导航处理器。默认套件中 Compose 专用用例显式跳过 |
| Compose 集成 | 五服务镜像构建、迁移、受控 seed、网关 HTTPS 入口、打包 Electron → gateway → API → PG 的登记/结束/历史闭环通过；DB/API/gateway 重建后 3 名学生和记录保留 |
| 网络与日志 | 仅 gateway 发布宿主 `127.0.0.1:8443`，API/PG/log-ingest 不发布；gateway、DB、API 来源均实际归集至 `app_logs`；DB 停机 readiness 为 503，恢复为 200 |
| 受控 seed | 首次 `inserted:3`，重跑 `inserted:0, unchanged:3`；运行角色不能 seed，迁移角色可 seed |
| 日志归集恢复 | 新增真实 PostgreSQL 测试：连接关闭时 API spool 和 gateway 原文件保留；重连后 240 行分两批接收，游标回退重放不重复入库，未完成的末行不提前 ACK |
| Windows 发布构建 | Electron x64 NSIS 包生成于 `release/cyez-library-0.1.0-x64-setup.exe`，本次 SHA-256 为 `3c4bd1bdf6fe75433a94d2665f0b561e9e706475d6f523e92dcfa6b5214615e9`；Authenticode 为 `NotSigned` |

同源 SQLite 待确认命令跨 Electron 重启后按原键查询/重试、异源意图不重放，已在完整 6 项真实 Electron 套件复测通过。GitHub Actions [run 40903786625](https://github.com/lmyzzzz/cyez-library-management/actions/runs/40903786625) 的 Linux 服务端和 Windows 客户端 job 均通过；远端 Windows 用解包发布应用完成 39 项单元/组件测试、6 项 Electron 集成测试及 NSIS 构建，专用 Compose 用例按设计跳过，本机已单独执行。远端上传 `server-coverage`（含镜像内容 ID、提交号和工具链版本）与 `windows-client-results`（含安装包）制品。测试中 fake campus provider、集成测试卡和测试证书明确只允许开发/集成配置；不能据此判定真实校园系统已接通。

未完成的真实验收：TBD-01 校方最终字段/显示白名单；TBD-02 真实校园 API 协议、凭证、限额及 HTTPS 联调；TBD-03 真实读卡器型号、驱动/设备传输、发行方、规范 UID 对照样本和实机扫描（Wiegand-34 中间 4 字节 UID 及 IPC v1 已确定）；TBD-04 目标 Linux/网络/IP SAN 证书与指纹发放、目标磁盘容量标定；TBD-05 保留期和产品外清理规则；TBD-06 Windows 签名材料、安装/卸载/升级与目标 DPI/无障碍；TBD-07 真实合法学生来源及受控预置。NEXT-01 跨卡/换盐身份迁移继续延期。

测试矩阵中仍未完成的高风险实测包括真实校园 provider 故障与限额、真实读卡器输入、目标环境磁盘写满/长时间日志积压及追赶时间、目标 Windows 安装升级与目标 Linux 部署。当前构建可供集成验证，不可称为生产验收完成。

## 2026-10-30 独立读卡进程增量验证

此增量以用户新增要求为准，移除 JavaScript 硬件模块加载，交付[进程协议 v1](reader-process.md)、Electron 管道适配器、Rust Windows UID 输入窗口及打包资源。未连接真实硬件，未修改校园 API 适配边界。

| 项目 | 实际结果 |
| --- | --- |
| Rust | Rust 1.94.0 / Cargo.lock；fmt、3 项单元测试及 Windows release 构建通过；Wiegand-34 奇偶位、32 位 UID、shutdown/EOF 校验 |
| 实际子进程 | 8 项客户端进程测试通过：真实 Rust 握手/scan/前导零/生产拒绝 mock/正常关闭重启；独立故障进程验证分帧/多行/CRLF、错误协议/长度/顺序、重复握手、缺少 exe、超时、强制退出和 UID buffer 清理 |
| 原生窗口手测 | Node 以隐藏控制台方式启动，Rust 窗口可见；输入 `00AbCd01` 后点击 Send scan，Node 实际收到 `{"type":"scan","uidHex":"00abcd01"}`，窗口显示 Scan sent 并清空输入。修复了初始隐藏窗口问题后复验通过 |
| 客户端覆盖率 | 47 项单元/组件测试通过；statements 88.22%、branches 83.51%、functions 86.31%、lines 89.24%；门禁通过 |
| 服务端回归 | 32 项通过，真实 PostgreSQL；statements 93.43%、branches 89.68%、functions 97.43%、lines 94.84%；门禁通过 |
| Electron | 未打包入口的 Rust 自动启动检查通过；随后打包 exe 的完整 6 项 Electron/TLS/SQLite/IPC 测试通过，确认资源目录 mock 握手。Compose 专用用例默认显式跳过，已另行启用并通过登记/结束/历史闭环 |
| 锁定依赖及静态检查 | Yarn immutable install、TypeScript、Prettier、Rust fmt、SVG/draw.io 生成一致性通过；更新图已渲染检查 |
| Docker 重建 | 首次直连下载 Yarn 超时；使用本机既有代理重试后成功，镜像 `cyez-record-only:reader-ipc`，ID 前缀 `f4626aa9d87e`；构建上下文 1.403 MB，未包含 Rust target |
| Windows 制品 | `release/cyez-library-0.1.0-x64-setup.exe`，119453763 字节；SHA-256 `29dae3f58ea85e5de65956c3628c386ba928703c33ae2f1dc58116725dc9e7e1`；仍为 NotSigned。包内 `resources/readers/cyez-reader-mock.exe` 为 228864 字节 |

CI 已新增 Rust fmt/test/release 构建步骤；客户端自动化需先构建 Rust exe。真实 Electron 业务操作仍使用显式测试卡，Rust 手动窗口到管道另行实际验证；未将两种验证合称真实硬件端到端验收。上述旧报告的已验证容器重建、日志积压和容量行为未因本轮新增读卡代码重新扩大声明。其余 TBD 与 NEXT-01 继续保留。

## 2026-10-31 学生资料缓存修订验证

校园 API 成功即允许登记；本地学生行仅用于设备列表与历史查询。每次新刷卡先查询 provider，再事务性新增或覆盖缓存。重复提交同一个 scanId 是幂等重试，不重复查询。API 明确拒绝、故障或资料字段无效时不使用旧缓存生成可提交预览。旧 `isEnabled`/`seedDigest` 字段不再参与授权；原 TBD-07 生产预置要求已撤回。

| 项目 | 本轮实际结果 |
| --- | --- |
| 无 seed 实库验证 | 新建独立 PostgreSQL 库，依次执行 `001`、`002` 迁移；确认旧列从非空改为可空。未写入固定盐指纹时 API 拒绝启动，迁移初始化后重复执行不改变指纹，换盐被拒绝；学生表为空时 API 成功刷卡插入缓存并登记，第二次刷卡覆盖所有字段，原旧库 `isEnabled=false` 不阻止成功查询；拒绝、故障和字段不完整都不覆盖缓存，设备列表与历史读取不调用 provider，故障期间可手动结束 |
| 服务端 | 真实 PostgreSQL 33 项通过；statements 92.99%、branches 89.83%、functions 96.87%、lines 94.44%；`service.ts` 分支 91.89%，覆盖率门禁通过 |
| 客户端 | 47 项单元/组件测试通过；statements 88.22%、branches 83.51%、functions 86.31%、lines 89.11%；真实 Electron 集成 6 项通过，测试库不执行学生 seed，首次刷卡从空缓存开始；显式 Compose 用例另行通过 |
| 集成部署 | Docker API 镜像重建并通过迁移；DB、API、gateway 与 log-ingest 正常，API/DB healthy，现有命名卷保留。打包 Electron 经 HTTPS gateway → API → PostgreSQL 的登记/结束/只读历史用例通过；另以受信任测试证书和运行账号经真实 HTTPS 网关刷随机未缓存 UID，首次返回版本 1，再次刷卡返回版本 2，验证运行账号首次插入权限 |
| Rust 与发布 | Rust mock 3 项测试通过；Windows x64 NSIS 安装包重新生成，SHA-256 `cb94ce8c7740527feb73d50ec6fd572525469628981d2cb591832242e7ee2291`，Authenticode `NotSigned` |
| 静态校验 | TypeScript、Prettier、图源/SVG 一致性通过；Docker 构建中的 Yarn `--immutable` 通过 |

测试仍使用开发/集成 FakeProvider、测试证书与测试 UID。TBD-01/02 的真实学生字段、校园 API 协议、拒绝语义和 HTTPS 联调，TBD-03 真实读卡器，TBD-04 目标部署与容量，TBD-05 保留期，TBD-06 签名/目标 Windows 验收尚待外部输入；真实校园 API 故障/限额、目标磁盘写满与长时间日志积压仍未实测。NEXT-01 跨卡/换盐身份迁移继续延期。此前报告的 TBD-07 行仅保留历史记录，不再构成未完成验收项。

首次推送的 [CI run 41149731844](https://github.com/lmyzzzz/cyez-library-management/actions/runs/41149731844) 中服务端通过，Windows 普通单元测试通过，但覆盖率阶段有 3 项 SQLite/协调器测试触发 Vitest 默认 5 秒超时，后续打包步骤被跳过。随后将客户端测试文件改为串行执行、单项超时设为 20 秒；不启用重试或调低覆盖率阈值。本机重新运行 47 项覆盖率测试全部通过；远端后续运行结果应独立查看，不把首次失败计为成功。
