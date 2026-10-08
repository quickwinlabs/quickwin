/* FFI 纯 trampoline 基准用微型 DLL（一次性实验，见 bench_ffi_overhead / bench_nodeffi）。
 * nop0: 0 参 void 返回 —— 隔离 JS→C 往返开销（无参数封送、无返回值读取）。
 * nop1: 1 个 int 参数、int 返回 —— 单标量封送往返。
 * 编译（容器内）：x86_64-w64-mingw32-gcc -shared -O2 -o _build/test/nop.dll test/nop.c
 */
__declspec(dllexport) void nop0(void) {}
__declspec(dllexport) int nop1(int x) { return x + 1; }
