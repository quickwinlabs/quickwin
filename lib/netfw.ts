// netfw —— Windows 防火墙（INetFwPolicy2 COM）：只读查询 + 放行
//
// 用途：本机监听入站端口给局域网访问（lanfile 等）时，Windows 防火墙默认拦截。
// 首次监听通常弹"安全警报"，但点取消 / 通知被关 / 公用网络下会静默拦截——用户只看到
// 手机打不开，程序内无任何线索。本模块补上这条信息链：
//
//   queryFirewall(exePath)  只读查询（无需管理员）：当前 profile 位掩码、各 profile 的
//                           防火墙开关、是否已有本 exe 的入站允许规则。
//   allowApp(exePath)       放行：ShellExecuteW("runas") + netsh 加规则。COM 修改需管理员
//                           且不会自动提权，故走 runas 让系统弹 UAC。
//
// 兼容性：INetFwPolicy2 是 Vista+；XP 无此接口，CoCreateInstance 失败 → checked=false，
// 调用方退化为纯提示（不要当成"防火墙没问题"）。
//
// COM 派发按 vtable 槽（见 lib/com.ts 头注释）：IUnknown 3 槽 + IDispatch 4 槽后才是
// 本接口的方法，槽号对照 netfw.h 的声明顺序。
import * as ffi from 'ffi'
import { bindAt } from './ffi/bind.js'
import { NULL, PTR_SIZE, PtrArrayBuffer } from './ffi/ctype.js'
import { FAILED, SUCCEEDED, guidFields } from './com.js'
import { CoCreateInstance, CoInitializeEx, CoUninitialize } from './windows/ole32.js'
import { IID } from './windows/structs.js'
import { SysFreeString, VariantClear } from './windows/oleaut32.js'
import { ShellExecute } from './windows/shell32.js'
import { ClsCtx, CoInitFlag, Guid, NetFwAction, NetFwRuleDir, ShowWindowCmd } from '../constants'

const SZ = PTR_SIZE
/** VARIANT 字节数：x86 16 / x64 24（vt 在 0，union 在 8） */
const VARIANT_SIZE = SZ === 8 ? 24 : 16
/** VARIANT.vt = VT_DISPATCH：规则枚举器交回的 INetFwRule */
const VT_DISPATCH = 9
/** VARIANT_TRUE = -1（short 全 1） */
const VARIANT_TRUE = -1

// INetFwPolicy2 / INetFwRules / INetFwRule 的 vtable 槽（IUnknown 0..2 + IDispatch 3..6 之后）
// 注意 netfw.h 里多数属性是 getter 在前、putter 在后（Name/Description/ApplicationName 等），
// 槽号按声明顺序数，别按 put/get 成对猜。
const SLOT_QI = 0
const SLOT_RELEASE = 2
const SLOT_NEXT = 3              // IEnumVARIANT::Next
const P2_CURRENT_PROFILES = 7    // INetFwPolicy2::get_CurrentProfileTypes
const P2_FIREWALL_ENABLED = 8    // INetFwPolicy2::get_FirewallEnabled
const P2_RULES = 18              // INetFwPolicy2::get_Rules
const RULES_NEW_ENUM = 11        // INetFwRules::get__NewEnum
const RULE_APP_NAME = 11         // INetFwRule::get_ApplicationName
const RULE_DIRECTION = 27        // INetFwRule::get_Direction
const RULE_ENABLED = 33          // INetFwRule::get_Enabled
const RULE_PROFILES = 37         // INetFwRule::get_Profiles
const RULE_ACTION = 41           // INetFwRule::get_Action

export interface FirewallStatus {
    /** 查询是否成功（XP / COM 不可用 → false，此时其余字段无意义） */
    checked: boolean
    /** 当前 profile 中是否有任一开启防火墙 */
    firewallOn: boolean
    /** 当前 profile 位掩码（NetFwProfile.* 的按位或） */
    currentProfiles: number
    /** 是否已有本 exe 的入站允许规则（启用且覆盖当前 profile） */
    allowed: boolean
}

function vtable(obj: number, slot: number): number {
    return ffi.readPtr(ffi.readPtr(obj) + slot * SZ)
}

function release(obj: number): void {
    if (!obj) return
    const fn = bindAt(vtable(obj, SLOT_RELEASE), '<>ptr -> u32')
    fn(obj)
}

/** QueryInterface：iid 用 constants.ts 的 Guid 字符串形，成功返回新接口指针 */
function queryInterface(obj: number, iid: string): number {
    const out = new PtrArrayBuffer(SZ)
    const fn = bindAt(vtable(obj, SLOT_QI), '<>ptr <IID>ptr! <>ptr -> i32', { IID })
    if (FAILED(fn(obj, guidFields(iid), out.ptr))) return 0
    return ffi.readPtr(out.ptr)
}

