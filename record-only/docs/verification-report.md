# 产品验证报告

## 2026-11-05 教师端 0.1.3 发布清理

正式构建在编译阶段移除开发提示、测试卡按钮/IPC、手动 UID 选项和诊断面板；NSIS 资源只包含串口与 ACR1552U 进程。禁用 DevTools 和默认 Electron 菜单，拒绝非 production 客户端配置，运行环境变量不能打开测试功能。保留必要的连接、读卡、容量、断线与待确认提交提示以及持久化脱敏日志。开发使用 `yarn dev` 或显式 `build:client:integration`。

| 检查 | 本次实际结果 |
| --- | --- |
| 依赖与静态检查 | `yarn install --immutable --mode=skip-build`、TypeScript、Prettier 通过；标准打包随后完成 SQLite 原生依赖重建 |
| 客户端单元/组件 | 60 项通过；覆盖率 statements 88.96%、branches 84.45%、functions 87.31%、lines 89.77%，门禁通过 |
| Electron 集成构建 | 11 项通过；Compose 专用用例在默认套件显式跳过。使用真实 Electron、PostgreSQL、SQLite 和 TLS；本次 SQL 配置用例使用显式替身，未重跑真实 SQL Server fixture |
| Compose 专用回归 | 改为启动显式集成构建后单独执行 1 项通过：Electron → HTTPS gateway → API → PostgreSQL 的登记、结束、只读历史；使用现有隔离集成服务及测试资料 |
| 正式 exe 验收 | 2 项通过：读取实际 asar/资源清单，无 mock exe、测试动作/文案或应用源码映射；启动实际 `release/win-unpacked/图书馆使用登记.exe`，完成首次配置、TLS 登录与设备显示，验证设置页无诊断/mock、测试 IPC 被拒绝，强行调用 `openDevTools` 仍未打开，默认菜单为空；检查主界面与校园设置截图 |
| Windows 发布构建 | 标准 `corepack yarn package:win` 成功；`release/cyez-library-0.1.3-x64-setup.exe`，SHA-256 `e3e196585f20dd608bc593d8e5c1ff0ecc789583109b17ccc7acfa9a57310f9a`，Authenticode `NotSigned` |

CI 已拆分集成构建业务回归与正式包验收；发布检查入口为 `yarn test:release:client`，输出 `test-results/client-release.xml` 和界面截图。首次 CI 服务端检查通过；Windows 暴露原有集成用例写死 Electron 下载路径的问题，已改用 Playwright 的官方 Electron 解析并在 CI 显式执行 `install-electron`，适配全新机器的按需下载行为。本次未修改服务端业务逻辑，未在本机重跑 Docker 镜像构建或学校 SQL Server/真实读卡器验收。学校连接资料、实卡对照、Windows 签名与目标机器安装升级等待验收项继续保留；以上实际 exe 验证不等于已在另一台机器执行 NSIS 安装或升级。

## 历次验证记录

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

## 2026-11-03 自动局部更新与橙色主题验证

沿用每 3 秒轮询与 React 稳定行 ID 更新数据，自动轮询及回到前台不再进入主动刷新加载态；每秒计时更新限制在时长单元格。连接表单不再因状态中的证书指纹变化重新挂载。主题采用 `#FFA924` 主色、`#FFA647` 悬停色，搭配暖白和浅橙背景及深色按钮文字。

| 项目 | 本轮实际结果 |
| --- | --- |
| 客户端单元/组件与覆盖率 | 50 项通过；statements 88.75%、branches 83.4%、functions 87.06%、lines 89.45%；门禁通过。新增多次轮询保留行节点、滚动、勾选、焦点、草稿、选区与文本框尺寸，以及连接表单状态更新、空态无骨架闪烁回归测试；空态回归在旧实现下失败、修复后通过 |
| 真实 Electron 集成 | 完整套件 7 项通过，1 项 Compose 专用用例显式跳过。新增实际 PostgreSQL 两次更新设备资料后自动显示最新值，同时保留真实滚动位置、搜索焦点和未保存设备备注的测试；现有 TLS、SQLite 重启、IPC 与业务闭环测试通过 |
| Windows 发布验证 | NSIS 安装包重新生成，SHA-256 `b001a3a0611d06c0406a8b5d49f035c527c59e7cf29d6537849d2c52951749eb`；使用本次解包 exe 单独重跑自动局部更新用例，1 项通过。未进行目标 Windows 安装/升级验收 |
| 静态与视觉检查 | TypeScript、Prettier、客户端构建通过；已检查真实 Electron 的新主题截图 `test-results/electron/amber-devices.png`，按钮、导航、表格及状态文字可读 |

