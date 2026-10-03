#ifndef QUICKJS_FFI_TYPE_H
#define QUICKJS_FFI_TYPE_H

/* 本文件已不参与编译（quickjs-ffi.c 不再 include 它），仅作 ABI 文档参照：
   FFI_TYPE_* 的数值与 qwin_ffi_arg_size[] 的槽宽规则是 JS↔汇编桩之间的契约，
   lib/ffi/bind.ts 的 ARG_SIZE 表必须与之逐值一致。改动任一侧都会导致传参
   静默错位。原始数值来源见下。 */

/* FFI_TYPE_* 的数值来自 libffi 的 ffi.h.in:60-81（其值来自生成的
   ffi.h:60-82）。libffi 已不参与构建（REMOVE_LIBFFI_PLAN.md S6），
   ffi.h 不再生成，此处的数值必须以 deps/libffi/include/ffi.h.in 为准，
   不可凭记忆改写。 */
#define FFI_TYPE_VOID 0
#define FFI_TYPE_INT 1
#define FFI_TYPE_FLOAT 2
#define FFI_TYPE_DOUBLE 3
/* libffi 的 ffi.h.in 里此处是 #if @HAVE_LONG_DOUBLE@ 分支，mingw 交叉构建实测
   取 HAVE_LONG_DOUBLE=1（见 _build/deps 下各变体 libffi-build/include/ffi.h:63-67），
   故值为 4 而非 FFI_TYPE_DOUBLE。切勿「简化」成 = FFI_TYPE_DOUBLE。 */
#define FFI_TYPE_LONGDOUBLE 4
#define FFI_TYPE_UINT8 5
#define FFI_TYPE_SINT8 6
#define FFI_TYPE_UINT16 7
#define FFI_TYPE_SINT16 8
#define FFI_TYPE_UINT32 9
#define FFI_TYPE_SINT32 10
#define FFI_TYPE_UINT64 11
#define FFI_TYPE_SINT64 12
#define FFI_TYPE_STRUCT 13
#define FFI_TYPE_POINTER 14
#define FFI_TYPE_COMPLEX 15

#define FFI_TYPE_LAST FFI_TYPE_COMPLEX

/* 每类型在调用栈上占用的字节数（Win32 cdecl / Win64）。
   下标 = FFI_TYPE_*，值 0 表示本实现不支持该类型（VOID 除外，VOID 参数本就非法）。
   依据 deps/libffi/src/x86/ffi.c:341-402 的写入侧分支：
     - z <= FFI_SIZEOF_ARG(4) 且非 struct → 推进 4 字节（ffi.c:365）
     - 否则 za = ALIGN(z, 4)               → 推进 8 字节（ffi.c:367,392）
   即真实布局是「每参数 4 或 8 字节的简单求和，无填充」。libffi 算 cif->bytes 时
   用 t->alignment(8) 对 double 补过齐（ffi.c:191），但那只影响 alloca 估算，
   写入时 align 恒为 FFI_SIZEOF_ARG（ffi.c:367,390），所以勿照抄那套对齐累加。 */
static const unsigned char qwin_ffi_arg_size[FFI_TYPE_LAST + 1] = {
    /* VOID       */ 0,
    /* INT        */ 0,
    /* FLOAT      */ 4,
    /* DOUBLE     */ 8,
    /* LONGDOUBLE */ 0,
    /* UINT8      */ 4,
    /* SINT8      */ 4,
    /* UINT16     */ 4,
    /* SINT16     */ 4,
    /* UINT32     */ 4,
    /* SINT32     */ 4,
    /* UINT64     */ 8,
    /* SINT64     */ 8,
    /* STRUCT     */ 0,
    /* POINTER    */ (unsigned char)sizeof(void *),
    /* COMPLEX    */ 0,
};

#endif