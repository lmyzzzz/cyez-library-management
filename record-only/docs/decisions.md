# 技术决策、证据与草图追踪

基线：2026-10-28，草图来自提交 `d5ace80` 的 [draft.drawio](draft/draft.drawio)。草图表达业务意图；其中“需要判断”由本文件作技术决策，“需求待定”继续保留，已写明“已解决”的业务选择原样继承。下列依据支持技术判断，不表示官方文档替学校决定业务需求。

## 已作出的技术判断

| 编号 | 问题与决定 | 理由及依据 |
| --- | --- | --- |
| ADR-01 | 首阶段为 record-only：教师 Electron + 服务端；不部署学生端或 Rust | 新草图只有登记、结束和资源管理；“结束设备”是结束记录，不是远程关闭电脑。避免把旧三端方案功能混入紧急上线范围 |
| ADR-02 | 服务端选择 Fastify，模块化单体，REST 业务 API；PostgreSQL 保存权威状态 | JSON Schema 请求校验/响应序列化有利于稳定边界和限制返回字段，插件封装便于按业务组织，`inject()` 可作路由集成测试。不会因 TypeScript 静态类型而省略运行时校验。[S1][S2] |
| ADR-03 | 设备和标签用 `device_tags(device_id, tag_id)` 唯一关联表；不在两侧持久化重复数组 | 这是多对多关系：复合主键消除重复，两个方向的索引支持查询，外键防止孤儿。API 可以返回 `tagIds`，它是关系表投影，不是第二份真值。[S3] |
| ADR-04 | 当前使用状态来自未结束且未作废的 `usage_records`，不写 `students.is_using`，不增加首版 occupancy 表 | 占用与记录创建/结束属于同一事务。对学生和设备分别建条件唯一索引，让并发请求也不能造成一人/一机同时两条活动记录；静态档案不背负使用状态双写。[S3][S4] |
| ADR-05 | 卡是首版唯一业务身份；内部仍用独立 UUID 作为 `studentId`，卡指纹在凭证表查找该 ID | 独立主键避免密钥轮换重写历史外键，并不自动获得跨卡识别能力。无稳定人物键时不同卡创建不同学生，不按姓名/班级猜测合并；换卡合并列为优先后续工作 |
| ADR-06 | 用服务端秘密密钥的 HMAC-SHA-256 生成卡查找指纹，代替草图的普通“加盐 hash” | UID 空间小，公开盐不能防枚举；每行随机盐又妨碍直接相等查询。HMAC 支持稳定等值匹配，密钥与数据库分离。它是化名化，不是匿名化，也不能防持有相同 UID 的克隆卡。[S9][S10] |
| ADR-07 | JSON 时间统一为 Unix 毫秒安全整数；PostgreSQL 内部用 `timestamptz`，持续时长按差值计算 | 草图明确不传字符串时间戳。SQL 时间类型保留时间运算与校验能力，API 显式转换为整数毫秒，绝不把 `bigint` 驱动返回的字符串直接透传。服务器接受刷卡请求时记录权威刷卡时间。[S14] |
| ADR-08 | 所有开始/结束/批量操作都通过业务命令、事务、幂等键和版本校验 | 设备列表仅为快照；提交前再次锁定并检查。超时不代表失败；同一幂等键查询/重试，不能以新 ID 重复扣改。行锁和唯一约束一起保护并发。[S3][S5] |
| ADR-09 | 批量结束使用“先预览固定记录集合，再显式确认，单批事务全成全败” | 避免点击“结束全部”后把刚开始使用的新记录意外结束；保存并核验记录 ID/版本/权限。冲突返回 409 并重新预览，不能静默扩大作用范围。大批次显式分批，各批独立结果，绝不声称跨批原子性 |
| ADR-10 | 删除有引用的学生/设备使用归档；登记记录作废及更正保留审计，不能裸 DELETE 历史 | 满足草图“增删改查”的管理需求，同时保留外键与使用记录。旧记录按当前学生资料显示是业务规则；业务更正记录不是偷偷保存一套旧学籍快照。[S3][S10] |
| ADR-11 | 首版客户端用 HTTPS REST，设备页短轮询刷新，服务端无需 WebSocket | record-only 无实时锁机/画面通道。默认可见页 3 秒刷新，隐藏时暂停，失败退避；每次提交仍服务端校验，因此正确性不依赖刷新频率。后续有实时告警需求再增加订阅协议 |
| ADR-12 | 倒计时仅属于客户端交互，不是服务端自动结束任务 | 保留登记 5 秒自动取消、刷卡结束 5 秒自动确认；页面加载成功才开始，编辑/失焦暂停自动提交，恢复后须显式继续或确认。5 秒到期与按钮点击共用同一提交门闩和幂等键；手动/批量结束不自动确认 |
| ADR-13 | 服务端用 Linux Docker Compose 单节点，API/数据库/迁移/运维任务分职责 | 多阶段构建缩小运行镜像；健康检查控制初始化；持久卷独立于容器；不靠重启数据库代替迁移。容器化不等于高可用。[S6][S7][S8] |
| ADR-14 | 单元测试用 Vitest；服务端集成测试用真实 PostgreSQL；客户端集成测试启动真实 Electron；发布前再做联调 | Mock 可验证纯规则，不能验证数据库竞争、SQLite 恢复、preload 权限、读卡边界及打包后行为。Playwright 的 Electron 接口是实验性的，固定版本并保留 Windows 实机验收。[S2][S11][S12][S13] |
| ADR-15 | cyez-ui 经构建 tarball 消费，保留本项目 Yarn 4 与单一 lockfile | 上游源码使用 pnpm；上游构建和本项目消费是两个工程。仅固定提交对应的包产物，不把上游 workspace/pnpm 锁文件复制进本项目，不假设其已发布 npm。[S15][S16] |
| ADR-16 | 预览只能成功消费一次；同一请求可重试，不同请求不能复用已提交预览 | requestId 幂等只拦截相同键，不能阻止换新键重用旧页面。在业务事务内持久化唯一 intentId，并保留同键结果，覆盖并发、重启和设备后来再次空闲。[S3][S5] |
| ADR-17 | 保留草图刷卡时间为开始时间，同时验证学生/设备有效使用区间不重叠 | 结束占用后使用早先的刷卡预览可能倒填重叠区间。关联对象行锁下检查半开区间；有冲突要求重刷，不静默改写刷卡时间。历史更正也遵守同一检查。[S5][S14] |