本轮仅修改教师端和对应文档、测试；未重新执行本机服务端套件、Compose 专用业务用例或 Docker 构建，其既有结果保留在前述报告中。真实校园 API、读卡器、目标部署、签名及其他外部验收边界未改变。

## 2026-11-03 串口读卡与自动登录增量验证

新增独立 Rust `cyez-reader-serial` 进程，内置串口和外部读卡进程可在设置页整份覆盖选择。串口按 LF/CRLF 每行读取一个 8 位十六进制 UID，严格保留前导零；端口、比特率、数据位、校验位、停止位和流控由教师界面提交。生产禁用 mock，允许以“读卡进程未配置”状态启动设置页。连接和读卡配置不回填到设置表单；临时登录输入提交后清空。自动登录仅在显式保存密码且 OS 加密可用时启用，并核对原服务器来源。

| 项目 | 本轮实际结果 |
| --- | --- |
| Rust 串口进程 | Windows Rust 1.94 `cargo test --locked` 的 3 项参数、UID、控制消息测试通过，release exe 已构建。WSL/Linux `serialport::TTYPort::pair()` 伪终端 2 项实际进程测试通过：分片字节流、连续两行、CRLF、前导零、正常关闭与格式错误拒绝 |
| 客户端单元与覆盖率 | 54 项通过；statements 89.02%、branches 84.12%、functions 86.73%、lines 89.76%，覆盖率门禁通过；含自动登录限制、启动恢复、退出禁用、读卡参数验证与设置表单无回填 |
| 真实 Electron 集成 | Windows 打包应用 9 项通过，Compose 专用 1 项按默认设置跳过；使用随机测试 PostgreSQL、TLS、SQLite 与实际 Electron，新增自动登录跨重启、串口枚举、无效端口切换失败恢复原 mock 进程、本地读卡配置覆盖及生产客户端不预设读卡进程时可打开设置且禁止 mock 的验证 |
| 构建与静态校验 | Yarn immutable install、TypeScript、Prettier、Cargo fmt、共享包及客户端构建通过；NSIS 安装包含 `resources/readers/cyez-reader-serial.exe`（284672 字节），SHA-256 `900217b326c30440ae2f6c34d393884c3df656d0f0b2b1fabb17c1b6ab8d26e9`；仍未签名。已检查真实 Electron 设置页截图 `test-results/electron/serial-settings.png` |

本轮没有真实 Windows 串口读卡器与校园系统，因此实物端口、具体设备串口参数、卡号行编码对照及校园 API 联调仍需 TBD-02/03 输入；Linux 伪终端和开发 mock 不构成目标硬件验收。服务端业务代码、Docker 镜像与 Compose 专用用例本轮未改或重跑；其既有结果见上文。

## 2026-11-03 串口卡号进制配置增量验证

设置页新增固定 8 位十六进制、可变宽度十六进制、十进制、八进制和二进制选项；Rust 串口进程将每行无符号 32 位数转换为统一的 8 位小写十六进制 UID。旧配置缺少 `format` 字段时默认固定 8 位十六进制。接口约束和配置示例见[读卡进程协议](reader-process.md)。

| 项目 | 本轮实际结果 |
| --- | --- |
| Rust 单元与串口集成 | Windows Rust 1.94.0 单元 3 项通过；WSL Linux 单元 3 项和实际伪终端 3 项通过。覆盖前导零、各进制最大 32 位值、溢出、非法字符、CRLF、多行输入、错误帧退出与正常关闭 |
| 客户端 | TypeScript、Prettier、Cargo fmt 通过；单元/组件 54 项通过，覆盖率 statements 89.04%、branches 84.12%、functions 86.77%、lines 89.78%，门禁通过；格式参数从界面到配置校验、进程启动参数的测试通过 |
| 发布与真实 Electron | Windows release 串口 exe、教师端构建和 NSIS 包生成；解包发布版 Electron 集成 9 项通过，Compose 专用 1 项按默认设置跳过。安装包 SHA-256 `83ef97351ffacebd9d8134944bc832246d958825a01d9f4e3a057c0fd8336ad6`，未签名 |

本轮仍未取得真实串口读卡器及其卡号对照样本，因此各进制对实际硬件输出的匹配、Windows 实体串口和校园 API 查询未完成验收。服务端与 Docker 代码未变，本轮未重跑服务端和 Compose 测试。

## 2026-11-04 刷卡流程全屏界面验证

