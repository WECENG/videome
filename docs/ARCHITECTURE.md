# 架构与数据流

适用版本：`0.1.0 Preview`。核对日期：2026-11-05。

## 1. 运行结构

```text
React 编辑器 main.jsx / 批量面板 BatchMixPanel.jsx
        │ window.videome：contextBridge / IPC
        ▼
preload.cjs → main.cjs
        ├── project.cjs：工程保存、写队列和空时间线覆盖前备份
        ├── export.cjs / preview.cjs：普通导出与预览参数
        ├── runtime.cjs：工具、字体、编码器与路径处理
        ├── filesystem.cjs / processes.cjs：平台文件操作和进程终止
        └── batch/
            ├── ipc.cjs：主进程接口与代表工程
            ├── planning.cjs：帧预算、切片、随机序列和去重
            ├── media.cjs / process.cjs：媒体执行与守护包装器
            └── manager.cjs / store.cjs：调度、资源锁与持久化
```

开发桌面由 `scripts/desktop-dev.cjs` 启动 Vite 5173 和 Electron；打包版从应用内部读取 `dist/index.html`。浏览器预览使用独立的 `vite.preview.config.js`，在 4179 提供受限的本地 HTTP 媒体接口和普通导出回退，不包含主进程批量队列。

## 2. 前端状态与工程会话

`src/domain.js` 提供时间线操作、素材合并、字幕转换、导出评估和默认/示例工程。默认工程为空白；`sampleProject` 只供用户主动打开布局示例，不附带媒体。

工程核心字段为 `schemaVersion`、名称、`frameSize`、`frameRate`、`duration`、`playhead`、`assets`、`tracks`、`clips`、`subtitle` 和 `exportSettings`。片段通过 `assetId` 引用素材，通过 `linkedClipId` 等字段关联原声。素材库可以跨新建工程保留，当前工程的素材集合与库状态由界面合并管理。

`src/project-session.js` 管理空白工程和浏览器本地恢复：

| 键 | 用途 |
| --- | --- |
| `videome-session` | 版本 1 会话，包含 `project` 和对应文件 `path`，优先用于恢复 |
| `videome-assets` | 本机素材库记录 |
| `videome-previous-project` | 最近一次切换前的工程、路径及时间 |
| `videome-autosave` / `videome-project` | 兼容旧保存记录，读取较新的时间戳 |

状态变化后约 500 ms 缓存当前会话；有实际内容时，每 6 秒的自动保存任务还会刷新恢复记录，并在文件名与工程名匹配时写回已关联文件。工程切换使用独立身份计数，阻止旧异步保存或探测结果写入新工程。切换前快照与已保存的 `.videome` 是不同的恢复层。

桌面 `.videome` 是 JSON，不嵌入媒体。`project.cjs` 按目标路径串行写临时文件再替换；空时间线写入一个原本含片段的工程前，会保留 `.backup-时间戳`。前端“工程位置”通过 `getStorageLocations` 获取实际用户数据目录，通过 `showProjectInFolder` 定位已存在的工程。

## 3. 媒体与普通导出

1. 文件选择或导入请求交给主进程，ffprobe 读取媒体信息，按需生成缩略图。
2. 界面保存素材记录，加入轨道后产生源区间和联动原声片段。
3. 主进程通过 `videome-media://` 授权媒体访问，`videome-frame://` 提供缓存帧；无法直接预览时可生成 H.264 代理。
4. `export.cjs` 将时间线编译为多输入 FFmpeg 滤镜图，处理裁切、时间戳、叠加、字幕与音轨。
5. 普通导出先写同目录临时文件；编码结束后移动至目标路径，再通过 ffprobe 确认有视频流。验证失败会删除本次输出。它不执行批量模式的完整解码、精确帧数和 SHA-256 验证。

原码流保留有单片段及容器兼容限制。H.264/HEVC 在 Mac 使用 VideoToolbox，匹配硬件初始化错误时软件重试一次；Windows 采用 `libx264/libx265`。WebM 为 VP9/Opus，无损中间文件为 FFV1/PCM MKV。标题、字幕和封面文字使用随包 Noto Sans CJK SC。

## 4. 批量规划与资源调度

