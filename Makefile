CC = gcc
WINDRES = windres

DEBUG = 0
GC_DEBUG = 0
MINIMAL = 0
OPT = -Os
BUILD_DIR = _build
MSYS2_PREFIX ?= C:/msys64/ucrt64

ifeq ($(DEBUG), 1)
    CFLAGS = -I./quickjs -I$(MSYS2_PREFIX)/include -g -O0 -DDEBUG
else
    CFLAGS = -I./quickjs -I$(MSYS2_PREFIX)/include -DNDEBUG
endif

ifeq ($(GC_DEBUG), 1)
    CFLAGS += -DDUMP_GC -DDUMP_GC_FREE -DDUMP_LEAKS
endif

CFLAGS += -Wall -Wextra

ifeq ($(MINIMAL), 1)
    CFLAGS += $(OPT) -flto -fdata-sections -ffunction-sections
    LDFLAGS += -flto -Wl,--gc-sections
endif

WAMR_DIR = wamr
WAMR_CORE = $(WAMR_DIR)/core/iwasm
WAMR_INC = -I$(WAMR_CORE)/include
WAMR_INC += -I$(WAMR_DIR)/core/shared/platform/windows
WAMR_INC += -I$(WAMR_DIR)/core/iwasm/interpreter
WAMR_INC += -I$(WAMR_DIR)/core/iwasm/common
WAMR_INC += -I$(WAMR_DIR)/core/shared/utils
WAMR_INC += -I$(WAMR_DIR)/core/shared/platform/include
WAMR_DEFS = \
    -DWASM_ENABLE_FAST_INTERP=1 \
    -DWASM_ENABLE_BULK_MEMORY=1 \
    -DWASM_ENABLE_BULK_MEMORY_OPT=1 \
    -DWASM_ENABLE_SHRUNK_MEMORY=1 \
    -DWASM_ENABLE_SHARED_MEMORY=0 \
    -DWASM_ENABLE_MULTI_MODULE=0 \
    -DWASM_ENABLE_MINI_LOADER=0 \
    -DWASM_ENABLE_EXTENDED_CONST_EXPR=0 \
    -DWASM_ENABLE_CALL_INDIRECT_OVERLONG=0 \
    -DWASM_DISABLE_HW_BOUND_CHECK=1 \
    -DWASM_DISABLE_STACK_HW_BOUND_CHECK=1 \
    -DWASM_ENABLE_QUICK_AOT_ENTRY=0 \
    -DWASM_ENABLE_AOT_INTRINSICS=0 \
    -DWASM_ENABLE_TAGS=0 \
    -DWASM_ENABLE_EXCE_HANDLING=0

WAMR_BUILD_DIR = $(WAMR_DIR)/build
WAMR_LIB = $(WAMR_DIR)/lib/libiwasm.a