刷卡登记与刷卡结束改为占满教师端窗口内容区的聚焦页面，保留窗口控制，隐藏侧栏与普通页面头部；手动结束和批量结束仍使用原有对话框。登记页采用备注和设备选择并排布局，窄窗口纵向排列，操作栏保持可见。

| 项目 | 本轮实际结果 |
| --- | --- |
| 客户端单元/组件 | 54 项通过；覆盖率 statements 88.78%、branches 84.02%、functions 86.77%、lines 89.50%，门禁通过 |
| 真实 Electron | 开发构建和解包发布版各 9 项通过，Compose 专用 1 项按默认设置跳过；真实 PostgreSQL、TLS、SQLite 流程中检查两种刷卡页全宽、取消后侧栏恢复，800×650 窄窗口无横向溢出 |
| 构建与视觉 | TypeScript、Prettier、客户端构建和 Windows NSIS 打包通过；已检查 `test-results/electron/scan-registration-fullscreen.png`、`scan-registration-narrow.png`、`scan-end-fullscreen.png`。安装包 SHA-256 `fc11cb6a28d3f611ed7fd1c6206aca6cfd1ea034b8e82c22614acd7e50482a54`，未签名 |

本轮仅修改教师端界面及对应测试和文档；服务端、Docker 与 Compose 专用业务用例未改或重跑。真实读卡器、校园 API 和目标发布环境验收仍需前述外部输入。

## 2026-11-04 ACR1552U-M1 PC/SC 读卡进程验证

新增独立 Rust `cyez-reader-acr1552`，通过 Windows PC/SC 枚举 ACR1552 系列非 SAM/接触式接口，按状态变化每次贴卡读取一次 `FF CA 00 00 00` 响应。只有恰好 4 字节 UID 与 `90 00` 成功状态才进入现有 JSON Lines v1；不读扇区、不截断较长 UID。教师设置页可精确选择枚举设备并配置 100–2000 ms 状态检查间隔，配置仍整份覆盖且不回填。生产打包资源包含该进程。

| 项目 | 本轮实际结果 |
| --- | --- |
| Rust | Windows `cargo test --locked -p cyez-reader-acr1552` 4 项通过；参数白名单、APDU 响应长度与状态字、一次贴卡一次扫描及控制消息均有测试；release exe 构建通过，打包资源 243200 字节 |
| 客户端 | TypeScript、Prettier、Cargo fmt 通过；单元/组件 56 项通过；覆盖率 statements 88.84%、branches 84.18%、functions 87.02%、lines 89.63%，门禁通过 |
| 真实 Electron | 本机 PostgreSQL、TLS、SQLite 和解包发布版 Electron 集成 9 项通过，Compose 专用 1 项按条件跳过；设置页验证 ACR1552U 选项、空设备禁用提交、默认间隔，并检查 `test-results/electron/acr1552-settings.png` |
| Windows 发布 | NSIS 安装包生成，包含 `resources/readers/cyez-reader-acr1552.exe`；SHA-256 `001fa270c47e7a07dc912f81536847224188534b5db3ed9f0041997af2efef71`；未签名 |

本机未连接 ACR1552U-M1，Windows Smart Card 服务无设备时停止，`--list-readers` 返回失败且不伪造设备。**未完成真实验收**：目标机器驱动/WinSCard 枚举、实卡连续贴卡及移卡行为、4 字节 PC/SC UID 与 Wiegand-34 中间数据位及校园 API 接受的原卡号逐卡对照。7/10 字节卡按协议拒绝，若目标卡属于这类需提供业务确认的新规则。服务端与 Docker 本轮未修改或重跑。

## 2026-11-05 Windows 空白安装首次配置验证

教师端 `0.1.1` 在默认用户数据目录缺少 `client-config.json` 时进入软件内的首次配置页。身份版本、固定盐及发卡方由部署方提供，UID 长度固定为 4 字节；提交后仅在文件不存在时创建生产配置并进入连接设置。配置前业务动作和刷卡被拒绝，已有配置不可由此入口读取或覆盖。显式 `CYEZ_CLIENT_CONFIG` 缺失仍按配置错误处理。原有读取正常配置、TLS/登录、读卡进程、SQLite 待确认操作的流程保持不变。

