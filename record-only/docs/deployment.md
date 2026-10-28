# Docker 部署与运维设计

服务端必须容器化；当前提交规定可实施的容器契约，尚未编写应用镜像或虚构可运行 Compose。业务编码时同时落地 Dockerfile、Compose、迁移和下述验收；本设计不能作为已经完成容器测试的证明。

![Docker 部署拓扑](docker-deployment.svg)

## 服务与网络

首版采用学校服务器上的 Linux Docker Engine + Compose。若现有主机为 Windows，部署受维护的 Linux VM 运行服务端容器，桌面 Electron 留在教师 Windows；不把 Windows 桌面应用塞进 Linux 容器。宿主平台、架构、存储、证书和外部 API 连通性待 TBD-04 确认。

| 服务 | 镜像/身份 | 接口与网络 | 持久数据 |
| --- | --- | --- | --- |
| `gateway` | 固定版本 Nginx 非特权镜像，TLS 终止 | LAN 仅发布 TCP 443；容器内部 8443 → `api:3000`；禁止转发任意上游、限制 body/速率、访问日志脱敏 | TLS secret 只读；访问日志先进入可靠本地 spool |
| `api` | 本项目 Fastify 生产镜像，非 root UID，单实例起步 | 仅 Compose 内部 3000；请求 Postgres；校园卡 API 由受控出口放通；不得由客户端提交任意 provider URL | 应用日志 spool；不在镜像内存数据或密钥 |
| `db` | 固定 PostgreSQL 主版本/补丁镜像；运行时最小权限账号 | 仅后端网络 5432，不发布到 LAN；API、迁移、备份和日志收集各用独立权限 | 命名卷 `pgdata`；升级前核对所选官方镜像 PGDATA 挂载要求 |
| `migrate` | 与 API 同一已审核镜像，单次任务 | 等待 db healthy，独立迁移凭证；成功退出才启动 API | 带版本 migration、锁；不与应用多实例各自竞争跑迁移 |
| `log-ingest` | 同一项目镜像的内部工作进程入口，有限数据库写入权限 | 无公开端口；读各来源 spool，去重持久化 | 自身游标和未确认日志卷；不暴露 Docker socket |
| `backup` | 与数据库版本匹配的工具镜像，运维 profile/计划任务 | 仅数据库/明确备份目的地；凭证与 API 分离 | 加密备份、校验记录、恢复报告；不只备份到同一块磁盘 |

前端/后端网络分离，DB 无 published ports。gateway 到 api 的内部 HTTP 仅在受控 Compose 网络；如果不再共用宿主或跨不可信网络，内部链路也必须 TLS。API 获取真实客户端身份仍依靠凭证，不能信任任意转发头；gateway 覆写转发头并且 API 只信任指定代理。

校园卡 API 主机/证书、认证方式、限流策略为 TBD-02；出口仅允许该已配置目的地，凭证不发到 renderer。TLS 校内证书需教师客户端信任，不能用 `rejectUnauthorized=false` 绕过证书错误。

## 镜像构建契约

1. 固定受支持 Node.js LTS、Yarn 4 精确版本与基础镜像 digest；实现时执行兼容性测试，不能照抄上游 UI 的 Electron 版本当服务器 Node 版本。CI 显式准备 Yarn 启动器，不假定 Node 镜像自带 Corepack。
2. 多阶段 Dockerfile：依赖阶段复制根 manifest、单一 `yarn.lock`、`.yarnrc.yml` 和必需 workspace manifest，执行 `yarn install --immutable`；构建阶段复制 TypeScript 源并依拓扑构建协议/领域/server；测试在 CI 独立门禁执行；生产依赖阶段通过 `yarn workspaces focus <server-workspace> --production` 裁剪。
3. 运行阶段仅复制 server 及依赖工作区的编译产物、运行时依赖、migration 和必要元数据；Yarn 的 workspace 链接目标也要存在，不能只复制 server/dist 丢失共享包。源码秘密、测试样本、教师安装包和 UI tarball 不进入服务器镜像。
4. 本地原生模块按 Linux 目标架构构建，不复用 Windows node_modules。`.dockerignore` 排除本机 node_modules、.git、日志、secret、个人资料与临时产物。镜像以非 root 用户运行，`read_only` 根文件系统，必要 `/tmp` 用有界 tmpfs，日志卷单独可写，drop capabilities、no-new-privileges。
5. Node 用 exec 形式启动并接收 SIGTERM；停止接入新业务、等待有界在途事务/日志交接后关闭连接池。容器退出不意味着事务失败：客户端用同一 requestId 查询重试，数据库已提交结果仍可取回。

