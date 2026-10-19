/* FFI 纯 trampoline 基准用微型 DLL（一次性实验，见 bench_ffi_overhead / bench_nodeffi）。
 * nop0: 0 参 void 返回 —— 隔离 JS→C 往返开销（无参数封送、无返回值读取）。
 * nop1: 1 个 int 参数、int 返回 —— 单标量封送往返。
 * 编译（容器内）：x86_64-w64-mingw32-gcc -shared -O2 -o _build/test/nop.dll test/nop.c
 */
__declspec(dllexport) void nop0(void) {}
__declspec(dllexport) int nop1(int x) { return x + 1; }

/* 回调基准（bench_ffi_closure）：单次 JS→C 里以函数指针回调 cb 共 n 次 ——
 * 同一 helper 换「C 函数地板臂」与「closure().ptr 臂」，差值即闭包每次派发成本。
 * 返回值累加供正确性断言。ia32 下均为默认 cdecl（闭包须用 {stdcall:false} 配对）。 */
__declspec(dllexport) int call_void_ntimes(void (*cb)(void), int n) {
    for (int i = 0; i < n; i++) cb();
    return n;
}
__declspec(dllexport) int call_i32_ntimes(int (*cb)(int), int n) {
    int acc = 0;
    for (int i = 0; i < n; i++) acc += cb(i);
    return acc;
}
__declspec(dllexport) int four(int a, int b, int c, int d) { return a + b + c + d; }
__declspec(dllexport) int call_i32x4_ntimes(int (*cb)(int, int, int, int), int n) {
    int acc = 0;
    for (int i = 0; i < n; i++) acc += cb(i, i + 1, i + 2, i + 3);
    return acc;
}
__declspec(dllexport) double dadd(double x) { return x + 1.0; }
__declspec(dllexport) double call_f64_ntimes(double (*cb)(double), int n) {
    double acc = 0;
    for (int i = 0; i < n; i++) acc += cb((double)i);
    return acc;
}
