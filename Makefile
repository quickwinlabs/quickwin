CROSS ?= 0
ifeq ($(CROSS),1)
  CC64  = x86_64-w64-mingw32-gcc
  CC32  = i686-w64-mingw32-gcc
  CXX64 = x86_64-w64-mingw32-g++
  CXX32 = i686-w64-mingw32-g++
  WRES64 = x86_64-w64-mingw32-windres
  WRES32 = i686-w64-mingw32-windres
  SYSROOT64 = /usr/x86_64-w64-mingw32
  SYSROOT32 = /usr/i686-w64-mingw32
  LIBBROTLIDEC = $(BROTLI_LIB)
  LIBBROTLICOMMON = $(BROTLI_COMMON_LIB)
  LIBFFI = $(LIBFFI_LIB)
else
  CC64  = gcc
  CC32  = gcc
  CXX64 = g++
  CXX32 = g++
  WRES64 = windres
  WRES32 = windres
  SYSROOT64 = C:/msys64/ucrt64
  SYSROOT32 = C:/msys64/mingw32
  LIBBROTLIDEC = -lbrotlidec
  LIBBROTLICOMMON = -lbrotlicommon
  LIBFFI = -lffi
endif

CC = $(CC64)
CXX = $(CXX64)
WINDRES = $(WRES64)
MSYS2_PREFIX ?= $(SYSROOT64)

# flavor: fast（默认，开发快编）| small（发行，-Os+LTO 小体积）| debug（排错）
BUILD ?= fast
NO_WASM = 0
BUILD_DIR = _build
JS_EMBED ?= embed.js

ifeq ($(BUILD), debug)
    CFLAGS = -I./quickjs -I$(MSYS2_PREFIX)/include -g -O0 -DDEBUG
else ifeq ($(BUILD), small)
    CFLAGS = -I./quickjs -I$(MSYS2_PREFIX)/include -DNDEBUG \
             -Os -flto -fdata-sections -ffunction-sections
else
    CFLAGS = -I./quickjs -I$(MSYS2_PREFIX)/include -DNDEBUG \
             -fdata-sections -ffunction-sections
endif

CFLAGS += -D_WIN32_WINNT=0x0501
CFLAGS += -DDUMP_GC -DDUMP_LEAKS
CFLAGS += -Wall -Wextra

WAMR_DIR = wamr
WAMR_CORE = $(WAMR_DIR)/core/iwasm
WAMR_TARGET ?= X86_64
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

CROSS_HOST = $(patsubst %-gcc,%,$(CC))

BROTLI_DIR = brotli
BROTLI_BUILD_DIR = $(BROTLI_DIR)/build-$(CROSS_HOST)
BROTLI_LIB = $(BROTLI_DIR)/lib/libbrotlidec.a
BROTLI_COMMON_LIB = $(BROTLI_DIR)/lib/libbrotlicommon.a

LIBFFI_DIR = libffi
LIBFFI_BUILD_DIR = $(LIBFFI_DIR)/build-$(CROSS_HOST)
LIBFFI_LIB = $(LIBFFI_DIR)/lib/libffi.a

ifeq ($(CROSS),1)
CROSS_BUILD_LIBS = $(BROTLI_LIB) $(BROTLI_COMMON_LIB) $(LIBFFI_LIB)
else
CROSS_BUILD_LIBS =
endif