`planning.cjs` 将请求秒数转换为整数帧预算，固定切片可吸附附近场景边界。序列使用算法版本、种子、输出序号和尝试序号派生随机状态，按片段与区间、使用帧数和顺序生成签名。所有序列先生成、去重和保存，再允许开始编码；完成顺序不参与规划。

`BatchMixManager` 在 Electron 主进程持有，分析任务串行，执行批次一次一个。`ResourceGate` 统一锁定批量分析/执行与普通导出；`BackgroundLane` 将代理和缩略图串行并在批量占用时延后。

自动并发为 1 或 2，前两条输出先单路执行；手动最大 1–8。单条编码、验证和发布都占任务槽。通过 `notify()` 限制每个批次的进度事件至每秒最多 4 次。界面关闭或刷新不销毁 manager。

媒体由 `process.cjs` 守护进程启动。取消通过 IPC 通知停止；Mac 使用信号，Windows 按本应用创建的 PID 调用 `taskkill.exe /T`，超时强制结束。主进程断开 IPC 时守护进程尝试清理 FFmpeg；意外退出的恢复以清单和磁盘状态为准。

## 5. 批量持久化与恢复

权威记录是 `userData/batch-mix/<jobId>/job.json`，保存源 SHA-256、媒体信息、参数快照、算法/FFmpeg 版本、完整序列、序号和状态。`store.cjs` 将写入排入单队列，写临时文件、刷新、替换并保留 `.bak`；输出目录的 JSON 是副本，CSV 是派生视图。

单条过程：独占创建 `.partial` → 源区间解码与合成 → 完整解码校验 → 流/帧数/时长/摘要验证 → 保存 `publishing` 状态 → 硬链接独占发布 → 删除临时文件 → 提交完成状态。输出目录先检查所需文件操作能力，已有无关同名文件不覆盖。

启动后将遗留活动批次标为 `interrupted`。继续时重新核对源指纹，并协调清单与磁盘：成功输出按摘要检查，未提交的正式文件重新验证，残余临时文件删除重做。重试保留原序号和序列。分析未完成且没有序列的批次需重新分析。

Windows 不执行 POSIX 目录 fsync；文件仍刷新并保留备份，不宣称所有文件系统都具备相同的断电保证。本轮输出面向本地 APFS/NTFS。

代表工程由保存的序列引用原视频源区间重建，画面连续、原声联动，使用独立 `.videome` 路径。载入前将当前工程另存至 `userData/batch-project-recovery/`。

## 6. 接口与安全边界

渲染层保持 `contextIsolation: true`、`nodeIntegration: false` 和沙箱。preload 仅暴露明确的文件、工程、媒体、进度订阅及批量方法；主进程执行路径和参数校验。

主要接口组：

- 工程：`openProject`、`saveProject`、`saveProjectFile`、`chooseProjectLocation`、`getStorageLocations`、`showProjectInFolder`。
- 媒体：`pickMedia`、`probeMedia`、`requestMedia`、`createPreviewProxy`、`exportFrame`、`exportMedia`、`cancelExport`。
- 批量：`createBatchMixAnalysis` 返回 `jobId`；配合 get/list、start/pause/resume/cancel/retry、create-project、remove/cache 和 `onBatchMixProgress`。方法名以 `preload.cjs` 为准。

媒体协议验证目录包含关系和授权；浏览器 API 限制本机来源、会话令牌和允许根目录。本地服务不用于公网部署。没有云端推理或媒体上传流程；依赖准备和首次构建需要网络下载。

## 7. 打包与平台模块

开发模式依次定位显式环境变量、平台媒体目录、旧资源目录、PATH 和 Mac 常见路径；打包版只读取 `resources/media-bin`，不回退系统安装。导出字体独立放入 `resources/fonts`，媒体可执行文件不放进 ASAR。

媒体来源锁文件位于 `resources/`。Mac 依赖改为应用内相对引用并本地签名，检查 arm64 和 macOS 15.0 部署目标；Windows 检查 PE x64、编码器和滤镜能力。`dist/`、`media-bin/`、`release/` 和 `output/` 分别用于 Web 资源、媒体工具、安装包与检查材料、下载/验收数据。

GitHub Actions 通过 `workflow_dispatch` 在对应平台原生构建。自动检查和人工验收分开记录，详细命令见[开发与交付](DEPLOYMENT.md)。