function readI32(ptr: number): number {
    return new DataView(ffi.readBytes(ptr, 4)).getInt32(0, true)
}

function readI16(ptr: number): number {
    return new DataView(ffi.readBytes(ptr, 2)).getInt16(0, true)
}

/** BSTR → JS 字符串（BSTR 的 4 字节长度前缀是**字节数**，内容是 UTF-16LE）。
 *  不用 SysStringLen：实测它返回字符数，直接读前缀更稳。 */
function bstrToString(bstr: number): string {
    if (!bstr) return ''
    const byteLen = new DataView(ffi.readBytes(bstr - 4, 4)).getUint32(0, true)
    if (byteLen === 0 || (byteLen & 1) !== 0) return ''
    const dv = new DataView(ffi.readBytes(bstr, byteLen))
    let s = ''
    for (let i = 0; i < byteLen; i += 2) s += String.fromCharCode(dv.getUint16(i, true))
    return s
}

/** 单条规则是否满足：入站 + 允许 + 启用 + 覆盖当前 profile + 本 exe */
function ruleMatches(rule: number, exePath: string, profiles: number): boolean {
    const appOut = new PtrArrayBuffer(SZ)
    const getApp = bindAt(vtable(rule, RULE_APP_NAME), '<>ptr <>ptr -> i32')
    if (FAILED(getApp(rule, appOut.ptr))) return false
    const bstr = ffi.readPtr(appOut.ptr)
    let app = ''
    try {
        app = bstrToString(bstr)
    } finally {
        if (bstr) SysFreeString(bstr)
    }
    if (!app || app.toLowerCase() !== exePath.toLowerCase()) return false

    const dirOut = new PtrArrayBuffer(4)
    const getDir = bindAt(vtable(rule, RULE_DIRECTION), '<>ptr <>ptr -> i32')
    if (FAILED(getDir(rule, dirOut.ptr))) return false
    if (readI32(dirOut.ptr) !== NetFwRuleDir.IN) return false

    const enOut = new PtrArrayBuffer(2)
    const getEn = bindAt(vtable(rule, RULE_ENABLED), '<>ptr <>ptr -> i32')
    if (FAILED(getEn(rule, enOut.ptr))) return false
    if (readI16(enOut.ptr) !== VARIANT_TRUE) return false

    // 明确 BLOCK 的规则不算放行（同优先级下 Windows 阻止优先）
    const actOut = new PtrArrayBuffer(4)
    const getAct = bindAt(vtable(rule, RULE_ACTION), '<>ptr <>ptr -> i32')
    if (SUCCEEDED(getAct(rule, actOut.ptr)) && readI32(actOut.ptr) !== NetFwAction.ALLOW) return false

    const pfOut = new PtrArrayBuffer(4)
    const getPf = bindAt(vtable(rule, RULE_PROFILES), '<>ptr <>ptr -> i32')
    if (FAILED(getPf(rule, pfOut.ptr))) return false
    return (readI32(pfOut.ptr) & profiles) !== 0
}

/** 遍历 INetFwRules，找本 exe 的入站允许规则
 *
 *  枚举器交回的元素是 INetFwRule，但实测其 QI 只认 IUnknown（查 IDispatch /
 *  IID_INetFwRule 均 E_NOINTERFACE），vtable 本身正常。故不 QI，直接按
 *  INetFwRule 槽位派发；对象由 VARIANT 持有，读完 VariantClear 释放。 */
function hasAllowRule(policy: number, exePath: string, profiles: number): boolean {
    const rulesOut = new PtrArrayBuffer(SZ)
    const getRules = bindAt(vtable(policy, P2_RULES), '<>ptr <>ptr -> i32')
    if (FAILED(getRules(policy, rulesOut.ptr))) return false
    const rules = ffi.readPtr(rulesOut.ptr)
    if (!rules) return false
    try {
        const enumOut = new PtrArrayBuffer(SZ)
        const getNewEnum = bindAt(vtable(rules, RULES_NEW_ENUM), '<>ptr <>ptr -> i32')
        if (FAILED(getNewEnum(rules, enumOut.ptr))) return false
        const unknown = ffi.readPtr(enumOut.ptr)
        if (!unknown) return false
        try {
            const iter = queryInterface(unknown, Guid.IID_IENUMVARIANT)
            if (!iter) return false
            try {
                const next = bindAt(vtable(iter, SLOT_NEXT), '<>ptr u32 <>ptr <>ptr -> i32')
                const varBuf = new PtrArrayBuffer(VARIANT_SIZE)
                const fetched = new PtrArrayBuffer(4)
                for (;;) {
                    if (FAILED(next(iter, 1, varBuf.ptr, fetched.ptr))) return false
                    if (readI32(fetched.ptr) === 0) return false
                    const vt = new DataView(ffi.readBytes(varBuf.ptr, 2)).getUint16(0, true)
                    if (vt === VT_DISPATCH) {
                        const rule = ffi.readPtr(varBuf.ptr + 8)
                        if (rule && ruleMatches(rule, exePath, profiles)) return true
                    }
                    // VariantClear 按 vt 释放 pdispVal；不清会漏掉每个元素
                    VariantClear(varBuf.ptr)
                }
            } finally {
                release(iter)
            }
        } finally {
            release(unknown)
        }
    } finally {
        release(rules)
    }
}