WAT_SRCS = $(wildcard test/*.wat)
WASM_OBJS = $(WAT_SRCS:test/%.wat=$(BUILD_DIR)/test/%.wasm)

ifeq ($(NO_WASM), 1)
    CFLAGS += -DNO_WASM
else
    CFLAGS += $(WAMR_INC)
    CFLAGS += $(WAMR_DEFS)
endif
CFLAGS += $(WOLFSSL_INC)
CFLAGS += -I$(LIBFFI_BUILD_DIR)/include
CFLAGS += -I$(BROTLI_DIR)/c/include

LDFLAGS = -L$(MSYS2_PREFIX)/lib -static
ifneq ($(BUILD), debug)
  ifeq ($(BUILD), small)
    LDFLAGS += -flto
  endif
    LDFLAGS += -Wl,--gc-sections -mwindows
endif
LIBS = $(LIBBROTLIDEC) $(LIBBROTLICOMMON) $(WOLFSSL_LIB) -lws2_32 -lbcrypt -lcrypt32 -lm -luser32 -lgdi32 -lcomctl32 $(LIBFFI) -lntdll -lshell32 -lwininet

TARGET_NAME ?= qwin.exe
TARGET = $(BUILD_DIR)/$(TARGET_NAME)
TARGET_NAME_32 ?= qwin-x86.exe
TARGET_NOWASM ?= qwin-nowasm.exe
TARGET_NOWASM_32 ?= qwin-nowasm-x86.exe
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
       quickjs-async-task.c


ifeq ($(NO_WASM), 0)
SRCS += quickjs-wamr.c
endif

OBJS = $(SRCS:%.c=$(BUILD_DIR)/%.o) $(BUILD_DIR)/app.o
DEPS = $(SRCS:%.c=$(BUILD_DIR)/%.d)

# 交叉构建目标重编前清理的产物（exe 各目标不同，在各自 recipe 里追加）
CLEAN_CACHE = $(OBJS) $(DEPS) $(QUICKJS_LIB)

.PHONY: cc64 cc32 cc64-nowasm cc32-nowasm apply-submodule-patches \
        const wamr wasm js test npm-pkg embed-js embed-js-br info help clean distclean

.DEFAULT_GOAL := cc64

apply-submodule-patches:
	@sh patches/apply-submodule-patches.sh

# 交叉构建公共模板：$(1)=target 名  $(2)=产物 exe（子 make goal）  $(3)=子 make 变量
# 注意 $$(MAKE) 双美元号：避免 eval 提前展开，保留 $(MAKE) 供 -n 递归/jobserver 识别
define cross_build
$(1): apply-submodule-patches
	rm -f $(CLEAN_CACHE) $(2)
	@$$(MAKE) CROSS=1 $(3) $(2)
endef

$(eval $(call cross_build,cc64,$(BUILD_DIR)/$(TARGET_NAME),))
$(eval $(call cross_build,cc32,$(BUILD_DIR)/$(TARGET_NAME_32),CC=i686-w64-mingw32-gcc CXX=i686-w64-mingw32-g++ WINDRES=i686-w64-mingw32-windres MSYS2_PREFIX=/usr/i686-w64-mingw32 WAMR_TARGET=X86_32 TARGET_NAME=$(TARGET_NAME_32)))
$(eval $(call cross_build,cc64-nowasm,$(BUILD_DIR)/$(TARGET_NOWASM),TARGET_NAME=$(TARGET_NOWASM) NO_WASM=1))
$(eval $(call cross_build,cc32-nowasm,$(BUILD_DIR)/$(TARGET_NOWASM_32),CC=i686-w64-mingw32-gcc CXX=i686-w64-mingw32-g++ WINDRES=i686-w64-mingw32-windres MSYS2_PREFIX=/usr/i686-w64-mingw32 WAMR_TARGET=X86_32 TARGET_NAME=$(TARGET_NOWASM_32) NO_WASM=1))

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

ifeq ($(NO_WASM), 1)
WAMR_LINK =
else
WAMR_LINK = $(WAMR_LIB)
endif

$(TARGET): $(OBJS) $(QUICKJS_LIB) $(WAMR_LINK) $(WOLFSSL_LIB_STATIC) $(CROSS_BUILD_LIBS)
	@echo "Linking $@..."
	mkdir -p $(BUILD_DIR)
	$(CC) -o $@ $(OBJS) $(QUICKJS_LIB) $(WAMR_LINK) $(LDFLAGS) $(LIBS)
ifneq ($(BUILD), debug)
	strip $@
endif
	@echo "Build complete: $@"

$(BUILD_DIR)/%.o: %.c | $(WOLFSSL_LIB_STATIC) $(CROSS_BUILD_LIBS)
	@echo "Compiling $<..."
	mkdir -p $(BUILD_DIR)
	$(CC) $(CFLAGS) -c -o $@ $<

# version.h is generated from package.json so package.json is the single source of truth;
# quickjs-libc.c includes it, explicit dep ensures rebuild on change
version.h: package.json
	@echo "Generating version.h from package.json"
	@VER=$$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1); \
	printf '#pragma once\n\n#define QUICKWIN_VERSION "%s"\n#define QUICKWIN_USER_AGENT "QuickWin/" QUICKWIN_VERSION\n' "$$VER" > $@

$(BUILD_DIR)/quickjs-libc.o: version.h

$(BUILD_DIR)/%.d: %.c
	@mkdir -p $(BUILD_DIR)
	$(CC) $(CFLAGS) -MM -MT '$(BUILD_DIR)/$*.o' $< > $@

$(BUILD_DIR)/app.o: app.rc
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

WAMR_CMAKE_OPTS = \
	-DWAMR_BUILD_PLATFORM=windows \
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
	-DCMAKE_BUILD_TYPE=Release \
	-DCMAKE_C_FLAGS="-D_SSIZE_T_DEFINED" \
	-DCMAKE_CXX_FLAGS="-D_SSIZE_T_DEFINED"

$(WAMR_LIB):
	@echo "Building WAMR..."
	@if [ ! -d "$(WAMR_DIR)" ]; then \
		echo "Error: wamr directory not found. Run: git submodule update --init"; \
		exit 1; \
	fi
	@sh patches/apply-submodule-patches.sh
	@mkdir -p $(WAMR_BUILD_DIR)
	cd $(WAMR_DIR) && cmake -B build $(WAMR_CMAKE_OPTS) \
		-DWAMR_BUILD_TARGET=$(WAMR_TARGET) \
		-DCMAKE_C_COMPILER=$(CC) \
		-DCMAKE_CXX_COMPILER=$(CXX)
	cmake --build $(WAMR_BUILD_DIR) --config Release
	@mkdir -p $(WAMR_DIR)/lib
	cp $(WAMR_BUILD_DIR)/libiwasm.a $(WAMR_LIB)
	@echo "WAMR build complete"

wamr: $(WAMR_LIB)

WOLFSSL_CMAKE_OPTS = \
	-DCMAKE_SYSTEM_NAME=Windows \
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
	-DWOLFSSL_SUPPORTED_CURVES=ON \
	-DNO_INT128=ON

$(WOLFSSL_LIB_STATIC):
	@echo "Building minimal wolfSSL..."
	if [ ! -f "$(WOLFSSL_DIR)/README.md" ]; then git submodule update --init --depth 1 $(WOLFSSL_DIR); fi
	@sh patches/apply-submodule-patches.sh
	@mkdir -p $(WOLFSSL_BUILD_DIR) $(WOLFSSL_DIR)/lib
	cd $(WOLFSSL_DIR) && cmake -B build $(WOLFSSL_CMAKE_OPTS) \
		-DCMAKE_C_COMPILER=$(CC)
	cmake --build $(WOLFSSL_BUILD_DIR) --config Release
	cp $(WOLFSSL_BUILD_DIR)/libwolfssl.a $(WOLFSSL_LIB_STATIC)
	@echo "Minimal wolfSSL build complete"

$(BROTLI_LIB) $(BROTLI_COMMON_LIB):
	@echo "Building brotli..."
	@if [ ! -f "$(BROTLI_DIR)/README.md" ]; then git submodule update --init --depth 1 $(BROTLI_DIR); fi
	@mkdir -p $(BROTLI_BUILD_DIR) $(BROTLI_DIR)/lib
	cmake -B $(BROTLI_BUILD_DIR) -S $(BROTLI_DIR) \
		-DCMAKE_BUILD_TYPE=Release \
		-DCMAKE_C_COMPILER=$(CC) \
		-DCMAKE_SYSTEM_NAME=Windows \
		-DBUILD_SHARED_LIBS=OFF \
		-DBROTLI_DISABLE_TESTS=ON \
		-DBROTLI_DISABLE_TOOLS=ON
	cmake --build $(BROTLI_BUILD_DIR) --config Release
	cp $(BROTLI_BUILD_DIR)/libbrotlidec.a $(BROTLI_LIB)
	cp $(BROTLI_BUILD_DIR)/libbrotlicommon.a $(BROTLI_COMMON_LIB)
	@echo "brotli build complete"

$(LIBFFI_LIB):
	@echo "Building libffi..."
	@if [ ! -f "$(LIBFFI_DIR)/LICENSE" ]; then git submodule update --init --depth 1 $(LIBFFI_DIR); fi
	@if [ ! -f "$(LIBFFI_DIR)/configure" ]; then cd $(LIBFFI_DIR) && autoreconf -fiv; fi
	@mkdir -p $(LIBFFI_BUILD_DIR) $(LIBFFI_DIR)/lib
	cd $(LIBFFI_BUILD_DIR) && \
		$(abspath $(LIBFFI_DIR))/configure \
			--host=$(CROSS_HOST) --build=x86_64-pc-linux-gnu \
			--disable-shared --enable-static --disable-doc --disable-tests \
			&& make libffi.la
	cp $(LIBFFI_BUILD_DIR)/.libs/libffi.a $(LIBFFI_LIB)
	@echo "libffi build complete"

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
	@echo "  BUILD     = $(BUILD)"
	@echo "  NO_WASM   = $(NO_WASM)"

js:
	@echo "Compiling TypeScript files to JavaScript using tsc..."
	@npx tsc --project tsconfig.json
	@echo "Bundling react entries with esbuild..."
	@node build.ts
	@echo "Copying vendor/mupdf-wasm to $(BUILD_DIR)/vendor/mupdf-wasm..."
	@rm -rf $(BUILD_DIR)/vendor/mupdf-wasm && mkdir -p $(BUILD_DIR)/vendor/mupdf-wasm && cp -r vendor/mupdf-wasm/. $(BUILD_DIR)/vendor/mupdf-wasm/
	@mkdir -p $(BUILD_DIR)/lib/vendor/web-streams && cp lib/vendor/web-streams/ponyfill.mjs $(BUILD_DIR)/lib/vendor/web-streams/
	@echo "TypeScript compilation complete"

test: cc64 js wasm
	node --experimental-strip-types tools/serve_test.ts 18923 & SERVER_PID=$$!; $(TARGET) $(BUILD_DIR)/test/run.js $(TEST); rc=$$?; kill $$SERVER_PID 2>/dev/null; exit $$rc

npm-pkg: js wasm
	rm -rf $(NPM_PKG_DIR)
	mkdir -p $(NPM_PKG_DIR)
	cp -r $(BUILD_DIR)/lib $(BUILD_DIR)/test $(BUILD_DIR)/examples $(BUILD_DIR)/vendor $(NPM_PKG_DIR)/
	find lib \( -name '*.ts' -o -name '*.mts' \) -exec cp --parents {} $(NPM_PKG_DIR)/ \;
	cp test/*.ts $(NPM_PKG_DIR)/test/
	cp examples/*.ts examples/*.tsx $(NPM_PKG_DIR)/examples/
	cp quickwin.d.ts quickwin_const.d.ts tsconfig.json package.json README.md README.en.md $(NPM_PKG_DIR)/
	cp $(BUILD_DIR)/$(TARGET_NAME) $(BUILD_DIR)/$(TARGET_NAME_32) $(BUILD_DIR)/$(TARGET_NOWASM) $(BUILD_DIR)/$(TARGET_NOWASM_32) $(NPM_PKG_DIR)/
	@echo "npm package created at $(NPM_PKG_DIR)"

embed-js: cc64
	powershell -ExecutionPolicy Bypass -File scripts/embed-js.ps1 -ExePath $(TARGET) -JsFile $(JS_EMBED)

embed-js-br: cc64
	powershell -ExecutionPolicy Bypass -File scripts/embed-js.ps1 -ExePath $(TARGET) -JsFile $(JS_EMBED) -Compress

help:
	@echo "Available targets:"
	@echo "  BUILD=fast(默认)|small|debug 可用于所有构建 target："
	@echo "  make cc64                     - cross x86_64, fast build -> $(BUILD_DIR)/$(TARGET_NAME)"
	@echo "  make cc64 BUILD=small         - cross x86_64, -Os+LTO release (CI/发布)"
	@echo "  make cc64 BUILD=debug         - cross x86_64, -g -O0 debug (不 strip)"
	@echo "  cc32                          - cross i686 -> $(BUILD_DIR)/$(TARGET_NAME_32)"
	@echo "  cc64-nowasm / cc32-nowasm     - 同上但无 WASM/WAMR"
	@echo "  test      - Run suites: make test / make test TEST=wasm / make test TEST=-net"
	@echo "  js        - Compile TypeScript files to JavaScript"
	@echo "  wasm      - Convert WAT files to WASM (requires wabt)"
	@echo "  npm-pkg   - Package distributable into $(NPM_PKG_DIR)"
	@echo "  const     - Generate quickwin_const.d.ts from tools/gen_const.c"
	@echo "  wamr      - Build WAMR static library (auto-built on demand)"
	@echo "  embed-js  - Embed JS_EMBED into exe: make embed-js JS_EMBED=script.js"
	@echo "  embed-js-br - Embed brotli-compressed JS into exe"
	@echo "  clean     - Remove built files"
	@echo "  info      - Show build configuration"
	@echo "  help      - Show this help message"
