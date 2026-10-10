# pi-permission-bash-cmd-checker

[English](./README.md) | 简体中文

一个 [Pi Coding Agent](https://github.com/earendil-works/pi) 扩展包，作为
[`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system)
的**功能增强插件**，在终端 UI 中提供 **bash 命令解释与基于分类模型的风险评估**。

## 功能

### 1. 命令解释

以英文或简体中文简要说明 bash 命令的作用，帮助理解命令内容。

### 2. 风险评估与可选拦截

使用分类模型评估命令风险，默认使用 `typesafe/jev-latest`：

| 结果      | 显示                 | 含义                             |
|-----------|----------------------|----------------------------------|
| `safe-ro` | ✅  Likely Safe (RO) | 大概率安全的只读操作。           |
| `safe-rw` | ℹ  Likely Safe (RW)  | 会修改数据、但大概率安全的操作。 |
| `unsafe`  | ⛔  Dangerous        | 可能危险的操作。                 |
| `unknown` | ⚠  Unknown          | 无法有把握地判定风险。           |

启用 `autoBlockUnsafe` 后，可自动拦截被判定为危险的命令；该选项默认关闭。

### 3. 命令预览与外部查看

编辑器上方会实时显示命令、风险标识与解释，命令过长时以截断预览呈现。
按 **Alt+C** 可在配置的外部查看器中查看完整命令。

## 安装

前置要求：

- 支持 **Classifier/Jev** 的 Pi 版本。
- [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system)

本扩展仅在交互式 TUI 中运行。

作为 Pi 包安装：

```bash
# 从 npm 安装
pi install npm:pi-permission-bash-cmd-checker

# 从本 GitHub 仓库安装
pi install git:github.com/gszj2018/pi-permission-bash-cmd-checker
```

## 使用

### 启用命令分析

将 `bash-cmd-checker` 加入权限系统配置的 `authorizerChain`，配置通常位于
`~/.pi/agent/extensions/pi-permission-system/config.json`：

```json
{
  "authorizerChain": ["bash-cmd-checker"]
}
```

请保留已有的权限规则和其它链路，建议将 checker 放在链的前部。
分析只针对需要批准的 bash 请求（`ask`）；修改配置后请运行 `/reload`。
如果使用项目级权限配置，请确保实际生效的 chain 也包含 checker。

### 打开完整命令

| 按键                      | 操作                               |
|---------------------------|------------------------------------|
| **Alt+C**，或自定义快捷键 | 在配置的外部查看器中查看完整命令。 |

## 配置

创建 `~/.pi/agent/bash-cmd-checker.json` 可自定义扩展，修改后运行 `/reload` 生效。
若设置了 `PI_CODING_AGENT_DIR`，请将配置文件放在该目录中。

所有字段均可省略；未提供配置文件时，使用以下默认值：

```json
{
  "llm": {
    "model": null,
    "language": "en",
    "timeoutMs": 30000
  },
  "classifier": {
    "model": { "provider": "typesafe", "id": "jev-latest" },
    "timeoutMs": 10000,
    "thresholds": { "safe": 0.5, "unsafe": 0.3, "confidence": 0.8 }
  },
  "widget": { "commandViewerShortcut": "alt+c" },
  "externalViewer": {
    "command": "code",
    "args": [],
    "mode": "detach",
    "filePath": null
  },
  "autoBlockUnsafe": false
}
```

完整 JSON Schema 见 [`schemas/bash-cmd-checker.schema.json`](./schemas/bash-cmd-checker.schema.json)。
可通过可选的 `$schema` 字段在编辑器中启用 Schema 校验。

### 配置字段

| 字段                               | 默认值                | 说明                                                                                              |
|------------------------------------|-----------------------|---------------------------------------------------------------------------------------------------|
| `llm.model`                        | `null`                | 用于生成解释的模型，格式为 `{ "provider": "…", "id": "…" }`。<br>为 null 时使用当前会话默认模型。 |
| `llm.language`                     | `"en"`                | 解释所用语言：`en` 为英文，`zh` 为简体中文。                                                      |
| `llm.timeoutMs`                    | `30000`               | 解释超时时间，单位为毫秒。                                                                        |
| `classifier.model`                 | `typesafe/jev-latest` | 用于风险分类的模型，格式为 `{ "provider": "…", "id": "…" }`。<br>为 null 时仅关闭风险评估。       |
| `classifier.timeoutMs`             | `10000`               | 风险评估超时时间，单位为毫秒。                                                                    |
| `classifier.thresholds.safe`       | `0.5`                 | 安全类别所需的最低概率。                                                                          |
| `classifier.thresholds.unsafe`     | `0.3`                 | 危险类别所需的最低概率。                                                                          |
| `classifier.thresholds.confidence` | `0.8`                 | 接受评估结论所需的最低置信度。                                                                    |
| `widget.commandViewerShortcut`     | `"alt+c"`             | 在外部查看器中查看完整命令的快捷键。                                                                        |
| `externalViewer.command`           | `"code"`              | 查看器可执行文件名或路径。<br>为 null 时不配置查看器。                                            |
| `externalViewer.args`              | `[]`                  | 传给查看器的字面参数，置于命令文件路径之前。                                                      |
| `externalViewer.mode`              | `"detach"`            | `detach` 在后台启动查看器；`wait` 暂停 TUI 直到查看器退出。                                        |
| `externalViewer.filePath`          | `null`                | 会话命令文件所在目录。<br>为 null 时使用系统临时目录下的固定子目录。                              |
| `autoBlockUnsafe`                  | `false`               | 自动拦截被判定为危险的命令。                                                                      |

### 外部查看器

- 完整命令会保存为会话 `.sh` 文件，同一会话下次打开时覆盖，不会被自动删除；其中可能含有秘密信息，
  如需只读请在查看器参数中自行指定（例如 nvim 使用 `["-R"]`）。
- `detach` 下 Pi TUI 保持可用、查看器单独运行，请配置 GUI 编辑器或能自行创建 pane/tab 的启动器；
  `wait` 下 Pi 会暂停直到查看器退出。
- Windows 上请配置实际的 `Code.exe` 路径：`code` 通常解析为不受支持的 `code.cmd`，且没有 shell 回退。
  请只配置编辑器或可信的启动器。

## 注意事项与限制

- 风险标识和阈值**不是安全保证**。本扩展不会自动批准任何命令，也不替代权限规则或沙箱；
  分析失败或不可用时，是否批准仍由权限系统决定。
- 仅覆盖需要批准的内置 `bash` 请求；别名 shell 工具、其它工具，以及策略终局、会话批准、
  yolo 放行和由前置链路决定的请求均不在分析范围内。
- 本扩展仅在交互式 TUI 中运行；非 TUI 子智能体转发的 bash 请求可由父 TUI 会话分析。
- **完整命令会不经脱敏发送给所选模型提供商**，其中可能包含秘密信息；命令和解释也会显示在终端中。
  使用前请了解提供商的隐私政策。
- 后台分析可能产生费用，这些费用不一定自动计入 Pi session 的费用显示。

## 开发

```bash
npm install
npm test
npm run typecheck
```

如需从仓库根目录直接加载本地扩展：

```bash
pi -e ./extension/index.ts
```

项目使用 TypeScript 和 Node.js 内置测试运行器。

## 项目结构

```text
pi-permission-bash-cmd-checker/
├── extension/
│   ├── index.ts                # 扩展入口（依赖组装）
│   ├── lifecycle.ts            # TUI 检测、初始化与会话生命周期
│   ├── config.ts               # 配置读取与严格校验
│   ├── types.ts                # 共享类型与实现无关契约
│   ├── utils.ts                # 共享判定函数
│   ├── command.ts              # 完整 bash 命令提取
│   ├── utils-pi.ts             # 带前缀的通知与失败兜底
│   ├── permissions.ts          # 服务绑定、事件解析与 Authorizer 仲裁
│   ├── analysis.ts             # 并行分析任务、总期限与取消
│   ├── llm.ts                  # 解释模型适配
│   ├── classifier.ts           # 分类模型适配
│   ├── risk.ts                 # 风险阈值裁决
│   ├── state.ts                # 会话状态、generation 与记录
│   ├── widget.ts               # 预览 Widget 与查看器控制器
│   ├── external-viewer.ts      # 会话命令文件与查看器启动
│   ├── external-viewer-node.ts # Node 文件系统与进程适配器
│   ├── shortcut.ts             # 查看器快捷键解析
│   └── terminal-text.ts        # 配色、安全转义与换行
├── schemas/
│   └── bash-cmd-checker.schema.json
└── tests/                      # 单元测试与集成测试
```

## 开源许可

[MIT](./LICENSE)
