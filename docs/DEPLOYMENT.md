# 开发、构建与内部交付

适用版本：`0.1.0 Preview`。核对日期：2026-11-05。本轮目标为 macOS 15.0+ arm64 与 Windows x64。本机已验证 macOS 26 开发和安装包，macOS 15 实机、Windows CI 构建及 Windows 人工操作仍待验收。

## 1. 环境与启动

源码开发使用 Node.js **24.x** 和 npm，依赖版本以 `package-lock.json` 为准。Mac 需要 Xcode Command Line Tools 的 `xcrun`、`otool`、`lipo`、`install_name_tool`、`codesign` 等系统工具；当前打包只接受 darwin-arm64 或 win32-x64。

```sh
npm ci
npm run media:prepare
npm run media:check
npm run desktop:dev
```

以上命令可在 Mac shell 或 Windows cmd/PowerShell 使用。媒体准备与首次构建需要联网；安装包运行无需 Node、FFmpeg 或 Homebrew。

| 命令 | 行为 |
| --- | --- |
| `npm run desktop:dev` | 启动 Vite 5173，等待就绪后启动 Electron；退出时清理子进程 |
| `npm run desktop` | 仅启动 Electron 开发入口，需已有 5173 服务 |
| `npm run dev` / `npm start` | 独立的浏览器开发服务，监听 `127.0.0.1:4179` |
| `npm run build` | Vite 生产资源到 `dist/`，不生成安装包 |

浏览器只提供 UI、本地媒体 API 和部分普通导出回退，没有桌面文件工程操作和批量队列。浏览器、开发桌面和安装版可能使用不同用户数据/存储来源；不要把开发预览服务暴露到公网。

## 2. 媒体依赖与字体

`npm run media:prepare`（别名 `bundle:media`）准备 `media-bin/<platform>-<arch>/`：

- Windows：下载 `resources/media-sources.json` 中固定的 FFmpeg 9.0.2 静态包，验证 SHA-256，提取 `ffmpeg.exe`、`ffprobe.exe` 和许可文件。
- Mac：按 `resources/macos-media-lock.json` 下载锁定的 macOS 15 arm64 Homebrew bottles，收集工具与动态库、改写内部引用、执行 ad-hoc 签名；不要求安装到本机 Homebrew。
- 字体：固定 Noto Sans CJK SC，准备至 `resources/fonts/`，核对字体及许可摘要。

`media:check` 检查编码器、滤镜和可执行能力。Mac 额外检查所有媒体二进制架构、最低版本不高于 15.0 及无外部 Homebrew 引用；Windows 检查 PE x64。缺依赖或检查失败应修复资源，不能跳过媒体测试。

下载与解压缓存位于 `output/media-downloads/`。资源清单记录来源、版本、SHA-256 及对应源码。不要手动降低 Mach-O 的部署标记来绕过检查，也不要用本机要求 macOS 26 的动态库替代缺少的兼容资源。

### 定位优先级

开发模式依次检查：

1. `VIDEOME_FFMPEG` / `VIDEOME_FFPROBE` 指定的可执行文件完整路径。
2. `media-bin/darwin-arm64/` 或 `media-bin/win32-x64/`。
3. 旧开发目录 `media-bin/`。
4. 系统 PATH；Mac 再检查 Homebrew/Unix 常见位置。

打包版只使用应用的 `resources/media-bin`，不接受外部工具回退。Mac 标题、字幕、封面文字及 Windows 导出都使用随包字体；界面字体与导出字体不是同一加载路径。

### 导入已准备资源

可下载 Actions 的独立媒体 Artifact，先解压其中的 `media-darwin-arm64.tar.gz` 或 `media-win32-x64.tar.gz`，将 `VIDEOME_MEDIA_IMPORT` 指向解压出的平台目录，再运行 `media:prepare`。导入源不能与目标目录相同，且必须匹配当前系统和架构。

Mac 示例：

