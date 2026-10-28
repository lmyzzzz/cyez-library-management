# 刷卡登记版：正式设计入口

设计日期：2026-10-28。依据仓库提交 `d5ace80` 中的[草图](docs/draft/draft.drawio)整理。当前交付是可审阅的规格、技术决策、测试计划与可编辑图册，尚未实现应用，也未运行产品单元测试、集成测试或 Docker 部署。

本阶段仅由教师 Electron 客户端、Docker 化 Node.js 服务端和 PostgreSQL 组成。教师端接收 USB 刷卡与人工操作；服务端决定身份、登记、占用、结束和批量修改。设备是被登记使用的资源，本阶段没有学生客户端、锁机、截图、人脸识别或 Rust 服务。原有[三端完整方案](../docs/architecture.md)作为后续扩展设计保留，其 Session、防护和直连规则不能套到本阶段。

| 正式文档 | 内容 |
| --- | --- |
| [需求与业务规格](docs/specification.md) | 范围、登记/结束流程、数据字典、事务、业务 API、异常与日志 |
| [决策、依据与待定项](docs/decisions.md) | 草图逐项追踪；已决定的问题及来源；待定需求与上线影响 |
| [Docker 部署设计](docs/deployment.md) | 容器、网络、卷、密钥、迁移、健康检查、备份与交付验收 |
| [测试设计](docs/testing.md) | 服务端与客户端分别覆盖单元/集成；真实 PostgreSQL、真实 Electron、CI 门禁 |
| [UI 与 cyez-ui 接入](docs/ui.md) | 页面、设备选择、倒计时、Modal、权限、包入口与 Yarn 消费方案 |
| [正式图册](docs/diagrams.md) | 八张详细 SVG 和统一可编辑 draw.io；黄色标出待定项 |

![刷卡登记版总体架构](docs/architecture.svg)

服务端采用 **Fastify + PostgreSQL**；客户端采用 **Electron + React + cyez-ui**；本项目仍使用 **Yarn 4 workspaces**。UI 仓库实际包名为 `@series/ui` 和 `@series/electron`，不是名为 `cyez-ui` 的 npm 包。

草图要求的两项关键行为已保留：旧记录展示学生最新资料；首版按卡识别，不自动合并换卡前后身份。仍待定的学生字段、校园卡 API、读卡器协议等在文档和对应图中标记为 `TBD-*`，不会被示意字段伪装成已确认需求。