产品工程仍用现代 Yarn workspaces，建议目录 `record-only/apps/server`、`record-only/apps/teacher`、`record-only/packages/{protocol,domain,client-sdk,ui}`；根 workspace glob 同时覆盖这些明确路径。是否与后续三端应用共享基础包按依赖边界实施，不能直接把两版不同记录状态机混成同一个 domain。Rust 不属于本阶段，未来仍由 Cargo 独立构建。

## 配置、密钥与持久性

| 配置种类 | 约定 |
| --- | --- |
| 非秘密 | API 内部端口、学校时区、provider 主机、请求上限、pool、刷新频率、有限批次大小、预览 TTL 等通过 schema 校验；未知/非法配置启动失败 |
| 秘密 | DB 密码、账号签名材料、卡 HMAC 密钥、校园 API 凭证、初始 admin 引导、TLS 私钥以 Compose secrets 文件注入 `/run/secrets/*`，不写镜像、源码、日志或构建参数 |
| 文件保护 | Compose secrets 是宿主文件挂载，不能称其自带静态加密；宿主权限、磁盘加密、加密备份由部署落实，备份密钥独立保管 |
| 权限 | runtime DB 角色只有必要 DML，不拥有 schema；migration 账号做 DDL；backup 和 log-ingest 分离授权；绝不以 postgres 超级用户给 API 运行 |
| 日志 | API/gateway/DB 日志进入各自卷中的持久 spool，内部收集器按来源游标导入 app_logs 后回收；数据库不可写时留盘。Docker stdout 可作运维镜像输出，不能作为唯一待传来源 |
| 容量 | pgdata、日志 spool、临时空间与备份都有余量指标；普通日志不静默采样丢弃，存储不足停止新的业务写入并告警，而非清空未确认日志 |

预览包含敏感候选字段，首版仅有界内存保存，TTL 到期和取消立即删除引用；容器重启失效。数据库/幂等结果/审计/日志不能随容器重建消失。禁止将 `docker compose down -v` 当普通升级步骤。

## 启动、健康、迁移和恢复

- 启动顺序：DB `pg_isready` 健康 → migrate 持迁移锁执行且成功退出 → API 启动检查 schema 版本和 DB 权限 → `/health/ready` 为 200 → gateway 接入。Compose `depends_on` 条件只解决启动顺序，API 仍须处理运行中 DB 断线。
- `/health/live` 只检查进程事件循环可响应；`/health/ready` 检查 DB、migration 版本与必要写入条件。校园卡 API 断线只让未知卡资料解析降级，不自动把仍可服务已知学生的系统完全下线。readiness 503 不应触发无限重启丢失预览。
- schema 使用扩展—迁移—收缩步骤；发布前备份并验证旧/新版兼容窗口。不能假设换回旧镜像就能撤销破坏性 migration。需要不兼容升级时进入维护模式，停止新提交、清空在途请求、备份、迁移、烟测再开放。
- 单节点不承诺零停机；服务端停机期间客户端显示离线、停用登记/自动结束、保留日志与已发请求意图。恢复后查询原操作并重刷失效预览。
- 备份包含数据库（业务、审计、日志、操作结果）、加密的必要密钥/配置、未交接日志和 migration 版本。逻辑备份需一致快照；若学校 RPO 要求更小，配置 PostgreSQL WAL/PITR。实际 RPO/RTO/保留期为 TBD-04/05，不能写成已经保障。
- 恢复演练在隔离环境还原，核对活动记录唯一性、历史资料关联、卡 HMAC 可查、账号权限和已确认操作。旧备份恢复可能缺少近期已 ACK 数据，必须使用服务端备份/WAL，不能指望客户端已经回收的日志副本。

## 容器交付验收

业务实现必须提交可在空白 Linux 宿主运行的 Dockerfile、Compose、配置模板（无秘密）、migrations 和运行说明。CI 构建镜像并在临时 Compose 项目执行：初次安装、重复启动、迁移失败阻断、DB 重启/丢连接、SIGTERM 在途事务、TLS/权限、卷重建、备份恢复、日志收集故障与空间压力。具体用例和单元/集成门禁见[测试设计](testing.md)。本轮只校验设计和图表，不宣称这些容器场景已通过。