```sh
VIDEOME_MEDIA_IMPORT="/absolute/download/darwin-arm64" npm run media:prepare
```

Windows PowerShell 示例：

```powershell
$env:VIDEOME_MEDIA_IMPORT = 'C:\Downloads\win32-x64'
npm run media:prepare
Remove-Item Env:VIDEOME_MEDIA_IMPORT
```

导入流程同样执行架构和运行检查。

## 3. 自动检查与桌面冒烟

```sh
npm test
npm run build
git diff --check
```

最近一次本机完整测试为 71 项，通过日期为 2026-11-05；该数字是验收记录，不是固定测试数量。测试覆盖领域、工程保存、会话恢复、跨平台工具、真实媒体、队列及崩溃协调。

需要检查桌面行为时，先启动 `desktop:dev`，再在另一个终端执行：

```sh
node scripts/desktop-project-smoke.cjs
node scripts/desktop-batch-smoke.cjs
```

脚本启动独立测试用户数据目录，分别验证新建/保存/另存为/恢复，以及批量分析/生成/代表工程/普通字幕导出，结束后清理测试目录。截图在 `output/playwright/`；已有桌面窗口与测试窗口分开。

## 4. 原生打包

`dist:*` 使用已有合格媒体资源，不自动执行 `media:prepare`。必须在目标系统执行，Windows 推荐使用 Actions 的 Windows runner。

Mac：

```sh
npm run dist:mac
npm run verify:package
node scripts/desktop-project-smoke.cjs release/mac-arm64/Videome.app/Contents/MacOS/Videome
node scripts/desktop-batch-smoke.cjs release/mac-arm64/Videome.app/Contents/MacOS/Videome
```

Windows：

```sh
npm run dist:win
npm run verify:package
```

| 产物（版本由 package.json 决定） | 路径示例 |
| --- | --- |
| Mac App | `release/mac-arm64/Videome.app` |
| Mac 安装镜像 / App ZIP | `release/Videome-0.1.0-mac-arm64.dmg`、同名前缀 `.zip` |
| Windows 解包目录 | `release/win-unpacked/` |
| Windows 安装 / 免安装 | `release/Videome-0.1.0-win-x64-setup.exe`、`…-portable.exe` |
| 包检查记录 | `release/build-info.json`、`release/SHA256SUMS.txt` |

`verify:package` 默认检查当前平台的解包资源，也接受资源目录参数：

```sh
npm run verify:package -- /absolute/path/to/Resources
```

它检查 ASAR 入口与共享模块、字体摘要、媒体能力，实际执行包内工具中文烧字转码、完整解码和 30 帧校验。之后为安装产物计算 SHA-256，并写出源码版本、工作区是否有改动、环境、媒体文件摘要等信息。`manualAcceptance` 保持 `pending`，不能把脚本通过等同于安装和人工操作通过。

构建结束后再使用摘要清单。后来添加的独立媒体归档不由 `verify:package` 自动纳入其摘要范围。Mac ZIP 保留 App 结构及权限，不能只复制内部可执行文件。

## 5. GitHub Actions 与交付材料

在已推送的源码版本上，手动运行 [Desktop internal test packages](../.github/workflows/desktop-build.yml)。当前矩阵为 `macos-15` arm64、`windows-2022` x64，并在任务开始检查实际架构。

流程包括 `npm ci`、媒体准备、完整测试、原生构建、包内实际转码检查及验收材料生成。测试、构建和包检查日志会上传。产物通过 Artifacts 保存 30 天，不自动创建公开 Release，不自动运行 Windows 人工验收。

- `Videome-<平台>-<运行号>`：安装包、摘要、构建信息、日志和 `manual-acceptance/`。
- `media-<平台>-<运行号>`：独立媒体 `.tar.gz`，供本机构建导入。
- 失败时上传可用的构建信息与诊断日志。

