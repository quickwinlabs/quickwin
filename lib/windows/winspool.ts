// winspool.drv 绑定（打印后台处理：枚举 / 能力查询 / 原始作业链；品牌约定见
// lib/windows/user32.ts 头注释）：
//   - 打印机句柄（OpenPrinter 的 HPRINTER* 出参槽写回）位宽无关：出参槽 = <BYTE>ptr
//     收 PtrArrayBuffer(8) + readPtr 读回 number，作业链句柄位 <>ptr 收宽（批 5 HKey 同型）
//   - 结构位按方向分流（结构定义见 ./structs.ts）：DOC_INFO_1W 纯入参位注册 encoder →
//     对象直传；PRINTER_INFO_2W 出参数组不注册 → structArray(PRINTER_INFO_2W).decode
//     (buf, count) 读回（缓冲尾部含字符串，须显式 count），指针字段跟进读字符串
//   - 枚举标注：DeviceCap 是单选查询位标枚举；PrinterEnum 是 LOCAL|CONNECTIONS 可组合
//     flags → 裸 u32 + JSDoc（组合 OR 结果不是枚举成员，位标枚举反而传不进）
import { bind, type CodecMap } from '../ffi/bind.js'
import { DOC_INFO_1W } from './structs.js'

// dll 名部分应用（工厂转调保泛型 infer，见 lib/windows/user32.ts 头注释）
const b = <const S extends string, const LE extends CodecMap = {}>(name: string, sig: S, encoders?: LE) =>
    bind('winspool.drv', name, sig, encoders)

/** 枚举打印队列（Level=2 → PRINTER_INFO_2W 数组）；两段式：先
 *  NULL+cbBuf 0 拿 pcbNeeded，再按需分配缓冲重调
 *  @returns 成功 → 非 0
 *  @param args_0 dwFlags 枚举范围：gui.PrinterEnum.LOCAL(0x2) 本地 | CONNECTIONS(0x4)
 *                已连接，组合 OR 传裸数（可组合 flags 不标枚举）
 *  @param args_1 pName 服务器名（仅 Level=4/5/6 用），本地枚举传 NULL
 *  @param args_2 dwLevel 信息级别，取 2（PRINTER_INFO_2W）
 *  @param args_3 pPrinterInfo 出参缓冲（PtrArrayBuffer(pcbNeeded)）
 *  @param args_4 cbBuf 缓冲字节数
 *  @param args_5 pcbNeeded 出参槽（需求字节数）PtrArrayBuffer(4)
 *  @param args_6 pcReturned 出参槽（返回条数）PtrArrayBuffer(4) */
export const EnumPrinters = /*@__PURE__*/ b('EnumPrintersW',
    'u32 <WCHAR>ptr u32 <BYTE>ptr u32 <BYTE>ptr <BYTE>ptr -> i32')

/** 取默认打印机名
 *  @returns 成功 → 非 0，0 = 失败（缓冲不足时 pcchBuffer 带回所需长度）
 *  @param args_0 pszBuffer 出参缓冲，WCHAR.alloc(n)、WCHAR.decode 读回
 *  @param args_1 pcchBuffer 出入长度槽（入 = 缓冲 WCHAR 容量，出 = 实际长度），PtrArrayBuffer(4) */
export const GetDefaultPrinter = /*@__PURE__*/ b('GetDefaultPrinterW', '<BYTE>ptr <BYTE>ptr -> i32')

/** 查设备能力；nCapability 单选 gui.DeviceCap.*
 *  @returns 返回值随能力（数值能力 = 数值，
 *  -1 = 失败）
 *  @param args_0 pDevice 打印机名（禁空）
 *  @param args_1 pPort 端口名，传 NULL 用打印机配置端口
 *  @param args_2 nCapability 能力码（gui.DeviceCap.HORZRES 等单选）
 *  @param args_3 pOutput 字符串列表型能力的缓冲；数值型查询传 NULL
 *  @param args_4 pDevmode DEVMODE，传 NULL */
export const DeviceCapabilities = /*@__PURE__*/ b('DeviceCapabilitiesW',
    '<WCHAR>ptr! <WCHAR>ptr u32@DeviceCap <BYTE>ptr <>ptr -> i32')

/** 打开打印机对象（不产生打印作业）
 *  @returns 成功 → 非 0，hPrinter 写回
 *  @param args_0 pPrinterName 打印机名（禁空）
 *  @param args_1 phPrinter 出参槽（句柄写回），PtrArrayBuffer(8) + readPtr 读回
 *  @param args_2 pDefault 默认值（Datatype/DevMode/DesiredAccess），传 NULL 全默认 */
export const OpenPrinter = /*@__PURE__*/ b('OpenPrinterW', '<WCHAR>ptr! <BYTE>ptr <>ptr -> i32')
/** 关闭打印机句柄
 *  @returns 成功 → 非 0 */
export const ClosePrinter = /*@__PURE__*/ b('ClosePrinter', '<>ptr -> i32')
/** 起打印作业
 *  @returns 作业 id（0 = 失败）
 *  @param args_0 hPrinter 打印机句柄
 *  @param args_1 dwLevel 固定 1（DOC_INFO_1W）
 *  @param args_2 pDocInfo DOC_INFO_1W 对象（指针字段收裸地址 number：WCHAR.encode(s).ptr，
 *                PAB 须在调用返回前保持引用） */
export const StartDocPrinter = /*@__PURE__*/ b('StartDocPrinterW', '<>ptr u32 <DOC_INFO_1W>ptr -> u32',
    { DOC_INFO_1W })
/** 结束打印作业（提交）
 *  @returns 成功 → 非 0 */
export const EndDocPrinter = /*@__PURE__*/ b('EndDocPrinter', '<>ptr -> i32')
/** 起页
 *  @returns 成功 → 非 0 */
export const StartPagePrinter = /*@__PURE__*/ b('StartPagePrinter', '<>ptr -> i32')
/** 结束页
 *  @returns 成功 → 非 0 */
export const EndPagePrinter = /*@__PURE__*/ b('EndPagePrinter', '<>ptr -> i32')
/** 写作业数据（RAW 直写 spooler）
 *  @returns 成功 → 非 0
 *  @param args_0 hPrinter 打印机句柄
 *  @param args_1 lpBuffer 数据缓冲（<BYTE>ptr，PtrArrayBuffer）
 *  @param args_2 nNumberOfBytesToWrite 写入字节数
 *  @param args_3 lpNumberOfBytesWritten 出参槽，PtrArrayBuffer(4) 读实际写入字节数 */
export const WritePrinter = /*@__PURE__*/ b('WritePrinter', '<>ptr <BYTE>ptr u32 <BYTE>ptr -> i32')
