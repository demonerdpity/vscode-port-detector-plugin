# Port Inspector

`Port Inspector` 是一个 VS Code 扩展，用来查看当前扩展宿主环境中的端口占用情况，支持在确认后终止对应进程。

## 功能概览

- 支持 `Windows`
- 支持 `Linux`
- 支持 `Remote - WSL`
- 底部状态栏入口，点击后在主编辑区打开面板
- 自动识别当前环境，并支持手动强制切换环境
- 支持按端口号过滤
- 使用方正、线条化表格展示端口信息
- 展示协议、地址、端口、PID、进程名、命令行或可执行路径
- 点击 `Stop` 后二次确认，再执行终止
- Windows 与本地 Linux / WSL 在原生命令不可用时，会回退到纯 TCP 监听探测

## 面板行为

- 扩展查询的是“当前扩展宿主所在环境”的端口。
- 扩展声明为 `workspace` 类型，因此在本地窗口运行时会查本机，在 `Remote - WSL` 或远端 Linux 窗口运行时会尽量查对应工作环境。
- 在本机 Windows 窗口中运行时，默认显示 Windows 端口；若系统已安装 WSL，也可以手动切换到某个 WSL 发行版。
- 在 `Remote - WSL` 窗口中运行时，默认显示当前 WSL 发行版内的端口；若 WSL 互操作可用，也可以手动切换查看 Windows 主机。
- Linux / WSL 默认优先使用 `ss`，拿不到时回退到 `netstat`。
- 某些系统进程或受限进程可能因权限不足而无法读取完整命令行；在 fallback 模式下，扩展会尽量展示探测到的端口，但 `Stop` 会被禁用。
- 若手动切换到的目标环境当前不可用，扩展会自动退回 `Auto`。

## 使用方式

1. 在 VS Code 中打开本项目目录。
2. 按 `F5` 启动 `Extension Development Host`。
3. 在新窗口底部点击 `Port Inspector`。
4. 在主编辑区面板中查看端口列表。
5. 通过右上角下拉框确认自动识别结果，或手动切换环境。
6. 需要终止进程时，点击对应行的 `Stop`。

## 开发检查

```powershell
npm run check
```

## 项目结构

- `package.json`: 扩展清单、命令、仓库元信息
- `src/extension.js`: 状态栏按钮、WebviewPanel、环境切换、刷新与终止逻辑
- `src/portRegistry.js`: Windows / Linux / WSL 环境识别、端口扫描、fallback 与 kill 逻辑
- `media/main.js`: 前端表格渲染与交互
- `media/styles.css`: 方正线条风格样式
- `resources/port-view.svg`: 项目内资源图形

## 后续发布到 VS Code Marketplace 前

还需要你准备自己的 VS Code Marketplace publisher 和 Personal Access Token。仓库内的扩展元信息已经补齐，可以继续直接走 `vsce` / Marketplace 发布流程。