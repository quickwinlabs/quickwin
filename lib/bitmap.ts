// 按像素建位图 —— gui 模块下沉到 JS 层的复合逻辑（原 js_createBitmapFromPixels）。
// 旧 C 体是 CreateDIBSection + memcpy 直写位数据；FFI 侧没有「JS 缓冲 → 原生地址」的
// 批量写原语（ffi 只导出 readBytes / writeByte，逐字节循环不值当），改用 GDI 自带的
// SetDIBits 把调用方缓冲装进 DIB 段：ColorUse.RGB_COLORS 下 hdc 被忽略（MSDN：
// "used only if the DIB_PAL_COLORS constant is set ... otherwise it is ignored"），
// 双机实测传 NULL 可用、GetDIBits 读回逐字节一致（含 alpha），与旧 C 的 memcpy 等价。
import { NULL, PtrArrayBuffer, type MaybePtr } from './ffi/ctype.js'
import { CreateDIBSection, DeleteObject, SetDIBits } from './windows/gdi32.js'
import { BITMAPINFOHEADER } from './windows/structs.js'
import { ColorUse } from '../constants'

/** 建 32bpp 自顶向下 DIB 段位图（像素为 BGRA，[B,G,R,A] 字节序，alpha 保留 —— 可喂
 *  ImageListAdd(ILC_COLOR32) 等）。width/height ≤ 0 或像素缓冲不足 width*height*4 →
 *  NULL（同旧 gui.CreateBitmapFromPixels 语义：非法入参静默返空，由调用方按「无图」处理）；
 *  GDI 失败同样返 NULL（已建的位图当场回收）。
 *  位图归调用方所有：用完 DeleteObject。 */
export function createBitmapFromPixels(width: number, height: number, pixels: ArrayBuffer): MaybePtr<'HGDIOBJ'> {
    if (width <= 0 || height <= 0) return NULL
    const len = width * height * 4
    if (pixels.byteLength < len) return NULL
    // 32bpp BI_RGB：头部即全部（无颜色表）；负 biHeight = 自顶向下，与 JS 缓冲行序一致
    const bi = BITMAPINFOHEADER.encode({
        biSize: BITMAPINFOHEADER.size,
        biWidth: width,
        biHeight: -height,
        biPlanes: 1,
        biBitCount: 32,
    })
    const hbm = CreateDIBSection(NULL, bi.ptr, ColorUse.RGB_COLORS, NULL, NULL, 0)
    if (!hbm) return NULL
    // 像素先落自有原生缓冲（BYTE.encode 需带 .ptr 的缓冲），再让 GDI 装进 DIB 段
    const src = new PtrArrayBuffer<'BYTE'>(len)
    new Uint8Array(src).set(new Uint8Array(pixels, 0, len))
    if (SetDIBits(NULL, hbm, 0, height, src, bi.ptr, ColorUse.RGB_COLORS) !== height) {
        DeleteObject(hbm)
        return NULL
    }
    return hbm
}
