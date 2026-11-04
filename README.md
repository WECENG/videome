# Videome

Videome 是一款本地优先（local-first）的 AI 辅助视频创作工具。它使用 React + Vite 构建编辑界面，以 Electron 提供桌面能力，并通过本机 FFmpeg/FFprobe 完成媒体探测、预览、转码与导出。

> 当前版本：`0.1.0` · Preview

## 特性

- **素材库**：导入视频、音频和图片，记录媒体元数据，支持搜索、批量选择和快速加入时间线。
- **多轨时间线**：视频、画面叠加、图文、字幕、原声和背景音乐轨道；支持拖放、移动、裁切、分割、删除、波纹删除、轨道锁定与静音。
- **选中顺序编排**：按素材库中的选择顺序，将多个素材从左到右连续加入轨道。
- **本地预览**：桌面版通过受控的 `videome-media://` 协议读取本地媒体；浏览器预览使用 Vite 本地媒体服务。
- **字幕工作流**：手工编辑字幕、导入/导出 SRT，并在导出时烧录字幕。
- **配乐与混音**：导入已授权的本地音乐，支持循环、淡入淡出、音量和人声自动避让参数。
- **成片导出**：支持 H.264、HEVC、FFV1，MP4、MOV、MKV、WebM，以及原码流保留模式（有严格条件限制）。
- **批量混剪**：长视频镜头对齐切片、固定种子随机重组、批次内去重、1–8 路受控并发，用户可配置每批生成 1–1000 条，支持暂停与断点恢复，以及原始切片代表工程。详见 [批量混剪说明](docs/BATCH-MIX.md)。
- **本地工程**：工程保存为 `.videome` 文件，自动保存和素材清单保存在本机，不上传源媒体。

## 快速开始

### 环境要求

- Node.js 18+（推荐当前 LTS）
- npm 9+
- macOS 运行桌面版时推荐安装 Homebrew FFmpeg：

```bash
brew install ffmpeg
```

桌面版会寻找 `ffmpeg` 和 `ffprobe`。开发环境常用路径包括 `/opt/homebrew/bin`、`/usr/local/bin` 和 `/usr/bin`；macOS 打包前自动收集工具及非系统动态库并改写为应用内相对依赖。

### 安装依赖

```bash
npm ci
```

### 启动桌面开发环境

```bash
npm run desktop:dev
```

该命令会启动 Vite（`127.0.0.1:5173`）并等待服务就绪后启动 Electron。

### 启动浏览器预览

```bash
npm run dev
```

浏览器预览运行在 `127.0.0.1:4179`。它适合界面开发和没有 Electron 的快速体验；文件选择器、桌面工程保存、原生导出等能力以桌面版为准。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 按锁文件安装依赖 |
| `npm run desktop:dev` | 启动 Electron + Vite 桌面开发环境 |
| `npm run dev` | 启动浏览器本地预览 |
| `npm test` | 运行 Vitest 单元测试与导出集成测试 |
| `npm run build` | 构建 Vite 静态资源到 `dist/` |
| `npm run dist:mac` | 构建 Vite 并生成 macOS Electron 目录包 |

## 文档

- [功能说明](docs/FEATURES.md)
- [开发与部署](docs/DEPLOYMENT.md)
- [架构与数据流](docs/ARCHITECTURE.md)

## 项目结构

```text
.
├── electron/
│   ├── main.cjs       # Electron 主进程、IPC、本地媒体协议、导出
│   ├── preload.cjs    # contextBridge 安全 API
│   ├── export.cjs     # FFmpeg 导出参数与能力校验
│   ├── preview.cjs    # 预览代理参数
│   └── project.cjs    # .videome 工程读写与规范化
├── src/
│   ├── main.jsx       # React 编辑器界面与交互
│   ├── domain.js      # 时间线、素材和导出领域逻辑
│   └── styles.css     # 编辑器样式
├── public/            # 静态资源
├── index.html         # Vite 入口
└── package.json       # 脚本、依赖和 Electron Builder 配置
```

## 隐私与媒体安全

- 源视频、音频、图片和字幕默认只在本机读取。
- Electron 主进程通过受控协议和已授权路径读取媒体，避免渲染进程直接获得 Node.js 能力。
- 预览代理、缩略图、视频帧等缓存写入系统缓存目录，不会修改原始媒体。
- 导出使用临时文件，完成验证后再替换为最终文件；失败时清理临时文件。

## 当前预览版边界

- 语音识别界面会检查本机 Whisper/whisper.cpp 配置；未安装模型时不会生成虚构字幕。
- macOS 打包脚本当前生成 `dir` 目录包，未配置代码签名和公证。
- `npm run build` 只构建 Web 资源，不等同于可独立运行的桌面安装包。
- 生产发布前仍需针对目标平台补充安装包格式、签名、公证、自动更新和 CI 流程。

## 许可证

当前仓库尚未声明开源许可证。公开发布前，请根据项目计划补充 `LICENSE` 文件和第三方依赖归属说明。
