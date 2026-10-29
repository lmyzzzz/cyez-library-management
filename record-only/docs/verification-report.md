# 产品验证报告

2026-10-29，Windows 11 / WSL Linux Docker Engine，Node 22、Yarn 4.10.3、PostgreSQL 17。测试仅使用随机凭证、测试证书和集成学生，无生产资料。此报告区分真实基础设施联调与受控替身；不代表目标学校的实机验收。

| 项目 | 实际结果 |
| --- | --- |
| 不可变依赖、类型、格式 | `yarn install --immutable` 已在 Docker 构建中通过；`yarn typecheck`、`yarn format:check` 通过 |
| 服务端单元/集成 | 32 项通过；真实 PostgreSQL 随机测试库、Sequelize 事务、迁移、条件唯一约束、并发、幂等、seed、容量状态和日志去重 |
| 服务端覆盖率门禁 | statements 93.43%、branches 89.68%、functions 97.43%、lines 94.84%；`service.ts` 分支 91.11%，通过 |
| 客户端单元/组件 | 39 项通过；读卡哈希/计时、设置/登记/批量/历史交互、SQLite 重启及边界、协调器恢复、固定目标传输 |
| 客户端覆盖率门禁 | statements 87.24%、branches 83.24%、functions 85.55%、lines 88.24%；pin/reader/timers 关键分支门禁通过 |
| 真实 Electron 集成 | 5 项通过、1 项专用 Compose 用例单独通过；Windows main/preload/renderer、cyez-ui、真实 SQLite、OS 加密、实际 TLS 握手，错误 pin/过期/SAN/重定向/HTTP 拒绝，业务闭环和只读历史。默认套件中 Compose 专用用例显式跳过 |
| Compose 集成 | 五服务镜像构建、迁移、受控 seed、网关 HTTPS 入口、打包 Electron → gateway → API → PG 的登记/结束/历史闭环通过；DB/API/gateway 重建后 3 名学生和记录保留 |
| 网络与日志 | 仅 gateway 发布宿主 `127.0.0.1:8443`，API/PG/log-ingest 不发布；gateway、DB、API 来源均实际归集至 `app_logs`；DB 停机 readiness 为 503，恢复为 200 |
| 受控 seed | 首次 `inserted:3`，重跑 `inserted:0, unchanged:3`；运行角色不能 seed，迁移角色可 seed |
| 日志归集恢复 | 新增真实 PostgreSQL 测试：连接关闭时 API spool 和 gateway 原文件保留；重连后 240 行分两批接收，游标回退重放不重复入库，未完成的末行不提前 ACK |
| Windows 发布构建 | Electron x64 NSIS 包生成于 `release/cyez-library-0.1.0-x64-setup.exe`，本次 SHA-256 为 `3c4bd1bdf6fe75433a94d2665f0b561e9e706475d6f523e92dcfa6b5214615e9`；Authenticode 为 `NotSigned` |

同源 SQLite 待确认命令跨 Electron 重启后按原键查询/重试、异源意图不重放，已在完整 5 项真实 Electron 套件复测通过。GitHub Actions [run 40900963431](https://github.com/lmyzzzz/cyez-library-management/actions/runs/40900963431) 的 Linux 服务端和 Windows 客户端 job 均通过；远端 Windows 用解包发布应用完成 39 项单元/组件测试、5 项 Electron 集成测试及 NSIS 构建，专用 Compose 用例按设计跳过，本机已单独执行。远端上传 `server-coverage` 和 `windows-client-results`（含安装包）制品。测试中 fake campus provider、集成测试卡和测试证书明确只允许开发/集成配置；不能据此判定真实校园系统已接通。

未完成的真实验收：TBD-01 校方最终字段/显示白名单；TBD-02 真实校园 API 协议、凭证、限额及 HTTPS 联调；TBD-03 USB 型号、驱动、UID 字节序/长度和实机扫描；TBD-04 目标 Linux/网络/IP SAN 证书与指纹发放、目标磁盘容量标定；TBD-05 保留期和产品外清理规则；TBD-06 Windows 签名材料、安装/卸载/升级与目标 DPI/无障碍；TBD-07 真实合法学生来源及受控预置。NEXT-01 跨卡/换盐身份迁移继续延期。

测试矩阵中仍未完成的高风险实测包括真实校园 provider 故障与限额、真实读卡器输入、目标环境磁盘写满/长时间日志积压及追赶时间、目标 Windows 安装升级与目标 Linux 部署。当前构建可供集成验证，不可称为生产验收完成。