## 待定需求与明确延期

黄色 `TBD-*` 在对应正式图中显示，不能以默认实现掩盖未确认。实现可先用适配器假数据和示意字段开展测试；涉及个人数据或硬件的真实上线须闭合相应事项。

| 编号 / 状态 | 尚未确定的内容 | 当前可确定的边界与影响 | 图中位置 |
| --- | --- | --- | --- |
| TBD-01 · 原草图待定 | 学生资料最终字段、必填项、展示内容；是否有可用的稳定人物键 | `studentId`/卡指纹是技术字段；姓名、班级、校内学号为候选，不把“学号”等同于学籍号。先不采集学籍号；真实 schema 与响应白名单上线前确认 | 01 总体、02 数据、03 流程、06 UI |
| TBD-02 · 原草图待定 | 校园卡提供方 API、认证、错误码、字段、查询额度、超时 SLA、稳定人物键及卡号含义 | 仅服务端调用；无真实文档先用 FakeProvider。未知学生查询失败不落半条记录、不按名字自动创建身份 | 01、03、05 Docker、08 测试 |
| TBD-03 · 原草图待定 | USB 读卡器协议/SDK、键盘模拟或 HID/串口、UID 字节序/长度、驱动与型号 | `CardReader` 适配接口确定；协议前不得从普通键盘任意抓取数字当卡号；模拟器只用于测试 | 01、03、06、08 |
| TBD-04 · 部署输入待定 | 服务器 Linux 发行版/架构、TLS 证书发放、校内 API 网络放通、备份位置/保留期/RPO/RTO | Docker Compose 架构已确定；部署值在环境配置中填写，正式图中不虚构真实 IP/口令 | 05 Docker |
| TBD-05 · 数据治理待定 | 日志、记录和学生资料保留期；可见机房、导出审批、归档清理流程 | 不默认清空、不存无关学籍信息；首版提供 operator/admin 权限边界，最终人员和机房授权需学校配置 | 02、05、06 |
| TBD-06 · 发布输入待定 | cyez-ui 代码/二进制使用和分发许可、Windows 安装包签名材料 | UI 库选择已确认；上游 LICENSE/NOTICE 实际保留权利，未重新开源。本次只引用接口设计，不复制源码或分发包；发布使用前落实授权记录 [S16] | 07 UI 依赖 |
| NEXT-01 · 已决定延期 | 跨卡身份合并、补换卡和历史迁移 | 首版按卡区分，不悄悄合并。优先后续版本需稳定人物键或授权人工映射、审计和处理活动记录冲突；即使日后获得人物键也需迁移方案 | 02、07 |

草图“历史资料显示策略”已经解决：记录只关联学生 ID，旧记录显示新姓名/班级/学号，不保存整份学生资料快照。它不是待定项。草图“专门设计设备选择 UI”已通过正式 UI 文档和图 06 给出布局、状态和操作，具体学生字段仍引用 TBD-01。

## 草图逐项追踪

草图节点 ID 采用后缀简写：`P-*` = `P8i-xwklN0WiJ0ACK7I8-*`，`N-*` = `nPUgz08-ScTQTXVQVtWs-*`。连线上的确认/取消标签并入相应流程，原始草图保持不变。

