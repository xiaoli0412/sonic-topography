# Sonic Topography

Sonic Topography 是一个本地音乐可视化程序，使用 React、Three.js、Vite 和 Web Audio 构建。它可以播放本地 Demo、上传音频和 `.lrc` 歌词、通过本地代理搜索网易云音乐、保存浏览器本地歌单，并用音频频谱驱动地形、波纹和流星效果。

## 功能

- 3D 音频响应式地形可视化
- 内置 Demo 音频和同步 LRC 歌词
- 支持上传音频和 `.lrc` 歌词
- 网易云音乐搜索，并过滤不可播放结果
- 通过本地代理加载歌词和音频
- 歌单保存到本地 `data/playlists.json`，浏览器 `localStorage` 作为兜底
- 支持删除歌单歌曲、删除歌单，并带确认弹窗
- 支持上一首、下一首
- 支持顺序播放和随机播放
- Windows 一键启动脚本

## Windows 桌面应用

除了网页版，项目现在还包含基于 Electron 的 Windows 桌面应用。桌面版启动时会自动运行本地后端服务，无需手动打开浏览器，也能独立运行。

### 开发运行

```powershell
npm run electron:dev
```

这会启动 Vite 开发服务器并打开 Electron 窗口（开发模式下会自动打开开发者工具）。

### 构建生产版应用

```powershell
npm run build
npm run electron:build
```

构建流程：

1. `npm run build`：构建前端生产包（输出到 `dist/`）。
2. `npm run electron:build`：使用 electron-builder 打包 Windows 安装程序和便携版。

构建产物位于 `dist-electron/`：

- 安装包：`dist-electron/Sonic Topography Setup 0.0.0.exe`
- 便携版：`dist-electron/Sonic Topography 0.0.0.exe`
- 解压后的程序：`dist-electron/win-unpacked/Sonic Topography.exe`

### 系统托盘行为

桌面应用运行后会在系统托盘显示图标：

- 点击窗口的 **关闭按钮** 不会退出应用，而是最小化到系统托盘；
- 右键托盘图标，选择 **Quit** 才会完全退出应用。

### Windows 桌面应用一键启动

为方便启动桌面版，可使用：

```text
start-windows-app.bat
```

该脚本会：

1. 检查是否已安装 Node.js；
2. 如果已打包的 `dist-electron/win-unpacked/Sonic Topography.exe` 存在，则直接运行它；
3. 否则，如果 `node_modules/` 不存在，自动安装依赖；
4. 否则运行 `npm run electron:dev`。

原有的网页版脚本仍然可用：

- `npm run dev`：启动 Vite 网页开发服务器
- `npm run build`：构建前端生产包
- `npm start`：启动本地生产服务器（网页模式）

## Windows 一键启动

前提：电脑需要先安装 Node.js。

下载或克隆本仓库后，双击：

```text
start-sonic-topography.bat
```

启动脚本会自动：

1. 如果没有 `node_modules/`，自动安装依赖；
2. 如果没有 `dist/`，自动构建项目；
3. 打开 `http://127.0.0.1:4173`；
4. 启动带网易云代理功能的本地生产服务器。

## 开发运行

```powershell
npm install
npm run dev
```

打开：

```text
http://127.0.0.1:3000
```

## 本地生产运行

```powershell
npm run build
npm start
```

打开：

```text
http://127.0.0.1:4173
```

## Demo 文件

内置 Demo 文件在：

```text
public/demo.mp3
public/demo.lrc
```

如果要替换 Demo，请保持这两个文件名不变。

## 给别人使用

对方可以下载 GitHub 仓库 ZIP，解压后双击：

```text
start-sonic-topography.bat
```

注意：这不是完全独立的 `.exe`，对方电脑仍然需要安装 Node.js。

## 注意事项

- 网易云音乐功能使用的是非官方网页接口，并通过本地服务器代理请求。搜索结果会尽量只显示当前可播放的歌曲，但可播放状态仍可能因为版权、会员、地区或登录限制发生变化。
- 歌单优先保存在本地文件 `data/playlists.json`。只要保留项目文件夹，重启应用后歌单还在；浏览器 `localStorage` 只作为兜底。
- `start-sonic-topography.bat` 会在本地启动服务，默认地址是 `http://127.0.0.1:4173`。

## 音源配置与切换

网易云音乐搜索现在支持多音源自动兜底。音源在 `local-server.mjs` 文件顶部的 `NETEASE_SOURCES` 数组中配置，默认包含 `official`（music.163.com）以及几个公开镜像。如果某个源不可用，可将其 `enabled` 设为 `false` 临时禁用。

搜索时会并发请求所有启用的音源，将结果合并、按歌曲 ID 去重后展示。每首结果会显示其可用的音源标签，最大化可搜索到的歌曲量。搜索面板中可以选择 `Auto`（自动选择可用源）或指定某个源；结果列表会显示 `via {source}`，表明当前播放使用的音源。

## 外部音频与本地播放器联动

Electron 桌面版支持外部音频输入，左侧栏提供两种方式：

1. **系统音频捕获**：点击左侧 `Capture` 或 External Audio 面板中的 `Capture System Audio`，在弹出的选择框中选中正在播放音乐的窗口或整个屏幕（如酷狗、浏览器标签页），应用即可实时将该音频输入可视化引擎。捕获仅取音频，不传输视频画面。
2. **手动输入音频 URL**：粘贴外部音频流地址（如 `.mp3`、`.m4a`、直播流等）后点击 Load，即可通过 `AudioEngine` 播放并驱动 3D 可视化。
3. **SMTC 元数据监听（实验性）**：开启 External Audio 面板中的 `Listen to external player` 后，应用会尝试通过 Windows SMTC 获取系统正在播放的曲目标题、艺术家、封面等元数据。当前版本已预留 IPC 与 UI 结构，完整的系统级元数据监听需要安装 Node-RT 包并启用 `electron/main.js` 中的 SMTC 监听器。在网页版中仅支持手动输入 URL。

## 性能与打包优化

本项目针对渲染性能和 Electron 打包体积做了以下优化：

- **音频分析缓存**：`AudioEngine` 对 `analyser.getByteFrequencyData` 的结果按帧缓存，避免同一动画帧内多次调用分析接口。
- **渲染循环暂停**：Three.js 场景在音频暂停、页面隐藏且没有活跃视觉特效（波纹、流星、粒子）时跳过更新，显著降低 GPU/CPU 占用。
- **Uniform 精简**：主题颜色仅在目标值变化时继续插值，浮点型 uniform 只在差值超过阈值时更新，波纹数组仅在新增波纹时重新赋值。
- **减少运行时对象分配**：复用 `THREE.Vector2`、`THREE.Color` 等对象，避免每帧创建新的材质颜色。
- **Electron 包瘦身**：`electron-builder.yml` 显式启用 `asar`，并排除源码、`dist` source map、开发脚本以及 `node_modules` 中的测试、文档、类型声明和 source map；同时移除了未使用的运行时依赖。

## 常用命令

```powershell
npm run lint            # TypeScript 类型检查（tsc --noEmit）
npm run dev             # 启动 Vite 网页开发服务器
npm run build           # 构建前端生产包
npm start               # 启动本地生产服务器（网页模式）
npm run electron:dev    # 启动 Electron 桌面应用开发模式
npm run electron:build  # 构建 Windows 桌面安装包和便携版
npm run electron:pack   # 只打包解压版（不生成安装包）
```