| 项目 | 本轮实际结果 |
| --- | --- |
| 客户端测试 | TypeScript、Prettier、Yarn `--immutable` 通过；单元/组件 58 项通过；覆盖率 statements 88.73%、branches 84.31%、functions 87.07%、lines 89.48%，门禁通过 |
| 真实 Electron | 使用真实 PostgreSQL、TLS、SQLite 和 `0.1.1` 解包版运行 10 项通过，Compose 专用 1 项按条件跳过。新增用例从空白用户数据目录启动，验证配置前 IPC 拒绝、UI 提交后创建配置、进入设置、重复配置拒绝及重启后不再显示首次配置。已检查 `test-results/electron/first-run.png` |
| Windows 发布 | NSIS 安装包 `release/cyez-library-0.1.1-x64-setup.exe` 构建通过，SHA-256 `1bcc54a0c4f57f702a48cf1df9205cec4a286ee7c87083f3e13c1c6baf1f6e0a`；Authenticode 状态 `NotSigned` |

本轮没有在用户报错的另一台机器执行安装、升级或真实读卡测试；该机器仍须提供与服务器一致的正式身份参数，并手动配置服务器地址、证书指纹和读卡器。服务端与 Docker 本轮未修改或重跑。

## 2026-11-05 Concard 接入与校园配置单向覆盖

教师端 `0.1.2` 新增“校园数据源”设置页；SQL Server 适配器只读取固定视图的卡号、姓名、班级，不读取账号、证件号、身份证号、卡状态或身份。原固定盐哈希 ID 不变。输入发送后清空，不进入本机持久层；服务端验证新连接后加密保存，同事务记录无配置值的审计，后续查询切换。完整契约、迁移及启动说明见 [Concard 接入](campus-sqlserver.md)。

| 项目 | 本轮实际结果 |
| --- | --- |
| 服务端单元/集成及门禁 | 41 项通过，含真实 PostgreSQL 和 TLS SQL Server。覆盖率 statements 92.35%、branches 88.74%、functions 95.62%、lines 93.81%，门禁通过 |
| SQL Server 真实行为 | 独立 SQL Server 2022 Docker fixture，固定镜像 digest；仅授权三列的 SQL 登录成功读取中文 varchar 姓名/班级；十进制与十六进制查询、零行拒绝、多行和空姓名拒绝、不受信任证书拒绝均实测。无校园真实学生资料 |
| 配置故障与持久层 | 真实 PG 验证无配置拒绝、未认证拒绝、未知字段拒绝、GET/PATCH/PUT/DELETE 不存在、密文持久化、失败保留旧配置、重启恢复、完整覆盖后切换；审计写失败事务回滚、错误密钥不能重置旧数据 |
| 客户端单元/组件 | 60 项通过；覆盖率 statements 88.96%、branches 84.23%、functions 87.31%、lines 89.76%，门禁通过。发送后立即清空，网络失败不进入本机设置/队列/日志；不请求已有校园配置 |
| 真实发布版 Electron | `0.1.2` 解包版完整套件 11 项通过，Compose 专用 1 项显式跳过。本次新增用例走真实 Electron → HTTPS → Fastify/PG → TLS SQL Server，验证覆盖、清空、页面重载不回填、刷卡取得资料及本机文件无 SQL 用户名/密码（UTF-8/UTF-16）；已有 pin、持久队列、首次配置等回归通过 |
| 构建/静态 | Yarn immutable（本机 skip-build）、TypeScript、Prettier、server/client 构建通过；Docker API 镜像 `cyez-record-only:sqlserver-check` 构建成功，image ID 前缀 `afe1ab06c3ac`；图册生成源/产物同步 |
| Windows 安装包 | `release/cyez-library-0.1.2-x64-setup.exe`，SHA-256 `7cb0bf7d78755965508799fae5926f7cd873ce8ee7aaa3095af0b486ad2b9fff`，未签名。本机已有进程锁住 sqlite3 原生模块，因此本次以 `--config.npmRebuild=false` 打包已通过实际 Electron 验证的原生模块；仓库/CI 标准打包仍重建原生依赖。发布版随后已完整验证 |

Linux CI 新增独立 SQL Server fixture，服务端覆盖率显式启用真实 SQL 测试。Windows CI 未提供 SQL 实例时，新 Electron 用例使用明确 SQL 替身；本机上述发布版用例设置了 `TEST_SQLSERVER_CONFIG`，实际使用 SQL 驱动。已检查截图 `test-results/electron/provider-settings.png`。

未完成：学校正式 SQL Server 的地址/认证/TLS 信任链和网络联通；真实卡 UID 与视图卡号文本的进制、大小写、前导零和字节序对照；目标读卡器、另一台 Windows 的安装升级与签名。三列已确定，不再等待可配置字段映射；校园表账号不稳定，绝不替换既有标识。目标输入只能在设置页本次输入，不能用开发 fixture 冒充正式联通。NEXT 项仍延期。
