# QuickWin: Windows 平台的 QuickJS 运行时，用 JS 写 Windows 程序，支持 XP+，体积仅 1.5M

QuickWin 是一个 Windows 平台的 QuickJS 运行时，用 JavaScript 写 Windows 原生 GUI 程序，二进制体积仅 1.5MB，支持 Windows XP+（32/64 位）。适合写一些小工具。

> 项目处于早期，功能待完善，包含已知 bug。

[GitHub](https://github.com/xna00/quickwin)

## 快速体验

```powershell
npm install quickwin
npx quickwin node_modules/quickwin/main.js
```

也可以直接从 GitHub Release 下载：

```powershell
iwr https://github.com/xna00/quickwin/releases/latest/download/qwin.exe -OutFile qwin.exe
iwr https://github.com/xna00/quickwin/releases/latest/download/main.js -OutFile main.js
.\qwin.exe main.js
```

## 特性

- **Win32 原生 GUI** —— 原生窗口、按钮、编辑框、列表框、托盘图标、弹出菜单等
- **React 渲染器** —— 用 JSX 声明式 GUI
- **TypeScript 支持** —— 内置完整类型声明（quickwin.d.ts）
- **HTTP/HTTPS** —— fetch() API、Brotli 解压、chunked 传输、条件缓存
- **WebSocket** —— 完整的 RFC 6455 实现，支持 ws:// 与 wss://
- **WebAssembly** —— 基于 WAMR，支持标准 WebAssembly.* API
- **FFI** —— 通过 libffi 调用任意 DLL 函数
- **Polyfills** —— TextEncoder、URL、URLSearchParams、btoa/atob、crypto.subtle、setTimeout
- **动态导入** —— import('https://esm.sh/marked')，无需安装任何依赖