工作流文件存在不代表已运行。本地未提交/未推送的改动不会参与远程构建。Windows Server runner 结果也不替代 Windows 11/10 的安装、界面、文件关联和真实批量人工验收。

在本地准备同样的验收材料：

```sh
npm run acceptance:fixtures
node scripts/acceptance-materials.cjs
```

`release/manual-acceptance/` 包含固定素材、验收步骤、Windows 诊断脚本和待填写的 `result.json`。这些文件是生成时的副本；修改源文档后需重新生成交付材料。完整清单见[人工验收指南](CROSS-PLATFORM-ACCEPTANCE.md)。

## 6. 安装与存储

Mac 包仅做 ad-hoc 本地签名，无 Developer ID 或公证；Windows 无发行签名，系统可能提示未知来源。首轮为内部测试，不提供自动更新。

NSIS 按机器安装，需要管理员权限，可选择目录并注册 `.videome`。Portable 不主动注册文件关联，但仍把任务数据写入当前用户 AppData；卸载配置保留用户数据、工程和成片。

实际工程位置由用户保存时决定。App 内“尚未保存 / 工程位置”显示完整 `.videome` 路径和实际 `userData` 目录；开发版与安装版名称可能导致用户目录不同，不应直接猜测目录名或共享缓存。

| 数据 | 位置 |
| --- | --- |
| 工程和源媒体 | 用户选择的位置；工程只引用媒体路径 |
| 会话和素材库恢复 | 当前 Electron/浏览器来源的本地存储 |
| 批量权威清单与缓存 | `userData/batch-mix/` |
| 代表工程切换前快照 | `userData/batch-project-recovery/` |
| 批量成片、JSON/CSV、代表工程 | 用户输出目录下的独立批次子目录 |
| 缩略图、视频帧及预览代理 | 系统缓存目录中的 Videome 缓存 |

批量输出面向可写本地 APFS / NTFS，创建前检查独占写入、硬链接及空间查询；Windows UNC 输出明确拒绝。exFAT 和网络盘不在支持范围。Windows 不执行 POSIX 目录 fsync，不能承诺各文件系统相同的断电原子性。

## 7. 诊断与排错

```sh
npm run diagnostics
npm run diagnostics -- /absolute/diagnostics.json
node scripts/batch-acceptance.cjs "/absolute/source.mp4" "/absolute/output-directory"
```

诊断默认写入 `output/diagnostics.json`，包括系统、工具版本、批次状态和错误。脚本默认查小写 `videome` 用户数据目录；若记录不全，将 `VIDEOME_USER_DATA` 指向 App 工程位置面板显示的实际目录后重跑。仅安装包的 Windows 用户可使用验收包中的 PowerShell 诊断脚本；它检查 `Videome` 与 `videome` 两种目录名。

批量验收脚本执行 1/2/4 路各 4 条及 2 路 200 条，输出固定 640×360、30 秒/900 帧。报告包括耗时、失败、签名、输出大小和采样进程树 RSS；不含系统硬件媒体服务内存，不能视为整机峰值。

| 问题 | 处理 |
| --- | --- |
| 没有工具、字幕滤镜或字体 | 运行 `media:prepare` 和 `media:check`；打包漏资源时重新构建 |
| 旧示例仍出现 | 缓存会保留，选择“项目 → 新建空白工程”；不要删除真实工程来重置界面 |
| 找不到工程或输出 | 用“工程位置”定位 `.videome`，用批次“输出目录”定位成片 |
| 批量中断或素材移动 | 从历史“校验并继续”或“重新定位源视频”，只接受内容相同的文件 |
| 5173 已占用 | 停止已有开发服务再启动；启动器使用严格端口 |
| 下载出现证书/镜像错误 | 检查本机代理和旧镜像配置，使用有效来源，不关闭 TLS 校验 |

诊断可能包含素材路径及错误内容，发送前可检查。文档修改无需重启应用；代码或入口改动完成后，应重启 `desktop:dev` 并确认窗口及相关操作恢复。
