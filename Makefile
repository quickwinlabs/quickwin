CC = gcc
WINDRES = windres

DEBUG = 0
MINIMAL = 0
OPT = -Os
BUILD_DIR = _build
MSYS2_PREFIX ?= C:/msys64/ucrt64
JS_EMBED ?= embed.js

ifeq ($(DEBUG), 1)
    CFLAGS = -I./quickjs -I$(MSYS2_PREFIX)/include -g -O0 -DDEBUG
else
    CFLAGS = -I./quickjs -I$(MSYS2_PREFIX)/include -DNDEBUG
endif

CFLAGS += -DDUMP_GC -DDUMP_LEAKS
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

WOLFSSL_DIR = wolfssl
WOLFSSL_INC = -I$(WOLFSSL_DIR) -I$(WOLFSSL_BUILD_DIR)
WOLFSSL_BUILD_DIR = $(WOLFSSL_DIR)/build
WOLFSSL_LIB_STATIC = $(WOLFSSL_DIR)/lib/libwolfssl.a
WOLFSSL_LIB ?= $(WOLFSSL_LIB_STATIC)

WAT_SRCS = $(wildcard test/*.wat)
WASM_OBJS = $(WAT_SRCS:test/%.wat=$(BUILD_DIR)/test/%.wasm)

CFLAGS += $(WAMR_INC)
CFLAGS += $(WAMR_DEFS)
CFLAGS += $(WOLFSSL_INC)

LDFLAGS = -L$(MSYS2_PREFIX)/lib -static
LIBS = -lbrotlidec -lbrotlicommon $(WOLFSSL_LIB) -lws2_32 -lbcrypt -lcrypt32 -lm -luser32 -lgdi32 -lcomctl32 -lffi -lntdll -lshell32 -lwininet

TARGET = $(BUILD_DIR)/win.exe
NPM_PKG_DIR = dist/quickwin
QUICKJS_LIB = $(BUILD_DIR)/libquickjs.a

SRCS = main.c \
       quickjs-win.c \
       quickjs-gui.c \
       quickjs-ffi.c \
       quickjs-brotli.c \
       quickjs-sock.c \
       quickjs-wolfssl.c \
       quickjs-http.c \
       quickjs-libc.c \
       quickjs-wamr.c \
       quickjs-async-task.c

OBJS = $(SRCS:%.c=$(BUILD_DIR)/%.o) $(BUILD_DIR)/app.o
DEPS = $(SRCS:%.c=$(BUILD_DIR)/%.d)

.PHONY: all clean debug nodebug release small minimal wolfsmin test wamr wasm js npm-pkg embed-js info help

all: nodebug

debug:
	@$(MAKE) DEBUG=1

nodebug: $(QUICKJS_LIB) $(TARGET)

release:
	rm -f $(OBJS) $(DEPS) $(TARGET) $(QUICKJS_LIB)
	@$(MAKE) OPT=-O2 MINIMAL=1 nodebug
	@echo "Build complete: $(TARGET) (-O2, LTO, stripped)"

small:
	rm -f $(OBJS) $(DEPS) $(TARGET) $(QUICKJS_LIB)
	@$(MAKE) OPT=-Os MINIMAL=1 nodebug
	@echo "Build complete: $(TARGET) (-Os, LTO, stripped)"

minimal:
	rm -f $(OBJS) $(DEPS) $(TARGET) $(QUICKJS_LIB)
	@$(MAKE) OPT=-Os MINIMAL=1 nodebug
	@if command -v upx >/dev/null 2>&1; then upx --best $(TARGET); fi
	@echo "Build complete: $(TARGET) (-Os, LTO, stripped, UPXed)"



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

$(WOLFSSL_LIB_STATIC): wolfsmin

$(TARGET): $(OBJS) $(QUICKJS_LIB) $(WAMR_LIB) $(WOLFSSL_LIB_STATIC)
	@echo "Linking $@..."
	mkdir -p $(BUILD_DIR)
	$(CC) -o $@ $(OBJS) $(QUICKJS_LIB) $(WAMR_LIB) $(LDFLAGS) $(LIBS)
ifeq ($(MINIMAL), 1)
	strip $@
endif
	@echo "Build complete: $@"

$(BUILD_DIR)/%.o: %.c | $(WOLFSSL_LIB_STATIC)
	@echo "Compiling $<..."
	mkdir -p $(BUILD_DIR)
	$(CC) $(CFLAGS) -c -o $@ $<

$(BUILD_DIR)/%.d: %.c
	@mkdir -p $(BUILD_DIR)
	$(CC) $(CFLAGS) -MM -MT '$(BUILD_DIR)/$*.o' $< > $@

$(BUILD_DIR)/app.o: app.rc | $(WOLFSSL_LIB_STATIC)
	@echo "Compiling resource $<..."
	mkdir -p $(BUILD_DIR)
	$(WINDRES) $< -o $@

ifeq ($(MAKECMDGOALS),)
-include $(DEPS)
else
BUILD_GOALS := $(filter-out js wasm npm-pkg info help clean distclean, $(MAKECMDGOALS))
ifneq ($(BUILD_GOALS),)
-include $(DEPS)
endif
endif

clean:
	@echo "Cleaning..."
	rm -rf $(BUILD_DIR)
	rm -f tools/gen_const.exe
	@echo "Clean complete"

distclean: clean


const: tools/gen_const.exe
	tools/gen_const.exe > quickwin_const.d.ts

tools/gen_const.exe: tools/gen_const.c
	$(CC) -o $@ $<

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
		-DWAMR_BUILD_AOT=1 \
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

wolfsmin:
	@echo "Building minimal wolfSSL..."
	if [ ! -f "$(WOLFSSL_DIR)/README.md" ]; then git submodule update --init --depth 1 $(WOLFSSL_DIR); fi
	@mkdir -p $(WOLFSSL_BUILD_DIR) $(WOLFSSL_DIR)/lib
	cd $(WOLFSSL_DIR) && cmake -B build \
		-DCMAKE_BUILD_TYPE=Release \
		-DCMAKE_C_FLAGS_RELEASE="-Os" \
		-DBUILD_SHARED_LIBS=OFF \
		-DWOLFSSL_TLS13=OFF \
		-DWOLFSSL_MLKEM=OFF \
		-DWOLFSSL_PQC_HYBRIDS=OFF \
		-DWOLFSSL_CHACHA=OFF \
		-DWOLFSSL_POLY1305=OFF \
		-DWOLFSSL_CURVE25519=OFF \
		-DWOLFSSL_ED25519=OFF \
		-DWOLFSSL_CURVE448=OFF \
		-DWOLFSSL_ED448=OFF \
		-DWOLFSSL_DH=OFF \
		-DWOLFSSL_OLD_TLS=OFF \
		-DWOLFSSL_SHA3=OFF \
		-DWOLFSSL_SHAKE128=OFF \
		-DWOLFSSL_SHAKE256=OFF \
		-DWOLFSSL_SHA224=OFF \
		-DWOLFSSL_SHA512=OFF \
		-DWOLFSSL_SESSION_TICKET=OFF \
		-DWOLFSSL_HARDEN=OFF \
		-DWOLFSSL_HKDF=OFF \
		-DWOLFSSL_EXAMPLES=OFF \
		-DWOLFSSL_CRYPT_TESTS=OFF \
		-DWOLFSSL_PKCS12=OFF \
		-DWOLFSSL_DH_DEFAULT_PARAMS=OFF \
		-DWOLFSSL_SNI=ON \
		-DWOLFSSL_TLSX=ON \
		-DWOLFSSL_BASE64_ENCODE=ON \
		-DWOLFSSL_SUPPORTED_CURVES=ON
	cmake --build $(WOLFSSL_BUILD_DIR) --config Release
	cp $(WOLFSSL_BUILD_DIR)/libwolfssl.a $(WOLFSSL_LIB_STATIC)
	@echo "Minimal wolfSSL build complete"

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
	@echo "Bundling react entries with esbuild..."
	@node build.ts
	@echo "Copying vendor/mupdf-wasm to $(BUILD_DIR)/vendor/mupdf-wasm..."
	@rm -rf $(BUILD_DIR)/vendor/mupdf-wasm && mkdir -p $(BUILD_DIR)/vendor/mupdf-wasm && cp -r vendor/mupdf-wasm/. $(BUILD_DIR)/vendor/mupdf-wasm/
	@echo "TypeScript compilation complete"

test: nodebug js wasm
	$(TARGET) $(BUILD_DIR)/test/run.js $(TEST)

npm-pkg: js wasm
	rm -rf $(NPM_PKG_DIR)
	mkdir -p $(NPM_PKG_DIR)
	cp -r $(BUILD_DIR)/lib $(BUILD_DIR)/test $(BUILD_DIR)/examples $(BUILD_DIR)/vendor $(NPM_PKG_DIR)/
	cp lib/*.ts $(NPM_PKG_DIR)/lib/
	cp -r lib/react-qw $(NPM_PKG_DIR)/lib/
	cp test/*.ts $(NPM_PKG_DIR)/test/
	cp examples/*.ts examples/*.tsx $(NPM_PKG_DIR)/examples/
	cp quickwin.d.ts quickwin_const.d.ts tsconfig.json package.json README.md $(NPM_PKG_DIR)/
	@echo "npm package created at $(NPM_PKG_DIR)"

embed-js: $(TARGET)
	powershell -ExecutionPolicy Bypass -File scripts/embed-js.ps1 -ExePath $(TARGET) -JsFile $(JS_EMBED)

help:
	@echo "Available targets:"
	@echo "  all       - Build nodebug version (default, custom wolfSSL)"
	@echo "  release   - Build with -O2 + LTO + stripped + custom wolfSSL"
	@echo "  small     - Build with -Os + LTO + stripped + custom wolfSSL"
	@echo "  minimal   - Build with -Os + LTO + stripped + UPX + custom wolfSSL"
	@echo "  debug     - Build debug version (-g -O0, always has DUMP_GC/DUMP_LEAKS)"
	@echo "  clean     - Remove built files and JS files"
	@echo "  distclean - Remove all generated files"
	@echo "  info      - Show build configuration"
	@echo "  const     - Generate quickwin_const.d.ts from tools/gen_const.c"
	@echo "  js        - Compile TypeScript files to JavaScript"
	@echo "  test      - Run all suites: make test"
	@echo "  test      - Filter by name: make test TEST=wasm"
	@echo "  test      - Exclude by tag: make test TEST=-net"
	@echo "  wasm      - Convert WAT files to WASM (requires wabt)"
	@echo "  embed-js  - Embed JS_EMBED (default: embed.js) into exe: make embed-js JS_EMBED=script.js"
	@echo "  npm-pkg   - Package distributable into $(NPM_PKG_DIR)"
	@echo "  wolfsmin  - Build custom minimal wolfSSL static library"
	@echo "  help      - Show this help message"
