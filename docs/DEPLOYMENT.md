# 开发、构建与部署

本文档说明 Videome 在本地开发、浏览器预览和 macOS 桌面打包中的运行方式。当前项目没有 CI/CD 配置，也没有代码签名、公证或自动更新流程。

## 1. 运行时依赖

### Node.js

使用 Node.js 18 或更新版本，推荐当前 LTS。安装依赖：

```bash
npm ci
```

`package-lock.json` 是依赖版本的来源，提交依赖变更时应同步更新锁文件。

### FFmpeg 与 FFprobe

媒体探测和导出需要 `ffmpeg` 与 `ffprobe`。macOS 推荐：

```bash
brew install ffmpeg
which ffmpeg
which ffprobe
```

Electron 开发模式会检查以下常见路径：

```text
/opt/homebrew/bin/ffmpeg
/opt/homebrew/bin/ffprobe
/usr/local/bin/ffmpeg
/usr/local/bin/ffprobe
/usr/bin/ffmpeg
/usr/bin/ffprobe
```

macOS 打包配置中的 `extraResources` 还引用：

```text
/opt/homebrew/opt/ffmpeg/bin/ffmpeg
/opt/homebrew/opt/ffmpeg/bin/ffprobe
```

如果本机路径不同，需要在 `package.json` 的 `build.extraResources` 中调整，或在打包前建立对应的安装路径。

## 2. 浏览器预览

浏览器预览用于 UI 开发，不是生产部署服务器：

```bash
npm run dev
```

它使用 `vite.preview.config.js` 提供受限的本地媒体 API、媒体元数据读取、缩略图/帧生成和本地导出回退。服务默认监听：

```text
http://127.0.0.1:4179
```

安全边界：

- API 只接受本机同源请求和短期会话令牌。
- 文件路径限制在项目目录、临时目录、Movies、Desktop 和 Downloads 等允许根目录。
- 不要把该开发服务器暴露到公网，也不要把素材目录映射到公共 Web 服务器。

## 3. Electron 开发

启动桌面开发环境：

```bash
npm run desktop:dev
```

该命令启动：

1. Vite 开发服务器：`127.0.0.1:5173`。
2. `wait-on` 等待 Vite 就绪。
3. Electron 主进程和渲染窗口。

Electron 主进程负责：

- 文件选择器和 `.videome` 工程文件。
- `contextBridge` 暴露的最小 IPC API。
- `videome-media://` 本地媒体协议和路径授权。
- FFmpeg/FFprobe 探测、预览代理、视频帧、导出和导出结果校验。

## 4. 验证

提交或打包前运行：

```bash
npm test
npm run build
git diff --check
```

当前测试包含：

- `src/domain.test.js`：时间线、素材库、字幕和工程领域逻辑。
- `electron/project.test.js`：工程读写和备份行为。
- `electron/preview.test.js`：预览相关逻辑。
- `electron/export.integration.test.js`：调用本机 FFmpeg 验证多轨导出。

如果 FFmpeg 未安装，导出集成测试或桌面导出会失败；这属于环境依赖问题，不应通过修改测试绕过。

## 5. macOS 打包

构建 macOS 目录包：

```bash
npm run dist:mac
```

脚本会先执行 `npm run build`，再运行：

```bash
electron-builder --mac dir
```

构建配置位于 `package.json` 的 `build` 字段：

- 应用 ID：`studio.videome.local`
- 产品名：`Videome`
- macOS 分类：`public.app-category.video`
- 目标：`dir`
- 工程文件关联：`.videome`
- 打包内容：`dist/**/*`、`electron/**/*`
- 资源：FFmpeg、FFprobe（需满足 `extraResources` 路径）

打包后的目录位于 Electron Builder 默认输出目录 `dist/` 附近；由于 `dist/` 同时也是 Vite 构建目录，不应把构建产物提交进 Git。

## 6. 发布前检查

正式发布前至少完成：

1. 在干净 macOS 环境执行 `npm ci`、`npm test` 和 `npm run dist:mac`。
2. 确认打包应用能发现 FFmpeg/FFprobe，并完成真实媒体导入、预览和导出。
3. 验证 `.videome` 双击打开、素材路径丢失后的重新定位和导出失败清理。
4. 配置 Apple Developer ID 代码签名和公证，避免 Gatekeeper 拦截。
5. 决定安装包格式（DMG、ZIP 或 PKG），并补充版本发布流程。
6. 为 FFmpeg、字体、Electron 和其他依赖保留许可证/归属信息。
7. 增加 CI 构建矩阵、产物校验和自动发布策略。

## 7. 故障排查

### 界面能打开但无法导出

检查：

```bash
which ffmpeg
which ffprobe
ffmpeg -version
ffprobe -version
```

然后重启 `npm run desktop:dev`，因为媒体工具在应用启动时探测。

### 浏览器模式无法选择本地文件

这是预期边界。浏览器模式只提供本地预览 API；需要系统文件选择器、工程保存或原生导出时使用 Electron 桌面版。

### 预览无法解码某个视频

保留原始素材不变，使用桌面版的兼容预览代理。代理只写入系统缓存；若仍失败，检查 FFmpeg 是否可执行以及源文件是否可读。

### 打包时找不到 FFmpeg

确认 `/opt/homebrew/opt/ffmpeg/bin/ffmpeg` 和 `ffprobe` 存在，或修改 `package.json` 中的 `build.extraResources` 路径后重新打包。

## 8. 安全建议

- 不要将 `.env`、令牌、私钥、素材目录或用户工程文件提交到仓库。
- 不要把 Vite 本地预览服务绑定到 `0.0.0.0` 并暴露到公网。
- 生产发布前保留 Electron `contextIsolation: true`、`nodeIntegration: false` 和沙箱配置。
- 修改本地媒体协议或路径校验时，必须同时验证目录穿越、符号链接和跨平台路径行为。
