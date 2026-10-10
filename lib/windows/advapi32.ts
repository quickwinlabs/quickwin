// advapi32 绑定（注册表 API；键名/值名一律 W 版 UTF-16）
import { bind } from '../ffi/bind.js'

// dll 名部分应用（工厂转调保泛型 infer，见 lib/windows/user32.ts 头注释）
const b = <const S extends string>(name: string, sig: S) => bind('advapi32.dll', name, sig)

/** 创建/打开子键（子键不存在则创建，含中间层级）
 *  @returns 0 = ERROR_SUCCESS
 *  @param args_0 hKey 父键：gui.HKey.CURRENT_USER / LOCAL_MACHINE 预定义键，或本族
 *                Open/Create 返回的真实句柄（此位双来源，不标 @HKey——裸位收两种）
 *  @param args_1 lpSubKey 子键路径（'Software\\X\\Y'，可 NULL = 打开 hKey 自身副本）
 *  @param args_2 Reserved 保留，恒 0
 *  @param args_3 lpClass 键类名（一般 NULL）
 *  @param args_4 dwOptions 保留属性（恒 0）
 *  @param args_5 samDesired 访问掩码 gui.RegAccess.READ / SET_VALUE（标准组合常量按成员收录）
 *  @param args_6 lpSecurityAttributes 安全描述符（一般 NULL）
 *  @param args_7 phkResult 出参：键句柄（PtrArrayBuffer(8)，readPtr 按架构读回）
 *  @param args_8 lpdwDisposition 出参：新建/已存在标记（可 NULL） */
export const RegCreateKeyEx = /*@__PURE__*/ b('RegCreateKeyExW',
    '<>ptr <WCHAR>ptr u32 <WCHAR>ptr u32 u32@RegAccess <>ptr <BYTE>ptr <BYTE>ptr -> i32')

/** 打开已有子键（不创建）
 *  @returns 0 = ERROR_SUCCESS；2 = ERROR_FILE_NOT_FOUND（子键不存在）
 *  @param args_0 hKey 父键（同 RegCreateKeyEx 的双来源语义）
 *  @param args_1 lpSubKey 子键路径（NULL = 打开 hKey 自身副本）
 *  @param args_2 ulOptions 保留，恒 0
 *  @param args_3 samDesired 访问掩码 gui.RegAccess.READ / SET_VALUE
 *  @param args_4 phkResult 出参：键句柄 */
export const RegOpenKeyEx = /*@__PURE__*/ b('RegOpenKeyExW',
    '<>ptr <WCHAR>ptr u32 u32@RegAccess <BYTE>ptr -> i32')

/** 关闭键句柄；只关 Open/Create 返回的真实句柄——预定义键（HKEY_CURRENT_USER 等）
 *  不要关
 *  @returns 0 = ERROR_SUCCESS */
export const RegCloseKey = /*@__PURE__*/ b('RegCloseKey', '<>ptr -> i32')

/** 写键值
 *  @returns 0 = ERROR_SUCCESS
 *  @param args_0 hKey 键句柄（须 KEY_SET_VALUE 权限，含于 gui.RegAccess.SET_VALUE）
 *  @param args_1 lpValueName 值名（NULL = 键的默认值）
 *  @param args_2 Reserved 保留，恒 0
 *  @param args_3 dwType 值类型 gui.RegType.SZ（UTF-16 字符串）
 *  @param args_4 lpData 数据缓冲（REG_SZ：UTF-16LE 含结尾 NUL）
 *  @param args_5 cbData 数据字节数（REG_SZ = (字符数+1)*2） */
export const RegSetValueEx = /*@__PURE__*/ b('RegSetValueExW',
    '<>ptr <WCHAR>ptr u32 u32@RegType <BYTE>ptr u32 -> i32')

/** 读键值（两跳模式：第一跳 lpData=NULL 取尺寸/类型，第二跳按尺寸带缓冲读数据）
 *  @returns 0 = ERROR_SUCCESS；2 = ERROR_FILE_NOT_FOUND（值不存在）
 *  @param args_0 hKey 键句柄（须 KEY_QUERY_VALUE 权限，含于 gui.RegAccess.READ）
 *  @param args_1 lpValueName 值名（NULL = 键的默认值）
 *  @param args_2 lpReserved 保留，恒 NULL
 *  @param args_3 lpType 出参：值类型（可 NULL）
 *  @param args_4 lpData 数据缓冲（可 NULL = 只查尺寸）
 *  @param args_5 lpcbData 双向：入 = lpData 缓冲字节数（须预写）、出 = 实际字节数 */
export const RegQueryValueEx = /*@__PURE__*/ b('RegQueryValueExW',
    '<>ptr <WCHAR>ptr <>ptr <BYTE>ptr <BYTE>ptr <BYTE>ptr -> i32')

/** 删除子键（连值一起删）；须父键 KEY_CREATE_SUB_KEY 权限——自己的 HKCU 直接传
 *  gui.HKey.CURRENT_USER 即可
 *  @returns 0 = ERROR_SUCCESS；2 = 子键不存在
 *  @param args_0 hKey 父键
 *  @param args_1 lpSubKey 要删的子键路径（不可 NULL） */
export const RegDeleteKey = /*@__PURE__*/ b('RegDeleteKeyW', '<>ptr <WCHAR>ptr -> i32')
