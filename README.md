# Videome

Videome 是一款本地视频剪辑与批量混剪桌面工具，使用 React、Vite、Electron 和 FFmpeg/ffprobe。源素材、工程和渲染任务在本机处理。

> 当前版本：`1.0.0` · 文档核对日期：2026-11-11

## 当前状态

| 平台 | 目标与产物 | 验证状态 |
| --- | --- | --- |
| macOS Apple Silicon | macOS 15.0+；`.app`、`.dmg`、App `.zip` | 本机 macOS 26 开发版及安装版已验证；macOS 15 云端构建与包内检查通过，实机人工验收待完成 |
| Windows x64 | NSIS 安装版 `.exe`、Portable 免安装 `.exe` | Windows Server 2022 云端 73 项测试、打包及包内转码检查通过；Windows 11/10 人工验收待完成 |

目前交付内部测试包：Mac 使用 ad-hoc 本地签名，未做 Developer ID 签名或公证；Windows 未配置发行签名。Intel Mac、Windows ARM、32 位、商店发布和自动更新不在当前交付范围。具体证据见[双平台实现与验收记录](docs/CROSS-PLATFORM-IMPLEMENTATION-REPORT.md)。

2026-11-05 的[双平台成功构建 #6](https://github.com/WECENG/videome/actions/runs/41957372222)已上传安装包。历史构建可在运行页的 Artifacts 下载 `Videome-win32-x64-6` 或 `Videome-darwin-arm64-6`（需要登录 GitHub，保留 30 天）；后续成功构建会自动出现在仓库的 Releases 中。

## 主要功能

- **工程管理**：无恢复记录时进入空白工程；项目菜单提供新建、打开、另存为和恢复切换前工程。工程位置可显示完整路径、复制路径并在 Finder / 文件夹中定位。
- **素材与时间线**：导入视频、音频和图片，支持搜索、多选排序、拖放、裁切、分割、波纹删除、多轨叠加，以及视频原声联动。
- **本地预览**：原片预览、缩略图和视频帧；Chromium 无法解码时，可按需生成 H.264 兼容代理。
- **字幕与配乐**：手工字幕、SRT 导入导出及烧录；智能配乐工作台支持本地音乐分析、当前视频分析、最多 3 首推荐、临时试听、音量、循环铺满、淡入淡出和人声自动避让。
- **普通导出**：H.264 / HEVC 高质量导出、FFV1 无损 MKV、VP9 / Opus WebM，以及符合条件的单片段原码流保留。
- **批量混剪**：一个长视频自动切片、随机重组为独立 MP4；用户填写 `1–1000` 条，支持固定种子、序列去重、受控并发、暂停、取消、失败重试和中断恢复。任意成功结果可重建为原始切片工程。
- **批量分段**：一个视频按固定片段时长从头到尾顺序拆分为多个 MP4；自动保留短尾和原声，不添加背景音乐，支持进度、暂停、取消、预览和打开输出目录。

App 不附带海岛视频或音乐曲目。“项目 → 查看界面示例”只展示时间线布局，明确标注没有源文件。智能配音与字幕面板内的多语言语音识别均在 Apple Silicon Mac 本地运行；字幕 Whisper 模型可在字幕面板独立安装。智能配乐使用桌面端本地 FFmpeg/ffprobe 和轻量 JavaScript DSP 分析音乐与视频特征，不上传媒体、不接入在线曲库或云端语义模型；浏览器预览模式使用基础元数据和手动标签，详见[功能与边界](docs/FEATURES.md)。

## 开始使用

安装包用户可直接运行应用，无需安装 Node.js、FFmpeg 或 Homebrew。Mac 使用 DMG 安装或解压 App ZIP；Windows 安装版与 Portable 的操作步骤见[人工验收指南](docs/CROSS-PLATFORM-ACCEPTANCE.md)。

1. 从空白工程导入自己的素材，双击素材或拖入时间线。
2. 在顶部修改项目名称，点击“保存”选择 `.videome` 的位置；以后可从“工程位置”找到文件。
3. 常规编辑从“导出成片”输出；批量任务从右上角“批量混剪”进入，填写数量并先分析再生成。

`.videome` 保存工程结构和素材路径，不复制源媒体。导入文件仍在原位置；本机恢复缓存、工程文件和成片输出目录各自独立。已有缓存会恢复上次内容，新建空白工程会保留素材库，并保留一份切换前工程快照。

原工程文件仅在点击“保存”、按 `⌘S` 或“另存为”时更新。桌面版已关联工程每 10 秒备份到同目录的 `<工程文件名>.autosave-时间戳.videome`，每次使用新的时间戳并清理旧自动备份，只保留最近一份，不修改原文件；可通过“项目 → 打开工程”恢复备份。

## 本地开发

使用 Node.js **24.x** 和 npm，在 macOS arm64 或 Windows x64 执行：

```sh
npm ci
npm run media:prepare
npm run media:check
npm run desktop:dev
```

`media:prepare` 按版本及 SHA-256 清单准备当前平台 FFmpeg、ffprobe 和导出字体，需要联网。Mac 还需要 Xcode Command Line Tools 中的系统构建工具。桌面启动器使用 `127.0.0.1:5173`，退出时清理其子进程。

浏览器界面开发使用 `npm run dev`，地址为 `http://127.0.0.1:4179`。该模式只提供受限的本地媒体 API 和部分导出回退，不支持桌面工程文件操作或批量队列；浏览器与 Electron 的恢复缓存也不共用。

完整环境准备、资源导入和排错见[开发与交付](docs/DEPLOYMENT.md)。

## 检查与打包

```sh
npm test
npm run build
npm run dist:mac
npm run verify:package
```

Windows 原生构建将 `dist:mac` 换为 `dist:win`。打包前先完成 `media:prepare`；`dist:*` 会检查并使用已有媒体资源，不自动重新下载。产物在 `release/`，Vite 静态资源在 `dist/`。

| 命令 | 用途 |
| --- | --- |
| `npm run media:prepare` | 准备当前平台锁定的媒体工具与字体；`bundle:media` 是其别名 |
| `npm run media:check` | 检查媒体架构、能力、字体摘要和 Mac 最低系统版本 |
| `npm run desktop:dev` | 启动 Vite 与 Electron 开发桌面 |
| `npm run dev` / `npm start` | 启动 4179 浏览器预览服务 |
| `npm run desktop` | 仅启动 Electron；开发模式需先有 5173 服务 |
| `npm test` | 运行领域、工程、媒体、队列和恢复测试；需要 FFmpeg/ffprobe |
| `npm run build` | 生成 `dist/` Web 资源 |
| `npm run dist:mac` | 原生构建 arm64 App、DMG 和 ZIP |
| `npm run dist:win` | 原生构建 x64 NSIS 和 Portable |
| `npm run verify:package` | 验证包内模块、字体与实际转码，生成构建信息和摘要 |
| `npm run acceptance:fixtures` | 生成供人工验收使用的 90 秒测试素材 |
| `npm run diagnostics` | 收集本机环境及批次诊断到 `output/diagnostics.json` |

GitHub Actions 提供手动触发的 **Desktop internal test packages** 工作流，分别在 Mac 和 Windows runner 构建。两端构建和包内检查全部成功后，工作流会自动创建一个 GitHub 预发布版本，标签格式为 `v<版本>-build.<运行号>`（例如 `v1.0.0-build.7`），并附上 `.dmg`、`.zip`、Windows `.exe` 和 `SHA256SUMS.txt`。同一次运行重试时会更新同名 Release；构建过程仍会保留 Artifacts 作为诊断备份。工作流已提供不代表远程构建或人工验收已经通过。

## 项目结构

```text
src/                    React 编辑器、批量面板、领域函数、工程会话恢复
  main.jsx              编辑器入口与工程操作
  BatchMixPanel.jsx     批量混剪配置、进度与结果
  project-session.js    空白工程、恢复缓存与旧缓存读取
  domain.js             时间线操作、音乐特征合并与推荐评分
electron/               主进程、preload、工程/媒体/平台运行模块
  batch/                规划、媒体执行、队列、持久化与 IPC
  music-analysis.cjs    本地音乐/视频特征分析、缓存与任务队列
  music-analysis-ipc.cjs 音乐分析 IPC 和路径授权
scripts/                开发启动、媒体准备、打包、诊断与验收脚本
resources/              媒体锁文件、字体及第三方声明
.github/workflows/      手动双平台构建工作流
docs/                   使用、架构、部署与验收文档
dist/                   Web 构建产物（Git 忽略）
media-bin/              当前平台媒体工具（Git 忽略）
release/                桌面安装包与构建报告（Git 忽略）
output/                 下载缓存、测试素材、截图和验收结果（Git 忽略）
userData/music-analysis/ Electron 运行时的本机音乐/视频分析缓存（不在仓库）
```

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [功能说明](docs/FEATURES.md) | 工程入口、素材、剪辑、字幕、导出及快捷键 |
| [批量混剪](docs/BATCH-MIX.md) | 参数、并发、去重、输出和恢复 |
| [批量分段](docs/BATCH-SEGMENT.md) | 固定时长顺序分段、原声、输出和任务控制 |
| [开发与交付](docs/DEPLOYMENT.md) | 环境、媒体依赖、构建、CI 与排错 |
| [架构与数据流](docs/ARCHITECTURE.md) | 模块边界、IPC、工程会话和任务持久化 |
| [功能与操作说明](docs/FEATURES.md) | 智能配乐工作台、本地分析、试听和曲库操作 |
| [本地智能配音计划](docs/SMART-DUBBING-PLAN.md) | 英文转中文的本地模型、编辑流程、入轨规则与验收标准 |
| [批量验收记录](docs/BATCH-MIX-ACCEPTANCE.md) | 两轮 200 条测试及性能限制 |
| [双平台实现与验收记录](docs/CROSS-PLATFORM-IMPLEMENTATION-REPORT.md) | 已验证结果与待验收事项 |
| [双平台人工验收](docs/CROSS-PLATFORM-ACCEPTANCE.md) | 安装包获取、逐步验收与诊断反馈 |

## 当前边界与许可证

- 批量输出面向 SDR；检测到 HDR 会拒绝。完整 HDR / 10-bit 色彩管理尚未实现。
- 批量目录必须支持独占写入、硬链接及空间查询；本轮面向本地 APFS / NTFS。网络盘、UNC 和 exFAT 批量输出不在支持范围。
- `1–8` 路并发表示最大活动任务数，不保证 8 路最快；200 条是验收负载，不是固定生成数量。测试耗时不能直接推算其他素材或机器的性能。
- 普通导出与批量导出的校验强度不同：批量会完整解码并核对帧数、时长和摘要；普通导出主要检查输出视频流。
- 当前仓库没有项目级 `LICENSE`。第三方声明位于 [resources/THIRD-PARTY-NOTICES.txt](resources/THIRD-PARTY-NOTICES.txt)，字体许可和媒体来源、版本及摘要随资源保存。正式发行还需完成发行签名、公证及目标环境验收。
