# 架构图册

> 本图册是后续完整三端方案。当前优先阶段请阅读[刷卡登记版八页正式图册](../record-only/docs/diagrams.md)；两套图源分别维护，原有故障恢复设计保持不变。

设计版本：2026-10-23。详细行为以[架构文档](architecture.md)为准；以下图描述设计，尚不是运行验证结果。

[下载或打开可编辑 draw.io 图册](architecture.drawio)。图册共有十页，每页均有可直接预览、放大的 SVG。先看总体架构和学生端内部职责，再按需要阅读时序与状态机。

逐项核对三端收发内容与身份要求时，参阅[网络通信清单](network-communication.md)。

| 页面 | 图 | 说明 |
| --- | --- | --- |
| 01 | [总体架构](architecture.svg) | 服务端、教师与学生模块；Electron 远端链路；Rust 离线边界；存储与包仓库 |
| 02 | [学生端内部职责](student-runtime.svg) | 主逻辑、渲染器、worker、SQLite、命名管道、保护状态机及系统动作 |
| 03 | [入网与教师发现](device-discovery.svg) | 设备身份、动态 IP、教师端点、操作权代次、接管完成条件与独立画面订阅 |
| 04 | [登记解锁时序](registration-sequence.svg) | UID/人脸登记、预留、授权、本地许可、实际界面确认、事件提交与回执 |
| 05 | [Rust 离线状态机](guardian-state.svg) | 启动、锁定、解锁许可、恢复、维护与显式关机；故障转恢复，不自动关机 |
| 06 | [故障处置](failure-handling.svg) | 两路网络、必需进程、应用故障分流；教师告警、退避恢复、实际锁定及继续使用条件 |
| 07 | [Session 状态机](session-state.svg) | 登记、预留、实际使用、暂停、待确认结束和占用/计时规则 |
| 08 | [全量日志上传与可靠补传](event-delivery.svg) | 教师/学生应用、Rust、安装更新日志全部汇入服务端；本地交接、最终确认、服务端自身日志与事件投影 |
| 09 | [更新与回滚](update-lifecycle.svg) | Electron 选择与下载、受限执行器切换、Rust 维护、分阶段验证与回滚 |
| 10 | [Yarn 工作区依赖](workspace-dependencies.svg) | Yarn 4、内部 `workspace:^`、纯业务共享包、本地 schema、Cargo 与安装包 |

## 阅读约定

- 实线箭头表示请求、消息或数据流，双向箭头表示双向通信；时序中的虚线回箭头表示返回，竖虚线为参与方生命线。
- 模块图中的外框表示部署或进程职责边界，不代表所有内容运行在同一个线程。
- 详细协议和遗漏的失败分支由正文规则约束；每页底部标明会影响理解的确认条件或能力边界。
- 状态机分为服务端 Session、Electron 业务投影和 Rust 保护状态。相同“解锁”用词不能跨层等价替代确认。
- 教师与学生客户端数量不设产品上限；200 学生端、2 教师端和每端 60 可见订阅仅为首轮可调整测试负载。
- 本系统各组件的全部已产生日志均须归集到服务端；Rust 与安装执行器通过本地持久交接由 Electron 转发，不直接联网。诊断日志与业务事件分别查询，只有经过业务校验的事件驱动 Session。
- 防护故障不自动关机：Rust 离线尝试恢复，Electron 可用时转发告警；完全失联时教师/服务端先显示心跳超时告警，恢复后补齐具体记录。实际确认锁定后才能标为已保护，继续使用仍需教师重新授权。
- 原始讨论草图保留在仓库根目录；本图册和架构文档为当前正式设计。

## 编辑和同步

图的布局、节点文字、连接点来自[生成工具](tools/generate_diagrams.py)。它使用 Python 标准库同时生成 `architecture.drawio` 与各 SVG；仓库内的图源和预览应在同一提交中更新。源代码不包含本机绝对路径或外部字体下载请求。

```powershell
python docs/tools/generate_diagrams.py
python docs/tools/generate_diagrams.py --check
```

`--check` 不修改文件：检查节点 ID、引用和画布边界，并比较生成结果与仓库文件，防止图源与预览失配。它不是业务实现测试，也不证明所有文字在所有字体环境中都可读。

安装 CairoSVG 的文档环境可以生成本地 PNG 做视觉检查，输出目录放在仓库外：

```powershell
python docs/tools/generate_diagrams.py --check --render-dir "$env:TEMP/cyez-architecture-preview"
```

draw.io 文件可以直接在 diagrams.net 编辑讨论。若手工编辑图册，需把最终节点、文字和布局变更同步回生成工具后重新导出，否则下次生成会覆盖手工改动。修改行为时同时更新 `architecture.md`，不要仅修改图片。

视觉检查覆盖全部十页：中文字体、说明文字、箭头方向、交叉和遮挡、画布裁切，以及图片与正文的职责一致性。SVG 保留矢量文字，页面较长的时序图请打开原图放大阅读。
