# 刷卡登记版正式图册

2026-10-31 需求修订：图源与 SVG 已按“每次有效刷卡查校园 API，成功后新增或覆盖本地缓存，日常查看只读缓存”重绘；本地学生表不再负责授权。

本图册依据登记版[草图](draft/draft.drawio)及 [opinions.md](../opinions.md) 修订，基线为 2026-10-29，后续卡号/学生 ID 分离与原卡号临时查询确认优先。原始文件保持不变；技术决定见[决策与证据](decisions.md)，待定项以黄色 `TBD-*` 标出，`NEXT-01` 为明确延期的跨卡身份迁移。

全部八页统一保存在 [architecture.drawio](architecture.drawio)，可用 diagrams.net / draw.io 编辑，节点、文字和连线均为原生对象。下列 SVG 无需额外软件即可预览；建议放大阅读，不以缩略图代替详细规格。

| 页 | 图 | 阅读重点 |
| --- | --- | --- |
| 01 | [总体架构](architecture.svg) | 教师进程边界、HTTPS、Fastify、外部校园 API、数据库和全量日志 |
| 02 | [数据模型](data-model.svg) | 哈希 studentId、独立临时卡输入、API 权威与本地缓存、ORM 约束、设备软删除、只读历史 |
| 03 | [刷卡登记与结束](registration-flow.svg) | 哈希 ID 校验、原卡号查询、首次建缓存与每次覆盖、API 拒绝、10 秒无操作取消和结束分流 |
| 04 | [事务与批量结束](record-transactions.svg) | 幂等、统一锁顺序、固定 ID 集合、版本冲突、备注追加和分批结果 |
| 05 | [Docker 部署](docker-deployment.svg) | 五类服务、共享 .env 口令、叶证书 pin、ORM 迁移、持久卷；无备份模块 |
| 06 | [教师界面](teacher-ui.svg) | 上登记/下设置、连接配置、设备编辑、历史表格、登记/结束、DevicePicker |
| 07 | [UI 与工作区依赖](ui-workspaces.svg) | Yarn 4、Sequelize、cyez-ui 已授权、包入口、main pin/密码存储边界 |
| 08 | [测试与发布流程](testing-pipeline.svg) | 两端分别单元/集成、真实 PG/Electron、联调、覆盖率与硬件门禁 |

默认阅读顺序为 01 → 03 → 06 → 02 → 04 → 05 → 07 → 08。图 06 是实现所用的界面结构，不是已运行应用的截图，也不声称已还原 cyez-ui 的最终视觉效果。

## 图例与待定项

每页副标题定义箭头含义：总体图是调用/数据流，数据模型是外键引用，工作区图是依赖，流程图是执行顺序。双向箭头表示请求/响应或双向 IPC，虚线表示日志交接/附属路径，具体以线旁文字为准。蓝、绿、紫用于分组；红色表示冲突/错误路径；黄色用于待定项或需要注意的业务边界，以文字标识为准，不只靠颜色判断。

- TBD-01：学生最终字段与显示白名单；出现在 01/02/03/06。
- TBD-02：校园卡 API 协议、认证、原卡号格式与请求/响应字段；出现在 01/03/05/08。
- TBD-03：真实读卡器、驱动/设备传输及 UID 对照验收；Wiegand-34 4 字节 UID 与独立进程管道已定；出现在 01/03/06/08。
- TBD-04：宿主、IP SAN 证书、pin 分发和网络；出现在 05/08。
- TBD-05：保留期和产品外清理；出现在 02/05/06。
- TBD-06：Windows 签名与目标系统验收，UI 使用授权已确认；出现在 07/08。
- TBD-07 已撤回：学生资料由校园 API 确认并写入本地缓存，不再要求生产预置。
- NEXT-01：跨卡/换盐导致主键变化的身份与历史迁移；出现在 02/07。

## 维护与校验

规范图源为 [tools/generate_diagrams.py](tools/generate_diagrams.py)，使用本目录的[图形导出引擎](tools/diagram_engine.py)，不依赖其他设计目录。Python 标准库即可再生成 SVG 和未压缩 draw.io；本轮没有将图片栅格化后塞入 draw.io。用图形编辑器探索布局后，应把最终变更同步回生成器，避免后续生成覆盖手工改动。

在仓库根目录执行：

```powershell
python record-only/docs/tools/generate_diagrams.py
python record-only/docs/tools/generate_diagrams.py --check
```

可选渲染（额外安装 CairoSVG，中文字体使用 Microsoft YaHei 或 Noto Sans CJK SC；预览 PNG 不进仓库）：

```powershell
python record-only/docs/tools/generate_diagrams.py --check --render-dir "$env:TEMP/cyez-record-only-diagrams"
```

生成器检查 ID 唯一、边引用、画布边界、文字行高和生成文件一致性。发布文档前还要渲染逐页检查文字宽度、重叠和连线，并核对 Markdown 链接。以上是文档校验；产品单元测试、集成测试与容器验收另见 [testing.md](testing.md)，不能混计。

图表对应的实施顺序、故障处理和剩余外部输入见[实施计划](implementation-plan.md)。
