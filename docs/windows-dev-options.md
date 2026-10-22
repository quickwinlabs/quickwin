# Windows 桌面程序开发方案对比

| 方案 | 最低系统 | 体积 | 开发难度 | 性能 | 跨平台 |
|------|----------|------|----------|------|--------|
| **Electron** | Win10+（旧版可到Win7） | 极大(100MB+) | 低 | 低 | 是 |
| **Tauri** | Win10+（旧版可到Win7，需装WebView2） | 小 | 中 | 高 | 是 |
| **C/C++ + Win32** | Win95+ | 极小 | 高 | 最高 | 否 |
| [**QuickWin**](https://github.com/quickwinlabs/quickwin) | Windows XP | ~1.5MB | 低 | 高 | 否 |
| **Python + PyQt5** | XP+\*（旧版本） | 很大 | 低 | 中 | 是 |
| **C# (WinForms / WPF)** | Win7+（需 .NET 运行时\*） | 较大 | 中 | 高 | 否 |

---

**注释：**

- \* **.NET 运行时**：WinForms/WPF 依赖 .NET Framework。目标 **4.8** 覆盖 Win7+（Win10/11 自带）；目标 **3.5** 才可到 XP，但 Win8/8.1/10/11 默认不启用 3.5。

- \* **XP+（PyQt5）**：需 PyQt5 ≤5.6（对应 Qt 5.6）+ Python ≤3.5 的组合。

---

## 关于 QuickWin

**[QuickWin](https://github.com/quickwinlabs/quickwin)** 是一个 Windows 平台上的 QuickJS 运行时，用 JS 就能写 Windows 原生程序，**JS 脚本可直接嵌入 exe 实现单文件分发**——单文件约 1.5MB、无运行时依赖、支持 XP+，内置 Win32 GUI / React-JSX / HTTP / WebSocket / WASM / FFI。

介绍、快速体验与特性清单见 [quickwin-intro.md](quickwin-intro.md)。