| 节点 | 草图要求 | 正式落点 |
| --- | --- | --- |
| P-3/4/5/17/22/62 | 学生表、无档案需注册、单条/批量 CRUD、字段待定 | specification 数据字典与未知卡流程；TBD-01 |
| P-48/68 | 覆盖学生资料，旧记录显示新资料 | ADR-10、specification 当前资料查询；不存快照 |
| P-71 | 卡号唯一、换卡暂按新人、后续首要升级 | ADR-05/06、NEXT-01 |
| P-9/10/18/19/27/35 | 一次使用一条记录、整数时间、学生/设备关联、CRUD | specification usage_records、时间和审计规则；图 02/04 |
| P-24/25/29 | 设备 ID/名称/状态/备注、批量管理 | specification 状态派生与禁用规则；图 02/06 |
| P-31/33/38/39/40/43/44 | 标签 CRUD、多机房分区筛选、是否双向存储 | ADR-03，device_tags 双向索引；机房权限不能只靠标签控制 |
| P-64 | 当前使用存在哪 | ADR-04，活动记录条件唯一索引 |
| P-53/56/65/74/82 | 设备列表刷卡，根据是否使用分流 | specification 刷卡状态机、图 03 |
| P-59/61/92/97/87 | 登记、资料、刷卡开始时间、备注、选择设备、5 秒取消 | specification/UI 登记规则、图 03/06 |
| P-75/84/91/95/90 | 结束页、现有备注、结束时间、5 秒确认 | specification/UI 结束规则、图 03/04 |
| P-98 | 使用中/未使用选项卡、备注编辑、单结束和结束全部 | UI 页面清单、图 06、批量图 04 |
| N-2/4/6 | 单结束 Modal；批量紧凑列表与统一备注追加 | specification 批量事务与备注，图 04/06 |
| N-9 | 仅设备主页面刷卡跳转，其他页面或 Modal 仅 Toast | specification 输入门控、UI 图 06 与测试 C-U/C-I |
| N-12/13/14 | Node 服务框架、薄 Electron、业务接口、数据最小化 | ADR-02、职责/API/隐私，图 01/07 |
| N-15/16 | 服务端调用校园卡 API；USB 适配待文档 | TBD-02/03，图 01/03/08 |
| 本轮新增要求 | Docker、服务端/客户端单元和集成测试、cyez-ui | deployment、testing、ui，图 05/07/08 |

## 核对过的依据

以下页面于 2026-10-28 读取核对。外部 `latest/current` 会变化，真正实施时固定依赖版本；文档能力不等于本项目测试结果。

- [S1 Fastify：Validation and Serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)：运行时请求 schema、响应序列化；不能把用户输入当 schema 编译。
- [S2 Fastify：Testing](https://fastify.dev/docs/latest/Guides/Testing/)：分离应用构造/监听，HTTP injection 与实际监听测试。
- [S3 PostgreSQL：Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)：主键、唯一、外键、多对多连接表。
- [S4 PostgreSQL：Partial Indexes](https://www.postgresql.org/docs/current/indexes-partial.html)：仅对满足谓词的记录强制唯一。
- [S5 PostgreSQL：Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)：行锁、冲突、死锁与一致锁顺序。
- [S6 Docker：Multi-stage builds](https://docs.docker.com/build/building/multi-stage/)：构建与运行产物分离。
- [S7 Docker Compose：Startup order](https://docs.docker.com/compose/how-tos/startup-order/)：`service_healthy` / `service_completed_successfully`；进程启动不代表就绪。
- [S8 Docker Compose：Secrets](https://docs.docker.com/compose/how-tos/use-secrets/)：Linux 容器文件挂载 secret；不宣称 Compose 自动加密宿主机秘密文件。
- [S9 Node.js：Crypto](https://nodejs.org/api/crypto.html#cryptocreatehmacalgorithm-key-options)：`createHmac` 与密钥管理基础。
- [S10 OWASP：Cryptographic Storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)：数据最小化、密钥与数据隔离；HMAC 方案为本项目据此作的等值查找设计。
- [S11 Electron：Security](https://www.electronjs.org/docs/latest/tutorial/security)：sandbox、contextIsolation、IPC sender 校验和限制远程内容。
- [S12 Vitest：Coverage](https://vitest.dev/guide/coverage.html)：覆盖率采集；本文阈值是项目门禁，不是官方强制标准。
- [S13 Playwright：Electron](https://playwright.dev/docs/api/class-electron)：实验性 Electron 自动化，不能代替真实 USB/驱动验收。
- [S14 PostgreSQL：Date/Time Types](https://www.postgresql.org/docs/current/datatype-datetime.html)：`timestamptz` 与时区转换；API 毫秒整数为项目契约。
- [S15 Yarn：workspaces focus](https://yarnpkg.com/cli/workspaces/focus)：面向目标 workspace 的生产依赖裁剪。
- [S16 cyez-ui 固定源码版本](https://github.com/lmyzzzz/cyez-ui/tree/0a1d4f4fa9affecb2eaf83e978c1e9b1557c7043)：README、`packages/ui/package.json`、`packages/electron/package.json`、LICENSE、NOTICE 和 `docs/VALIDATION.md`；核对到 tarball 消费、包入口、peer 依赖及实际验证边界。