WAT_SRCS = $(wildcard test/*.wat)
WASM_OBJS = $(WAT_SRCS:test/%.wat=$(BUILD_DIR)/test/%.wasm)

CFLAGS += $(WAMR_INC)
CFLAGS += $(WAMR_DEFS)

LDFLAGS = -L$(MSYS2_PREFIX)/lib -static
LIBS = -lzstd -lwolfssl -lws2_32 -lbcrypt -lcrypt32 -lm -luser32 -lgdi32 -lcomctl32 -lffi -lntdll -lshell32

TARGET = $(BUILD_DIR)/win.exe
QUICKJS_LIB = $(BUILD_DIR)/libquickjs.a

SRCS = main.c \
       quickjs-win.c \
       quickjs-gui.c \
       quickjs-ffi.c \
       quickjs-zstd.c \
       quickjs-sock.c \
       quickjs-wolfssl.c \
       quickjs-http.c \
       quickjs-libc.c \
       quickjs-wamr.c \
       quickjs-async-task.c

OBJS = $(SRCS:%.c=$(BUILD_DIR)/%.o) $(BUILD_DIR)/app.o
DEPS = $(SRCS:%.c=$(BUILD_DIR)/%.d)

.PHONY: all clean debug nodebug release minimal test wamr wasm gc-debug js info help

all: nodebug

debug:
	@$(MAKE) DEBUG=1

gc-debug:
	@$(MAKE) DEBUG=1 GC_DEBUG=1

nodebug: $(QUICKJS_LIB) $(TARGET)

release:
	rm -f $(OBJS) $(DEPS) $(TARGET) $(QUICKJS_LIB)
	@$(MAKE) OPT=-O2 MINIMAL=1 nodebug
	@echo "Build complete: $(TARGET) (-O2, LTO, stripped)"

minimal:
	rm -f $(OBJS) $(DEPS) $(TARGET) $(QUICKJS_LIB)
	@$(MAKE) OPT=-Os MINIMAL=1 nodebug
	@echo "Build complete: $(TARGET) (-Os, LTO, stripped)"

QJ_DEFINES = -D_GNU_SOURCE -DCONFIG_WIN32 -DCONFIG_VERSION=\"2025-09-13\"

$(QUICKJS_LIB):
	@echo "Building QuickJS library..."
	mkdir -p $(BUILD_DIR)/quickjs
	$(CC) $(CFLAGS) $(QJ_DEFINES) -c -o $(BUILD_DIR)/quickjs/quickjs.nolto.o quickjs/quickjs.c
	$(CC) $(CFLAGS) $(QJ_DEFINES) -c -o $(BUILD_DIR)/quickjs/dtoa.nolto.o quickjs/dtoa.c
	$(CC) $(CFLAGS) $(QJ_DEFINES) -c -o $(BUILD_DIR)/quickjs/libregexp.nolto.o quickjs/libregexp.c
	$(CC) $(CFLAGS) $(QJ_DEFINES) -c -o $(BUILD_DIR)/quickjs/libunicode.nolto.o quickjs/libunicode.c
	$(CC) $(CFLAGS) $(QJ_DEFINES) -c -o $(BUILD_DIR)/quickjs/cutils.nolto.o quickjs/cutils.c
	$(CC) $(CFLAGS) $(QJ_DEFINES) -c -o $(BUILD_DIR)/quickjs/quickjs-libc.nolto.o quickjs/quickjs-libc.c
	ar rcs $@ $(BUILD_DIR)/quickjs/*.nolto.o
	@echo "QuickJS library built"

$(TARGET): $(OBJS) $(QUICKJS_LIB) $(WAMR_LIB)
	@echo "Linking $@..."
	mkdir -p $(BUILD_DIR)
	$(CC) -o $@ $(OBJS) $(QUICKJS_LIB) $(WAMR_LIB) $(LDFLAGS) $(LIBS)
ifeq ($(MINIMAL), 1)
	strip $@
endif
	@echo "Build complete: $@"

$(BUILD_DIR)/%.o: %.c
	@echo "Compiling $<..."
	mkdir -p $(BUILD_DIR)
	$(CC) $(CFLAGS) -c -o $@ $<

$(BUILD_DIR)/%.d: %.c
	@mkdir -p $(BUILD_DIR)
	$(CC) $(CFLAGS) -MM -MT '$(BUILD_DIR)/$*.o' $< > $@

$(BUILD_DIR)/app.o: app.rc
	@echo "Compiling resource $<..."
	mkdir -p $(BUILD_DIR)
	$(WINDRES) $< -o $@

ifneq ($(MAKECMDGOALS),clean)
ifneq ($(MAKECMDGOALS),distclean)
    -include $(DEPS)
endif
endif

clean:
	@echo "Cleaning..."
	rm -rf $(BUILD_DIR)
	@echo "Clean complete"

distclean: clean

wamr:
	@echo "Building WAMR..."
	@if [ ! -d "$(WAMR_DIR)" ]; then \
		echo "Error: wamr directory not found. Run: git submodule update --init"; \
		exit 1; \
	fi
	@mkdir -p $(WAMR_BUILD_DIR)
	cd $(WAMR_DIR) && cmake -B build \
		-DWAMR_BUILD_PLATFORM=windows \
		-DWAMR_BUILD_TARGET=X86_64 \
		-DWAMR_BUILD_INTERP=1 \
		-DWAMR_BUILD_FAST_INTERP=1 \
		-DWAMR_BUILD_AOT=0 \
		-DWAMR_BUILD_JIT=0 \
		-DWAMR_BUILD_LIBC_BUILTIN=1 \
		-DWAMR_BUILD_LIBC_WASI=0 \
		-DWAMR_BUILD_MULTI_MODULE=0 \
		-DWAMR_BUILD_THREAD_MGR=0 \
		-DWAMR_BUILD_REF_TYPES=0 \
		-DWAMR_BUILD_GC=0 \
		-DWAMR_BUILD_SIMD=0 \
		-DWAMR_BUILD_LOG=0 \
		-DWAMR_DISABLE_HW_BOUND_CHECK=1 \
		-DWAMR_BUILD_INVOKE_NATIVE_GENERAL=1 \
		-DWAMR_BUILD_EXCE_HANDLING=0 \
		-DCMAKE_BUILD_TYPE=Release
	cmake --build $(WAMR_BUILD_DIR) --config Release
	@mkdir -p $(WAMR_DIR)/lib
	cp $(WAMR_BUILD_DIR)/libiwasm.a $(WAMR_LIB)
	@echo "WAMR build complete"

wasm: $(WASM_OBJS)

$(BUILD_DIR)/test/%.wasm: test/%.wat
	@echo "  $< -> $@"
	mkdir -p $(BUILD_DIR)/test
	wat2wasm $< -o $@

info:
	@echo "Build Configuration:"
	@echo "  CC        = $(CC)"
	@echo "  CFLAGS    = $(CFLAGS)"
	@echo "  LDFLAGS   = $(LDFLAGS)"
	@echo "  LIBS      = $(LIBS)"
	@echo "  TARGET    = $(TARGET)"
	@echo "  BUILD_DIR = $(BUILD_DIR)"
	@echo "  DEBUG     = $(DEBUG)"

js:
	@echo "Compiling TypeScript files to JavaScript using tsgo..."
	@npx tsgo --project tsconfig.json
	@echo "Copying vendor/mupdf-wasm to $(BUILD_DIR)/vendor/mupdf-wasm..."
	@mkdir -p $(BUILD_DIR)/vendor && cp -r vendor/mupdf-wasm $(BUILD_DIR)/vendor/mupdf-wasm
	@echo "TypeScript compilation complete"

test: nodebug js wasm
	$(TARGET) $(BUILD_DIR)/test/run.js $(TEST)

help:
	@echo "Available targets:"
	@echo "  all       - Build nodebug version (default)"
	@echo "  nodebug   - Build without optimization (fast compile)"
	@echo "  release   - Build with -O2 + LTO + stripped (~2.5MB)"
	@echo "  minimal   - Build with -Os + LTO + stripped (~2.1MB)"
	@echo "  debug     - Build debug version (-g -O0)"
	@echo "  clean     - Remove built files and JS files"
	@echo "  distclean - Remove all generated files"
	@echo "  info      - Show build configuration"
	@echo "  js        - Compile TypeScript files to JavaScript"
	@echo "  test      - Run all suites: make test"
	@echo "  test      - Filter by name: make test TEST=wasm"
	@echo "  test      - Exclude by tag: make test TEST=-net"
	@echo "  wasm      - Convert WAT files to WASM (requires wabt)"
	@echo "  help      - Show this help message"
