import * as os from 'os'
import * as ffi from 'ffi'
import { struct } from '../ffi-struct.js'

// 架构相关常量：32 位(ia32)/64 位(x64) Windows ABI
export const IS64 = os.arch === 'x64'
export const PTR_SIZE = IS64 ? 8 : 4

// NMHDR = hwndFrom(ptr) + idFrom(ptr) + code(i32)。
// 用 ffi-struct 定义以复现 MSVC/嵌套结构的“尾 padding 传染”（内嵌 NMHDR 占满 24/12 字节）。
export const NMHDR = struct({ hwndFrom: 'ptr', idFrom: 'ptr', code: 'i32' })
export const NMHDR_SIZE = NMHDR.size // 24 (x64) / 12 (ia32)
export const NMHDR_CODE = NMHDR.offsetOf('code') // 16 / 8

export function readI32At(ptr: number, offset: number): number {
  return ffi.readByte(ptr + offset) | (ffi.readByte(ptr + offset + 1) << 8) |
    (ffi.readByte(ptr + offset + 2) << 16) | (ffi.readByte(ptr + offset + 3) << 24)
}

export function readU32At(ptr: number, offset: number): number {
  return ffi.readByte(ptr + offset) | (ffi.readByte(ptr + offset + 1) << 8) |
    (ffi.readByte(ptr + offset + 2) << 16) | (ffi.readByte(ptr + offset + 3) << 24) >>> 0
}

export function readU16At(ptr: number, offset: number): number {
  return ffi.readByte(ptr + offset) | (ffi.readByte(ptr + offset + 1) << 8)
}

// 读 NMHDR.code（WM_NOTIFY 通知码）
export function nmCode(lParam: number): number {
  return readI32At(lParam, NMHDR_CODE)
}