function createPolicy(): number {
    const out = new PtrArrayBuffer(SZ)
    const hr = CoCreateInstance(
        guidFields(Guid.CLSID_NETFWPOLICY2),
        NULL,
        ClsCtx.INPROC_SERVER,
        guidFields(Guid.IID_INETFWPOLICY2),
        out.ptr,
    )
    if (FAILED(hr)) return 0
    return ffi.readPtr(out.ptr)
}

/**
 * 查询防火墙状态。只读，不需要管理员；XP 上 INetFwPolicy2 不可用 → checked=false。
 * @param exePath 本程序完整路径（与规则里的 ApplicationName 比对，大小写不敏感）
 */
export function queryFirewall(exePath: string): FirewallStatus {
    const st: FirewallStatus = { checked: false, firewallOn: false, currentProfiles: 0, allowed: false }
    // 调用方线程可能已按 MTA 初始化（此时 APARTMENTTHREADED 返回 RPC_E_CHANGED_MODE）；
    // 退一步用 MULTITHREADED（已初始化时返回 S_FALSE，也是成功态）。
    let hr = CoInitializeEx(NULL, CoInitFlag.APARTMENTTHREADED)
    if (FAILED(hr)) hr = CoInitializeEx(NULL, CoInitFlag.MULTITHREADED)
    if (FAILED(hr)) return st
    try {
        const policy = createPolicy()
        if (!policy) return st
        try {
            const pfOut = new PtrArrayBuffer(4)
            const getProfiles = bindAt(vtable(policy, P2_CURRENT_PROFILES), '<>ptr <>ptr -> i32')
            if (FAILED(getProfiles(policy, pfOut.ptr))) return st
            const profiles = readI32(pfOut.ptr)
            if (profiles === 0) return st

            const getOn = bindAt(vtable(policy, P2_FIREWALL_ENABLED), '<>ptr i32 <>ptr -> i32')
            let on = false
            for (const bit of [1, 2, 4]) {
                if ((profiles & bit) === 0) continue
                const enOut = new PtrArrayBuffer(2)
                if (FAILED(getOn(policy, bit, enOut.ptr))) continue
                if (readI16(enOut.ptr) === VARIANT_TRUE) {
                    on = true
                    break
                }
            }

            st.checked = true
            st.currentProfiles = profiles
            st.firewallOn = on
            st.allowed = on ? hasAllowRule(policy, exePath, profiles) : true
        } finally {
            release(policy)
        }
    } finally {
        CoUninitialize()
    }
    return st
}

/** 规则名：按 exe 完整路径派生（FNV-1a 32 位），保证不同程序各自一条、同一程序重跑幂等。
 *  固定名字会让 lanfile / deskmon 之类互相删规则。 */
function ruleNameFor(exePath: string): string {
    let h = 0x811c9dc5
    for (let i = 0; i < exePath.length; i++) {
        h ^= exePath.charCodeAt(i)
        h = Math.imul(h, 0x01000193) >>> 0
    }
    const base = exePath.replace(/^.*[\\/]/, '').replace(/[^A-Za-z0-9._-]/g, '') || 'app'
    return 'quickwin-app-' + base + '-' + h.toString(16)
}

/**
 * 加防火墙入站允许规则（弹 UAC，管理员确认后生效）。
 * 用 cmd 一次提权跑「先删同名旧规则、再加新规则」：exe 换路径后旧规则会残留，先删
 * 保证幂等；合成一条命令避免弹两次 UAC。窗口 SW_HIDE，用户只看到 UAC。
 * XP 无 advfirewall（netsh firewall），本函数不适用。
 * @returns ShellExecute 是否成功拉起（>32）；用户取消 UAC 的返回码不统一，调用方
 *          应在稍后重查 queryFirewall 确认
 */
export function allowApp(exePath: string, hwnd = 0): boolean {
    const program = exePath.replace(/"/g, '')
    const name = ruleNameFor(exePath)
    const params = '/c netsh advfirewall firewall delete rule name="' + name + '" >nul 2>&1'
        + ' & netsh advfirewall firewall add rule name="' + name + '" dir=in action=allow'
        + ' program="' + program + '" enable=yes profile=any'
    const rc = ShellExecute(hwnd, 'runas', 'cmd.exe', params, NULL, ShowWindowCmd.HIDE)
    return (rc as number) > 32
}
