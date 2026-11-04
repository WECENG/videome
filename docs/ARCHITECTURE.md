# 架构与数据流

## 总体结构

Videome 是一个本地优先的 Electron 应用，采用“React 渲染层 + Electron 主进程 + FFmpeg 工具链”的结构：

```text
React UI (src/main.jsx)
        │ contextBridge / IPC
        ▼
Electron preload (electron/preload.cjs)
        │ ipcMain handlers
        ▼
Electron main (electron/main.cjs)
        ├── videome-media:// 本地媒体协议
        ├── videome-frame:// 视频帧协议
        ├── FFprobe 元数据探测
        ├── FFmpeg 预览代理与导出
        └── .videome 工程文件读写
```

浏览器预览不启动 Electron，而是通过 `vite.preview.config.js` 提供受限的本地媒体 API 和导出回退逻辑。

## 前端状态

`App` 保存当前项目、素材库、选择状态、播放状态、撤销/重做历史和导出进度。核心项目对象包括：

- `assets`：工程素材记录和源文件路径。
- `tracks`：轨道类型、顺序、锁定和静音状态。
- `clips`：片段位置、时长、入出点、效果、音量和联动关系。
- `subtitle`：字幕设置与 cue 列表。
- `exportSettings`：导出预设、容器、编码和比特率。

`src/domain.js` 提供纯函数，负责媒体片段创建、选择顺序、时间线移动/分割、素材库合并、工程校验和字幕转换。纯领域逻辑可以在 Vitest 中脱离 Electron 运行。

## 媒体生命周期

1. 用户导入源文件。
2. Electron 主进程通过 FFprobe 读取媒体信息，并按需生成缩略图。
3. 前端将素材元数据加入项目和本地素材库。
4. 用户将素材加入轨道，产生 `clip`；视频含音轨时可产生联动原声片段。
5. Chromium 无法播放源编码时，按需生成 H.264 兼容预览代理。
6. 导出时由 `electron/export.cjs` 将项目状态编译为 FFmpeg 参数。
7. 导出写入临时文件，完成后使用 FFprobe 验证，再移动为最终输出。

## 安全边界

- 渲染进程不启用 Node 集成，使用 `contextIsolation` 和沙箱。
- 主进程只通过白名单 IPC 暴露文件选择、工程读写、媒体处理和导出能力。
- 媒体协议先进行路径授权和目录包含校验，再返回字节流。
- 浏览器预览 API 要求本地来源和会话令牌，并限制可访问根目录。

## 持久化

工程文件是 JSON 格式的 `.videome` 文件，保存项目结构和素材引用，不嵌入源媒体。自动保存使用本地存储；工程文件写入通过 `electron/project.cjs` 的写队列串行化，减少并发保存破坏文件的风险。

## 导出策略

- 原码流保留只在单一兼容视频片段且没有字幕、图文、额外音轨和画面效果时可用。
- 普通高质量导出使用 FFmpeg filter graph 合成视频层、音频层和字幕。
- 图片素材会循环成指定时长的视频层。
- 音乐轨道支持循环、淡入淡出和自动避让人声。
- 输出完成后必须通过视频流校验；校验失败会删除输出文件。
