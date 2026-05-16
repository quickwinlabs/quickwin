// This code implements the `-sMODULARIZE` settings by taking the generated
// JS program code (INNER_JS_CODE) and wrapping it in a factory function.

// When targeting node and ES6 we use `await import ..` in the generated code
// so the outer function needs to be marked as async.
async function libmupdf_wasm(moduleArg = {}) {
  var moduleRtn;

// include: shell.js
// include: minimum_runtime_check.js
// end include: minimum_runtime_check.js
// The Module object: Our interface to the outside world. We import
// and export values on it. There are various ways Module can be used:
// 1. Not defined. We create it here
// 2. A function parameter, function(moduleArg) => Promise<Module>
// 3. pre-run appended it, var Module = {}; ..generated code..
// 4. External script tag defines var Module.
// We need to check if Module already exists (e.g. case 3 above).
// Substitution will be replaced with actual code on later stage of the build,
// this way Closure Compiler will not mangle it (e.g. case 4. above).
// Note that if you want to run closure, and also to use Module
// after the generated code, you will need to define   var Module = {};
// before the code. Then that object will be used in the code, and you
// can continue to use Module afterwards as well.
var Module = moduleArg;

// Determine the runtime environment we are in. You can customize this by
// setting the ENVIRONMENT setting at compile time (see settings.js).
// Attempt to auto-detect the environment
var ENVIRONMENT_IS_WEB = !!globalThis.window;

var ENVIRONMENT_IS_WORKER = !!globalThis.WorkerGlobalScope;

// N.b. Electron.js environment is simultaneously a NODE-environment, but
// also a web environment.
var ENVIRONMENT_IS_NODE = globalThis.process?.versions?.node && globalThis.process?.type != "renderer";

if (ENVIRONMENT_IS_NODE) {
  // When building an ES module `require` is not normally available.
  // We need to use `createRequire()` to construct the require()` function.
  const {createRequire} = await import("node:module");
  /** @suppress{duplicate} */ var require = createRequire(import.meta.url);
}

// --pre-jses are emitted after the Module integration code, so that they can
// refer to Module (if they choose; they can also define Module)
var arguments_ = [];

var thisProgram = "./this.program";

var quit_ = (status, toThrow) => {
  throw toThrow;
};

var _scriptName = import.meta.url;

// `/` should be present at the end if `scriptDirectory` is not empty
var scriptDirectory = "";

function locateFile(path) {
  if (Module["locateFile"]) {
    return Module["locateFile"](path, scriptDirectory);
  }
  return scriptDirectory + path;
}

// Hooks that are implemented differently in different runtime environments.
var readAsync, readBinary;

if (ENVIRONMENT_IS_NODE) {
  // These modules will usually be used on Node.js. Load them eagerly to avoid
  // the complexity of lazy-loading.
  var fs = require("node:fs");
  if (_scriptName.startsWith("file:")) {
    scriptDirectory = require("node:path").dirname(require("node:url").fileURLToPath(_scriptName)) + "/";
  }
  // include: node_shell_read.js
  readBinary = filename => {
    // We need to re-wrap `file://` strings to URLs.
    filename = isFileURI(filename) ? new URL(filename) : filename;
    var ret = fs.readFileSync(filename);
    return ret;
  };
  readAsync = async (filename, binary = true) => {
    // See the comment in the `readBinary` function.
    filename = isFileURI(filename) ? new URL(filename) : filename;
    var ret = fs.readFileSync(filename, binary ? undefined : "utf8");
    return ret;
  };
  // end include: node_shell_read.js
  if (process.argv.length > 1) {
    thisProgram = process.argv[1].replace(/\\/g, "/");
  }
  arguments_ = process.argv.slice(2);
  quit_ = (status, toThrow) => {
    process.exitCode = status;
    throw toThrow;
  };
} else // Note that this includes Node.js workers when relevant (pthreads is enabled).
// Node.js workers are detected as a combination of ENVIRONMENT_IS_WORKER and
// ENVIRONMENT_IS_NODE.
if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
  try {
    scriptDirectory = new URL(".", _scriptName).href;
  } catch {}
  {
    // include: web_or_worker_shell_read.js
    if (ENVIRONMENT_IS_WORKER) {
      readBinary = url => {
        var xhr = new XMLHttpRequest;
        xhr.open("GET", url, false);
        xhr.responseType = "arraybuffer";
        xhr.send(null);
        return new Uint8Array(/** @type{!ArrayBuffer} */ (xhr.response));
      };
    }
    readAsync = async url => {
      // Fetch has some additional restrictions over XHR, like it can't be used on a file:// url.
      // See https://github.com/github/fetch/pull/92#issuecomment-140665932
      // Cordova or Electron apps are typically loaded from a file:// url.
      // So use XHR on webview if URL is a file URL.
      if (isFileURI(url)) {
        return new Promise((resolve, reject) => {
          var xhr = new XMLHttpRequest;
          xhr.open("GET", url, true);
          xhr.responseType = "arraybuffer";
          xhr.onload = () => {
            if (xhr.status == 200 || (xhr.status == 0 && xhr.response)) {
              // file URLs can return 0
              resolve(xhr.response);
              return;
            }
            reject(xhr.status);
          };
          xhr.onerror = reject;
          xhr.send(null);
        });
      }
      var response = await fetch(url, {
        credentials: "same-origin"
      });
      if (response.ok) {
        return response.arrayBuffer();
      }
      throw new Error(response.status + " : " + response.url);
    };
  }
} else {}

var out = console.log.bind(console);

var err = console.error.bind(console);

// end include: shell.js
// include: preamble.js
// === Preamble library stuff ===
// Documentation for the public APIs defined in this file must be updated in:
//    site/source/docs/api_reference/preamble.js.rst
// A prebuilt local version of the documentation is available at:
//    site/build/text/docs/api_reference/preamble.js.txt
// You can also build docs locally as HTML or other formats in site/
// An online HTML version (which may be of a different version of Emscripten)
//    is up at http://kripken.github.io/emscripten-site/docs/api_reference/preamble.js.html
var wasmBinary;

// Wasm globals
//========================================
// Runtime essentials
//========================================
// whether we are quitting the application. no code should run after this.
// set in exit() and abort()
var ABORT = false;

// set by exit() and abort().  Passed to 'onExit' handler.
// NOTE: This is also used as the process return code in shell environments
// but only when noExitRuntime is false.
var EXITSTATUS;

/**
 * Indicates whether filename is delivered via file protocol (as opposed to http/https)
 * @noinline
 */ var isFileURI = filename => filename.startsWith("file://");

// include: runtime_common.js
// include: runtime_stack_check.js
// end include: runtime_stack_check.js
// include: runtime_exceptions.js
// Base Emscripten EH error class
class EmscriptenEH {}

class EmscriptenSjLj extends EmscriptenEH {}

// end include: runtime_exceptions.js
// include: runtime_debug.js
// end include: runtime_debug.js
var readyPromiseResolve, readyPromiseReject;

// Memory management
var runtimeInitialized = false;

function updateMemoryViews() {
  var b = wasmMemory.buffer;
  HEAP8 = new Int8Array(b);
  HEAP16 = new Int16Array(b);
  Module["HEAPU8"] = HEAPU8 = new Uint8Array(b);
  HEAPU16 = new Uint16Array(b);
  Module["HEAP32"] = HEAP32 = new Int32Array(b);
  Module["HEAPU32"] = HEAPU32 = new Uint32Array(b);
  Module["HEAPF32"] = HEAPF32 = new Float32Array(b);
  HEAPF64 = new Float64Array(b);
  HEAP64 = new BigInt64Array(b);
  HEAPU64 = new BigUint64Array(b);
}

// include: memoryprofiler.js
// end include: memoryprofiler.js
// end include: runtime_common.js
function preRun() {
  if (Module["preRun"]) {
    if (typeof Module["preRun"] == "function") Module["preRun"] = [ Module["preRun"] ];
    while (Module["preRun"].length) {
      addOnPreRun(Module["preRun"].shift());
    }
  }
  // Begin ATPRERUNS hooks
  callRuntimeCallbacks(onPreRuns);
}

function initRuntime() {
  runtimeInitialized = true;
  wasmExports["db"]();
}

function postRun() {
  // PThreads reuse the runtime from the main thread.
  if (Module["postRun"]) {
    if (typeof Module["postRun"] == "function") Module["postRun"] = [ Module["postRun"] ];
    while (Module["postRun"].length) {
      addOnPostRun(Module["postRun"].shift());
    }
  }
  // Begin ATPOSTRUNS hooks
  callRuntimeCallbacks(onPostRuns);
}

/**
 * @param {string|number=} what
 */ function abort(what) {
  Module["onAbort"]?.(what);
  what = `Aborted(${what})`;
  // TODO(sbc): Should we remove printing and leave it up to whoever
  // catches the exception?
  err(what);
  ABORT = true;
  what += ". Build with -sASSERTIONS for more info.";
  // Use a wasm runtime error, because a JS error might be seen as a foreign
  // exception, which means we'd run destructors on it. We need the error to
  // simply make the program stop.
  // FIXME This approach does not work in Wasm EH because it currently does not assume
  // all RuntimeErrors are from traps; it decides whether a RuntimeError is from
  // a trap or not based on a hidden field within the object. So at the moment
  // we don't have a way of throwing a wasm trap from JS. TODO Make a JS API that
  // allows this in the wasm spec.
  // Suppress closure compiler warning here. Closure compiler's builtin extern
  // definition for WebAssembly.RuntimeError claims it takes no arguments even
  // though it can.
  // TODO(https://github.com/google/closure-compiler/pull/3913): Remove if/when upstream closure gets fixed.
  /** @suppress {checkTypes} */ var e = new WebAssembly.RuntimeError(what);
  readyPromiseReject?.(e);
  // Throw the error whether or not MODULARIZE is set because abort is used
  // in code paths apart from instantiation where an exception is expected
  // to be thrown when abort is called.
  throw e;
}

var wasmBinaryFile;

function findWasmBinary() {
  if (Module["locateFile"]) {
    return locateFile("mupdf-wasm.wasm");
  }
  // Use bundler-friendly `new URL(..., import.meta.url)` pattern; works in browsers too.
  return new URL("mupdf-wasm.wasm", import.meta.url).href;
}

function getBinarySync(file) {
  if (file == wasmBinaryFile && wasmBinary) {
    return new Uint8Array(wasmBinary);
  }
  if (readBinary) {
    return readBinary(file);
  }
  // Throwing a plain string here, even though it not normally advisable since
  // this gets turning into an `abort` in instantiateArrayBuffer.
  throw "both async and sync fetching of the wasm failed";
}

async function getWasmBinary(binaryFile) {
  // If we don't have the binary yet, load it asynchronously using readAsync.
  if (!wasmBinary) {
    // Fetch the binary using readAsync
    try {
      var response = await readAsync(binaryFile);
      return new Uint8Array(response);
    } catch {}
  }
  // Otherwise, getBinarySync should be able to get it synchronously
  return getBinarySync(binaryFile);
}

async function instantiateArrayBuffer(binaryFile, imports) {
  try {
    var binary = await getWasmBinary(binaryFile);
    var instance = await WebAssembly.instantiate(binary, imports);
    return instance;
  } catch (reason) {
    err(`failed to asynchronously prepare wasm: ${reason}`);
    abort(reason);
  }
}

async function instantiateAsync(binary, binaryFile, imports) {
  if (!binary && !isFileURI(binaryFile) && !ENVIRONMENT_IS_NODE) {
    try {
      var response = fetch(binaryFile, {
        credentials: "same-origin"
      });
      var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
      return instantiationResult;
    } catch (reason) {
      // We expect the most common failure cause to be a bad MIME type for the binary,
      // in which case falling back to ArrayBuffer instantiation should work.
      err(`wasm streaming compile failed: ${reason}`);
      err("falling back to ArrayBuffer instantiation");
    }
  }
  return instantiateArrayBuffer(binaryFile, imports);
}

function getWasmImports() {
  // prepare imports
  var imports = {
    "a": wasmImports
  };
  return imports;
}

// Create the wasm instance.
// Receives the wasm imports, returns the exports.
async function createWasm() {
  // Load the wasm module and create an instance of using native support in the JS engine.
  // handle a generated wasm instance, receiving its exports and
  // performing other necessary setup
  /** @param {WebAssembly.Module=} module*/ function receiveInstance(instance, module) {
    wasmExports = instance.exports;
    assignWasmExports(wasmExports);
    updateMemoryViews();
    return wasmExports;
  }
  // Prefer streaming instantiation if available.
  function receiveInstantiationResult(result) {
    // 'result' is a ResultObject object which has both the module and instance.
    // receiveInstance() will swap in the exports (to Module.asm) so they can be called
    // TODO: Due to Closure regression https://github.com/google/closure-compiler/issues/3193, the above line no longer optimizes out down to the following line.
    // When the regression is fixed, can restore the above PTHREADS-enabled path.
    return receiveInstance(result["instance"]);
  }
  var info = getWasmImports();
  // User shell pages can write their own Module.instantiateWasm = function(imports, successCallback) callback
  // to manually instantiate the Wasm module themselves. This allows pages to
  // run the instantiation parallel to any other async startup actions they are
  // performing.
  // Also pthreads and wasm workers initialize the wasm instance through this
  // path.
  if (Module["instantiateWasm"]) {
    return new Promise((resolve, reject) => {
      Module["instantiateWasm"](info, (inst, mod) => {
        resolve(receiveInstance(inst, mod));
      });
    });
  }
  wasmBinaryFile ??= findWasmBinary();
  var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info);
  var exports = receiveInstantiationResult(result);
  return exports;
}

// end include: preamble.js
// Begin JS library code
class ExitStatus {
  name="ExitStatus";
  constructor(status) {
    this.message = `Program terminated with exit(${status})`;
    this.status = status;
  }
}

/** @type {!Int16Array} */ var HEAP16;

/** @type {!Int32Array} */ var HEAP32;

/** not-@type {!BigInt64Array} */ var HEAP64;

/** @type {!Int8Array} */ var HEAP8;

/** @type {!Float32Array} */ var HEAPF32;

/** @type {!Float64Array} */ var HEAPF64;

/** @type {!Uint16Array} */ var HEAPU16;

/** @type {!Uint32Array} */ var HEAPU32;

/** not-@type {!BigUint64Array} */ var HEAPU64;

/** @type {!Uint8Array} */ var HEAPU8;

var callRuntimeCallbacks = callbacks => {
  while (callbacks.length > 0) {
    // Pass the module as the first argument.
    callbacks.shift()(Module);
  }
};

var onPostRuns = [];

var addOnPostRun = cb => onPostRuns.push(cb);

var onPreRuns = [];

var addOnPreRun = cb => onPreRuns.push(cb);

var noExitRuntime = true;

var stackRestore = val => __emscripten_stack_restore(val);

var stackSave = () => _emscripten_stack_get_current();

var UTF8Decoder = new TextDecoder;

var findStringEnd = (heapOrArray, idx, maxBytesToRead, ignoreNul) => {
  var maxIdx = idx + maxBytesToRead;
  if (ignoreNul) return maxIdx;
  // TextDecoder needs to know the byte length in advance, it doesn't stop on
  // null terminator by itself.
  // As a tiny code save trick, compare idx against maxIdx using a negation,
  // so that maxBytesToRead=undefined/NaN means Infinity.
  while (heapOrArray[idx] && !(idx >= maxIdx)) ++idx;
  return idx;
};

/**
   * Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the
   * emscripten HEAP, returns a copy of that string as a Javascript String object.
   *
   * @param {number} ptr
   * @param {number=} maxBytesToRead - An optional length that specifies the
   *   maximum number of bytes to read. You can omit this parameter to scan the
   *   string until the first 0 byte. If maxBytesToRead is passed, and the string
   *   at [ptr, ptr+maxBytesToReadr[ contains a null byte in the middle, then the
   *   string will cut short at that byte index.
   * @param {boolean=} ignoreNul - If true, the function will not stop on a NUL character.
   * @return {string}
   */ var UTF8ToString = (ptr, maxBytesToRead, ignoreNul) => {
  if (!ptr) return "";
  var end = findStringEnd(HEAPU8, ptr, maxBytesToRead, ignoreNul);
  return UTF8Decoder.decode(HEAPU8.subarray(ptr, end));
};

var SYSCALLS = {
  varargs: undefined,
  getStr(ptr) {
    var ret = UTF8ToString(ptr);
    return ret;
  }
};

function ___syscall_fcntl64(fd, cmd, varargs) {
  SYSCALLS.varargs = varargs;
  return 0;
}

var INT53_MAX = 9007199254740992;

var INT53_MIN = -9007199254740992;

var bigintToI53Checked = num => (num < INT53_MIN || num > INT53_MAX) ? NaN : Number(num);

function ___syscall_ftruncate64(fd, length) {
  length = bigintToI53Checked(length);
}

function ___syscall_ioctl(fd, op, varargs) {
  SYSCALLS.varargs = varargs;
  return 0;
}

function ___syscall_openat(dirfd, path, flags, varargs) {
  SYSCALLS.varargs = varargs;
}

var ___syscall_rmdir = path => {};

var ___syscall_unlinkat = (dirfd, path, flags) => {};

var __emscripten_throw_longjmp = () => {
  throw new EmscriptenSjLj;
};

function __gmtime_js(time, tmPtr) {
  time = bigintToI53Checked(time);
  var date = new Date(time * 1e3);
  HEAP32[((tmPtr) >> 2)] = date.getUTCSeconds();
  HEAP32[(((tmPtr) + (4)) >> 2)] = date.getUTCMinutes();
  HEAP32[(((tmPtr) + (8)) >> 2)] = date.getUTCHours();
  HEAP32[(((tmPtr) + (12)) >> 2)] = date.getUTCDate();
  HEAP32[(((tmPtr) + (16)) >> 2)] = date.getUTCMonth();
  HEAP32[(((tmPtr) + (20)) >> 2)] = date.getUTCFullYear() - 1900;
  HEAP32[(((tmPtr) + (24)) >> 2)] = date.getUTCDay();
  var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
  var yday = ((date.getTime() - start) / (1e3 * 60 * 60 * 24)) | 0;
  HEAP32[(((tmPtr) + (28)) >> 2)] = yday;
}

var __timegm_js = function(tmPtr) {
  var ret = (() => {
    var time = Date.UTC(HEAP32[(((tmPtr) + (20)) >> 2)] + 1900, HEAP32[(((tmPtr) + (16)) >> 2)], HEAP32[(((tmPtr) + (12)) >> 2)], HEAP32[(((tmPtr) + (8)) >> 2)], HEAP32[(((tmPtr) + (4)) >> 2)], HEAP32[((tmPtr) >> 2)], 0);
    var date = new Date(time);
    HEAP32[(((tmPtr) + (24)) >> 2)] = date.getUTCDay();
    var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
    var yday = ((date.getTime() - start) / (1e3 * 60 * 60 * 24)) | 0;
    HEAP32[(((tmPtr) + (28)) >> 2)] = yday;
    return date.getTime() / 1e3;
  })();
  return BigInt(ret);
};

var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {
  // Parameter maxBytesToWrite is not optional. Negative values, 0, null,
  // undefined and false each don't write out any bytes.
  if (!(maxBytesToWrite > 0)) return 0;
  var startIdx = outIdx;
  var endIdx = outIdx + maxBytesToWrite - 1;
  // -1 for string null terminator.
  for (var i = 0; i < str.length; ++i) {
    // For UTF8 byte structure, see http://en.wikipedia.org/wiki/UTF-8#Description
    // and https://www.ietf.org/rfc/rfc2279.txt
    // and https://tools.ietf.org/html/rfc3629
    var u = str.codePointAt(i);
    if (u <= 127) {
      if (outIdx >= endIdx) break;
      heap[outIdx++] = u;
    } else if (u <= 2047) {
      if (outIdx + 1 >= endIdx) break;
      heap[outIdx++] = 192 | (u >> 6);
      heap[outIdx++] = 128 | (u & 63);
    } else if (u <= 65535) {
      if (outIdx + 2 >= endIdx) break;
      heap[outIdx++] = 224 | (u >> 12);
      heap[outIdx++] = 128 | ((u >> 6) & 63);
      heap[outIdx++] = 128 | (u & 63);
    } else {
      if (outIdx + 3 >= endIdx) break;
      heap[outIdx++] = 240 | (u >> 18);
      heap[outIdx++] = 128 | ((u >> 12) & 63);
      heap[outIdx++] = 128 | ((u >> 6) & 63);
      heap[outIdx++] = 128 | (u & 63);
      // Gotcha: if codePoint is over 0xFFFF, it is represented as a surrogate pair in UTF-16.
      // We need to manually skip over the second code unit for correct iteration.
      i++;
    }
  }
  // Null-terminate the pointer to the buffer.
  heap[outIdx] = 0;
  return outIdx - startIdx;
};

var stringToUTF8 = (str, outPtr, maxBytesToWrite) => stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);

var __tzset_js = (timezone, daylight, std_name, dst_name) => {
  // TODO: Use (malleable) environment variables instead of system settings.
  var currentYear = (new Date).getFullYear();
  var winter = new Date(currentYear, 0, 1);
  var summer = new Date(currentYear, 6, 1);
  var winterOffset = winter.getTimezoneOffset();
  var summerOffset = summer.getTimezoneOffset();
  // Local standard timezone offset. Local standard time is not adjusted for
  // daylight savings.  This code uses the fact that getTimezoneOffset returns
  // a greater value during Standard Time versus Daylight Saving Time (DST).
  // Thus it determines the expected output during Standard Time, and it
  // compares whether the output of the given date the same (Standard) or less
  // (DST).
  var stdTimezoneOffset = Math.max(winterOffset, summerOffset);
  // timezone is specified as seconds west of UTC ("The external variable
  // `timezone` shall be set to the difference, in seconds, between
  // Coordinated Universal Time (UTC) and local standard time."), the same
  // as returned by stdTimezoneOffset.
  // See http://pubs.opengroup.org/onlinepubs/009695399/functions/tzset.html
  HEAPU32[((timezone) >> 2)] = stdTimezoneOffset * 60;
  HEAP32[((daylight) >> 2)] = Number(winterOffset != summerOffset);
  var extractZone = timezoneOffset => {
    // Why inverse sign?
    // Read here https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/getTimezoneOffset
    var sign = timezoneOffset >= 0 ? "-" : "+";
    var absOffset = Math.abs(timezoneOffset);
    var hours = String(Math.floor(absOffset / 60)).padStart(2, "0");
    var minutes = String(absOffset % 60).padStart(2, "0");
    return `UTC${sign}${hours}${minutes}`;
  };
  var winterName = extractZone(winterOffset);
  var summerName = extractZone(summerOffset);
  if (summerOffset < winterOffset) {
    // Northern hemisphere
    stringToUTF8(winterName, std_name, 17);
    stringToUTF8(summerName, dst_name, 17);
  } else {
    stringToUTF8(winterName, dst_name, 17);
    stringToUTF8(summerName, std_name, 17);
  }
};

var _emscripten_get_now = () => performance.now();

var _emscripten_date_now = () => Date.now();

var nowIsMonotonic = 1;

var checkWasiClock = clock_id => clock_id >= 0 && clock_id <= 3;

function _clock_time_get(clk_id, ignored_precision, ptime) {
  ignored_precision = bigintToI53Checked(ignored_precision);
  if (!checkWasiClock(clk_id)) {
    return 28;
  }
  var now;
  // all wasi clocks but realtime are monotonic
  if (clk_id === 0) {
    now = _emscripten_date_now();
  } else if (nowIsMonotonic) {
    now = _emscripten_get_now();
  } else {
    return 52;
  }
  // "now" is in ms, and wasi times are in ns.
  var nsec = Math.round(now * 1e3 * 1e3);
  HEAP64[((ptime) >> 3)] = BigInt(nsec);
  return 0;
}

var readEmAsmArgsArray = [];

var readEmAsmArgs = (sigPtr, buf) => {
  readEmAsmArgsArray.length = 0;
  var ch;
  // Most arguments are i32s, so shift the buffer pointer so it is a plain
  // index into HEAP32.
  while (ch = HEAPU8[sigPtr++]) {
    // Floats are always passed as doubles, so all types except for 'i'
    // are 8 bytes and require alignment.
    var wide = (ch != 105);
    wide &= (ch != 112);
    buf += wide && (buf % 8) ? 4 : 0;
    readEmAsmArgsArray.push(// Special case for pointers under wasm64 or CAN_ADDRESS_2GB mode.
    ch == 112 ? HEAPU32[((buf) >> 2)] : ch == 106 ? HEAP64[((buf) >> 3)] : ch == 105 ? HEAP32[((buf) >> 2)] : HEAPF64[((buf) >> 3)]);
    buf += wide ? 8 : 4;
  }
  return readEmAsmArgsArray;
};

var runEmAsmFunction = (code, sigPtr, argbuf) => {
  var args = readEmAsmArgs(sigPtr, argbuf);
  return ASM_CONSTS[code](...args);
};

var _emscripten_asm_const_int = (code, sigPtr, argbuf) => runEmAsmFunction(code, sigPtr, argbuf);

var _emscripten_asm_const_ptr = (code, sigPtr, argbuf) => runEmAsmFunction(code, sigPtr, argbuf);

var getHeapMax = () => // Stay one Wasm page short of 4GB: while e.g. Chrome is able to allocate
// full 4GB Wasm memories, the size will wrap back to 0 bytes in Wasm side
// for any code that deals with heap sizes, which would require special
// casing all heap size related code to treat 0 specially.
2147483648;

var alignMemory = (size, alignment) => Math.ceil(size / alignment) * alignment;

var growMemory = size => {
  var oldHeapSize = wasmMemory.buffer.byteLength;
  var pages = ((size - oldHeapSize + 65535) / 65536) | 0;
  try {
    // round size grow request up to wasm page size (fixed 64KB per spec)
    wasmMemory.grow(pages);
    // .grow() takes a delta compared to the previous size
    updateMemoryViews();
    return 1;
  } catch (e) {}
};

var _emscripten_resize_heap = requestedSize => {
  var oldSize = HEAPU8.length;
  // With CAN_ADDRESS_2GB or MEMORY64, pointers are already unsigned.
  requestedSize >>>= 0;
  // With multithreaded builds, races can happen (another thread might increase the size
  // in between), so return a failure, and let the caller retry.
  // Memory resize rules:
  // 1.  Always increase heap size to at least the requested size, rounded up
  //     to next page multiple.
  // 2a. If MEMORY_GROWTH_LINEAR_STEP == -1, excessively resize the heap
  //     geometrically: increase the heap size according to
  //     MEMORY_GROWTH_GEOMETRIC_STEP factor (default +20%), At most
  //     overreserve by MEMORY_GROWTH_GEOMETRIC_CAP bytes (default 96MB).
  // 2b. If MEMORY_GROWTH_LINEAR_STEP != -1, excessively resize the heap
  //     linearly: increase the heap size by at least
  //     MEMORY_GROWTH_LINEAR_STEP bytes.
  // 3.  Max size for the heap is capped at 2048MB-WASM_PAGE_SIZE, or by
  //     MAXIMUM_MEMORY, or by ASAN limit, depending on which is smallest
  // 4.  If we were unable to allocate as much memory, it may be due to
  //     over-eager decision to excessively reserve due to (3) above.
  //     Hence if an allocation fails, cut down on the amount of excess
  //     growth, in an attempt to succeed to perform a smaller allocation.
  // A limit is set for how much we can grow. We should not exceed that
  // (the wasm binary specifies it, so if we tried, we'd fail anyhow).
  var maxHeapSize = getHeapMax();
  if (requestedSize > maxHeapSize) {
    return false;
  }
  // Loop through potential heap size increases. If we attempt a too eager
  // reservation that fails, cut down on the attempted size and reserve a
  // smaller bump instead. (max 3 times, chosen somewhat arbitrarily)
  for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
    var overGrownHeapSize = oldSize * (1 + .2 / cutDown);
    // ensure geometric growth
    // but limit overreserving (default to capping at +96MB overgrowth at most)
    overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
    var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
    var replacement = growMemory(newSize);
    if (replacement) {
      return true;
    }
  }
  return false;
};

var ENV = {};

var getExecutableName = () => thisProgram || "./this.program";

var getEnvStrings = () => {
  if (!getEnvStrings.strings) {
    // Default values.
    var lang = (globalThis.navigator?.language ?? "C").replace("-", "_") + ".UTF-8";
    var env = {
      "USER": "web_user",
      "LOGNAME": "web_user",
      "PATH": "/",
      "PWD": "/",
      "HOME": "/home/web_user",
      "LANG": lang,
      "_": getExecutableName()
    };
    // Apply the user-provided values, if any.
    for (var x in ENV) {
      // x is a key in ENV; if ENV[x] is undefined, that means it was
      // explicitly set to be so. We allow user code to do that to
      // force variables with default values to remain unset.
      if (ENV[x] === undefined) delete env[x]; else env[x] = ENV[x];
    }
    var strings = [];
    for (var x in env) {
      strings.push(`${x}=${env[x]}`);
    }
    getEnvStrings.strings = strings;
  }
  return getEnvStrings.strings;
};

var _environ_get = (__environ, environ_buf) => {
  var bufSize = 0;
  var envp = 0;
  for (var string of getEnvStrings()) {
    var ptr = environ_buf + bufSize;
    HEAPU32[(((__environ) + (envp)) >> 2)] = ptr;
    bufSize += stringToUTF8(string, ptr, Infinity) + 1;
    envp += 4;
  }
  return 0;
};

var lengthBytesUTF8 = str => {
  var len = 0;
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code
    // unit, not a Unicode code point of the character! So decode
    // UTF16->UTF32->UTF8.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    var c = str.charCodeAt(i);
    // possibly a lead surrogate
    if (c <= 127) {
      len++;
    } else if (c <= 2047) {
      len += 2;
    } else if (c >= 55296 && c <= 57343) {
      len += 4;
      ++i;
    } else {
      len += 3;
    }
  }
  return len;
};

var _environ_sizes_get = (penviron_count, penviron_buf_size) => {
  var strings = getEnvStrings();
  HEAPU32[((penviron_count) >> 2)] = strings.length;
  var bufSize = 0;
  for (var string of strings) {
    bufSize += lengthBytesUTF8(string) + 1;
  }
  HEAPU32[((penviron_buf_size) >> 2)] = bufSize;
  return 0;
};

var runtimeKeepaliveCounter = 0;

var keepRuntimeAlive = () => noExitRuntime || runtimeKeepaliveCounter > 0;

var _proc_exit = code => {
  EXITSTATUS = code;
  if (!keepRuntimeAlive()) {
    Module["onExit"]?.(code);
    ABORT = true;
  }
  quit_(code, new ExitStatus(code));
};

/** @param {boolean|number=} implicit */ var exitJS = (status, implicit) => {
  EXITSTATUS = status;
  _proc_exit(status);
};

var _exit = exitJS;

var _fd_close = fd => 52;

var _fd_read = (fd, iov, iovcnt, pnum) => 52;

function _fd_seek(fd, offset, whence, newOffset) {
  offset = bigintToI53Checked(offset);
  return 70;
}

var printCharBuffers = [ null, [], [] ];

/**
   * Given a pointer 'idx' to a null-terminated UTF8-encoded string in the given
   * array that contains uint8 values, returns a copy of that string as a
   * Javascript String object.
   * heapOrArray is either a regular array, or a JavaScript typed array view.
   * @param {number=} idx
   * @param {number=} maxBytesToRead
   * @param {boolean=} ignoreNul - If true, the function will not stop on a NUL character.
   * @return {string}
   */ var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead, ignoreNul) => {
  var endPtr = findStringEnd(heapOrArray, idx, maxBytesToRead, ignoreNul);
  return UTF8Decoder.decode(heapOrArray.buffer ? heapOrArray.subarray(idx, endPtr) : new Uint8Array(heapOrArray.slice(idx, endPtr)));
};

var printChar = (stream, curr) => {
  var buffer = printCharBuffers[stream];
  if (curr === 0 || curr === 10) {
    (stream === 1 ? out : err)(UTF8ArrayToString(buffer));
    buffer.length = 0;
  } else {
    buffer.push(curr);
  }
};

var _fd_write = (fd, iov, iovcnt, pnum) => {
  // hack to support printf in SYSCALLS_REQUIRE_FILESYSTEM=0
  var num = 0;
  for (var i = 0; i < iovcnt; i++) {
    var ptr = HEAPU32[((iov) >> 2)];
    var len = HEAPU32[(((iov) + (4)) >> 2)];
    iov += 8;
    for (var j = 0; j < len; j++) {
      printChar(fd, HEAPU8[ptr + j]);
    }
    num += len;
  }
  HEAPU32[((pnum) >> 2)] = num;
  return 0;
};

/** @suppress{checkTypes} */ var getWasmTableEntry = funcPtr => wasmTable.get(funcPtr);

// End JS library code
// include: postlibrary.js
// This file is included after the automatically-generated JS library code
// but before the wasm module is created.
{
  // Begin ATMODULES hooks
  if (Module["noExitRuntime"]) noExitRuntime = Module["noExitRuntime"];
  if (Module["print"]) out = Module["print"];
  if (Module["printErr"]) err = Module["printErr"];
  if (Module["wasmBinary"]) wasmBinary = Module["wasmBinary"];
  // End ATMODULES hooks
  if (Module["arguments"]) arguments_ = Module["arguments"];
  if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
  if (Module["preInit"]) {
    if (typeof Module["preInit"] == "function") Module["preInit"] = [ Module["preInit"] ];
    while (Module["preInit"].length > 0) {
      Module["preInit"].shift()();
    }
  }
}

// Begin runtime exports
Module["UTF8ToString"] = UTF8ToString;

Module["stringToUTF8"] = stringToUTF8;

Module["lengthBytesUTF8"] = lengthBytesUTF8;

// End runtime exports
// Begin JS library exports
// End JS library exports
// end include: postlibrary.js
var ASM_CONSTS = {
  6111476: () => {
    throw "TRYLATER";
  },
  6111498: () => {
    throw "ABORT";
  },
  6111517: $0 => {
    throw new Error(UTF8ToString($0));
  },
  6111556: () => {
    throw new Error("Cannot create MuPDF context!");
  },
  6111609: ($0, $1, $2, $3, $4, $5, $6) => {
    globalThis.$libmupdf_text_walk.begin_span($0, $1, $2, $3, $4, $5, $6);
  },
  6111683: ($0, $1, $2, $3, $4, $5, $6, $7) => {
    globalThis.$libmupdf_text_walk.show_glyph($0, $1, $2, $3, $4, $5, $6, $7);
  },
  6111761: $0 => {
    globalThis.$libmupdf_text_walk.end_span($0);
  },
  6111809: ($0, $1, $2, $3) => globalThis.$libmupdf_load_font_file($0, $1, $2, $3),
  6111872: ($0, $1, $2, $3) => globalThis.$libmupdf_stm_read($0, $1, $2, $3),
  6111930: $0 => {
    globalThis.$libmupdf_stm_close($0);
  },
  6111970: ($0, $1, $2, $3) => globalThis.$libmupdf_stm_seek($0, $1, $2, $3),
  6112028: ($0, $1, $2) => {
    globalThis.$libmupdf_path_walk.moveto($0, $1, $2);
  },
  6112082: ($0, $1, $2) => {
    globalThis.$libmupdf_path_walk.lineto($0, $1, $2);
  },
  6112136: ($0, $1, $2, $3, $4, $5, $6) => {
    globalThis.$libmupdf_path_walk.curveto($0, $1, $2, $3, $4, $5, $6);
  },
  6112207: $0 => {
    globalThis.$libmupdf_path_walk.closepath($0);
  },
  6112256: $0 => {
    globalThis.$libmupdf_log_error($0);
  },
  6112295: $0 => {
    globalThis.$libmupdf_log_warning($0);
  },
  6112336: $0 => {
    globalThis.$libmupdf_device.close_device($0);
  },
  6112385: $0 => {
    globalThis.$libmupdf_device.drop_device($0);
  },
  6112433: ($0, $1, $2, $3, $4, $5, $6, $7) => {
    globalThis.$libmupdf_device.fill_path($0, $1, $2, $3, $4, $5, $6, $7);
  },
  6112507: ($0, $1, $2, $3, $4, $5, $6, $7) => {
    globalThis.$libmupdf_device.stroke_path($0, $1, $2, $3, $4, $5, $6, $7);
  },
  6112583: ($0, $1, $2, $3) => {
    globalThis.$libmupdf_device.clip_path($0, $1, $2, $3);
  },
  6112641: ($0, $1, $2, $3) => {
    globalThis.$libmupdf_device.clip_stroke_path($0, $1, $2, $3);
  },
  6112706: ($0, $1, $2, $3, $4, $5, $6) => {
    globalThis.$libmupdf_device.fill_text($0, $1, $2, $3, $4, $5, $6);
  },
  6112776: ($0, $1, $2, $3, $4, $5, $6, $7) => {
    globalThis.$libmupdf_device.stroke_text($0, $1, $2, $3, $4, $5, $6, $7);
  },
  6112852: ($0, $1, $2) => {
    globalThis.$libmupdf_device.clip_text($0, $1, $2);
  },
  6112906: ($0, $1, $2, $3) => {
    globalThis.$libmupdf_device.clip_stroke_text($0, $1, $2, $3);
  },
  6112971: ($0, $1, $2) => {
    globalThis.$libmupdf_device.ignore_text($0, $1, $2);
  },
  6113027: ($0, $1, $2, $3) => {
    globalThis.$libmupdf_device.fill_shade($0, $1, $2, $3);
  },
  6113086: ($0, $1, $2, $3) => {
    globalThis.$libmupdf_device.fill_image($0, $1, $2, $3);
  },
  6113145: ($0, $1, $2, $3, $4, $5, $6) => {
    globalThis.$libmupdf_device.fill_image_mask($0, $1, $2, $3, $4, $5, $6);
  },
  6113221: ($0, $1, $2) => {
    globalThis.$libmupdf_device.clip_image_mask($0, $1, $2);
  },
  6113281: $0 => {
    globalThis.$libmupdf_device.pop_clip($0);
  },
  6113326: ($0, $1, $2, $3, $4, $5) => {
    globalThis.$libmupdf_device.begin_mask($0, $1, $2, $3, $4, $5);
  },
  6113393: ($0, $1) => {
    globalThis.$libmupdf_device.end_mask($0, $1);
  },
  6113442: ($0, $1, $2, $3, $4, $5, $6) => {
    globalThis.$libmupdf_device.begin_group($0, $1, $2, $3, $4, $5, $6);
  },
  6113514: $0 => {
    globalThis.$libmupdf_device.end_group($0);
  },
  6113560: ($0, $1, $2, $3, $4, $5, $6) => globalThis.$libmupdf_device.begin_tile($0, $1, $2, $3, $4, $5, $6),
  6113638: $0 => {
    globalThis.$libmupdf_device.end_tile($0);
  },
  6113683: ($0, $1) => {
    globalThis.$libmupdf_device.begin_layer($0, $1);
  },
  6113735: $0 => {
    globalThis.$libmupdf_device.end_layer($0);
  }
};

// Imports from the Wasm binary.
var _wasm_init_context, _wasm_malloc, _wasm_free, _wasm_enable_icc, _wasm_disable_icc, _wasm_set_user_css, _wasm_empty_store, _wasm_shrink_store, _wasm_Memento_checkAllMemory, _wasm_Memento_listBlocks, _wasm_keep_buffer, _wasm_drop_buffer, _wasm_keep_stream, _wasm_drop_stream, _wasm_keep_colorspace, _wasm_drop_colorspace, _wasm_keep_pixmap, _wasm_drop_pixmap, _wasm_keep_font, _wasm_drop_font, _wasm_keep_stroke_state, _wasm_drop_stroke_state, _wasm_keep_image, _wasm_drop_image, _wasm_keep_shade, _wasm_drop_shade, _wasm_keep_path, _wasm_drop_path, _wasm_keep_text, _wasm_drop_text, _wasm_keep_device, _wasm_drop_device, _wasm_keep_display_list, _wasm_drop_display_list, _wasm_drop_stext_page, _wasm_drop_document_writer, _wasm_drop_outline_iterator, _wasm_keep_document, _wasm_drop_document, _wasm_keep_page, _wasm_drop_page, _wasm_keep_link, _wasm_drop_link, _wasm_keep_outline, _wasm_drop_outline, _wasm_pdf_keep_annot, _wasm_pdf_drop_annot, _wasm_pdf_keep_obj, _wasm_pdf_drop_obj, _wasm_pdf_keep_graft_map, _wasm_pdf_drop_graft_map, _wasm_buffer_get_data, _wasm_buffer_get_len, _wasm_colorspace_get_type, _wasm_colorspace_get_n, _wasm_colorspace_get_name, _wasm_pixmap_get_w, _wasm_pixmap_get_h, _wasm_pixmap_get_x, _wasm_pixmap_get_y, _wasm_pixmap_get_n, _wasm_pixmap_get_stride, _wasm_pixmap_get_alpha, _wasm_pixmap_get_xres, _wasm_pixmap_get_yres, _wasm_pixmap_get_colorspace, _wasm_pixmap_get_samples, _wasm_pixmap_set_xres, _wasm_pixmap_set_yres, _wasm_font_get_name, _wasm_stroke_state_get_start_cap, _wasm_stroke_state_set_start_cap, _wasm_stroke_state_get_dash_cap, _wasm_stroke_state_set_dash_cap, _wasm_stroke_state_get_end_cap, _wasm_stroke_state_set_end_cap, _wasm_stroke_state_get_linejoin, _wasm_stroke_state_set_linejoin, _wasm_stroke_state_get_linewidth, _wasm_stroke_state_set_linewidth, _wasm_stroke_state_get_miterlimit, _wasm_stroke_state_set_miterlimit, _wasm_stroke_state_get_dash_phase, _wasm_stroke_state_set_dash_phase, _wasm_stroke_state_get_dash_len, _wasm_image_get_w, _wasm_image_get_h, _wasm_image_get_n, _wasm_image_get_bpc, _wasm_image_get_xres, _wasm_image_get_yres, _wasm_image_get_imagemask, _wasm_image_get_colorspace, _wasm_image_get_mask, _wasm_outline_get_title, _wasm_outline_get_uri, _wasm_outline_get_next, _wasm_outline_get_down, _wasm_outline_get_is_open, _wasm_outline_item_get_title, _wasm_outline_item_get_uri, _wasm_outline_item_get_is_open, _wasm_link_get_rect, _wasm_link_get_uri, _wasm_link_get_next, _wasm_stext_page_get_mediabox, _wasm_stext_page_get_first_block, _wasm_stext_block_get_next, _wasm_stext_block_get_type, _wasm_stext_block_get_bbox, _wasm_stext_block_get_first_line, _wasm_stext_block_get_transform, _wasm_stext_block_get_image, _wasm_stext_block_get_v_flags, _wasm_stext_block_get_v_argb, _wasm_stext_line_get_next, _wasm_stext_line_get_wmode, _wasm_stext_line_get_dir, _wasm_stext_line_get_bbox, _wasm_stext_line_get_first_char, _wasm_stext_char_get_next, _wasm_stext_char_get_c, _wasm_stext_char_get_origin, _wasm_stext_char_get_quad, _wasm_stext_char_get_size, _wasm_stext_char_get_font, _wasm_stext_char_get_argb, _wasm_stext_char_get_bidi, _wasm_link_dest_get_chapter, _wasm_link_dest_get_page, _wasm_link_dest_get_type, _wasm_link_dest_get_x, _wasm_link_dest_get_y, _wasm_link_dest_get_w, _wasm_link_dest_get_h, _wasm_link_dest_get_zoom, _wasm_pdf_layer_config_ui_get_text, _wasm_pdf_layer_config_ui_get_depth, _wasm_pdf_layer_config_ui_get_type, _wasm_pdf_layer_config_ui_get_selected, _wasm_pdf_layer_config_ui_get_locked, _wasm_pdf_filespec_params_get_filename, _wasm_pdf_filespec_params_get_mimetype, _wasm_pdf_filespec_params_get_size, _wasm_pdf_filespec_params_get_created, _wasm_pdf_filespec_params_get_modified, _wasm_pdf_page_get_obj, _wasm_new_buffer, _wasm_new_buffer_from_data, _wasm_append_string, _wasm_append_byte, _wasm_append_buffer, _wasm_slice_buffer, _wasm_string_from_buffer, _wasm_device_gray, _wasm_device_rgb, _wasm_device_bgr, _wasm_device_cmyk, _wasm_device_lab, _wasm_new_icc_colorspace, _wasm_new_stroke_state, _wasm_stroke_state_get_dash_item, _wasm_stroke_state_set_dash_item, _wasm_new_base14_font, _wasm_new_cjk_font, _wasm_new_font_from_buffer, _wasm_encode_character, _wasm_advance_glyph, _wasm_font_is_monospaced, _wasm_font_is_serif, _wasm_font_is_bold, _wasm_font_is_italic, _wasm_new_image_from_pixmap, _wasm_new_image_from_buffer, _wasm_get_pixmap_from_image, _wasm_new_pixmap_from_page, _wasm_new_pixmap_from_page_contents, _wasm_pdf_new_pixmap_from_page_with_usage, _wasm_pdf_new_pixmap_from_page_contents_with_usage, _wasm_new_pixmap_with_bbox, _wasm_clear_pixmap, _wasm_clear_pixmap_with_value, _wasm_invert_pixmap, _wasm_invert_pixmap_luminance, _wasm_gamma_pixmap, _wasm_tint_pixmap, _wasm_new_buffer_from_pixmap_as_png, _wasm_new_buffer_from_pixmap_as_pam, _wasm_new_buffer_from_pixmap_as_psd, _wasm_new_buffer_from_pixmap_as_jpeg, _wasm_convert_pixmap, _wasm_warp_pixmap, _wasm_bound_shade, _wasm_new_display_list, _wasm_bound_display_list, _wasm_run_display_list, _wasm_new_pixmap_from_display_list, _wasm_new_stext_page_from_display_list, _wasm_search_display_list, _wasm_new_path, _wasm_moveto, _wasm_lineto, _wasm_curveto, _wasm_curvetov, _wasm_curvetoy, _wasm_closepath, _wasm_rectto, _wasm_transform_path, _wasm_bound_path, _wasm_new_text, _wasm_bound_text, _wasm_show_glyph, _wasm_show_string, _wasm_new_draw_device, _wasm_new_display_list_device, _wasm_close_device, _wasm_fill_path, _wasm_stroke_path, _wasm_clip_path, _wasm_clip_stroke_path, _wasm_fill_text, _wasm_stroke_text, _wasm_clip_text, _wasm_clip_stroke_text, _wasm_ignore_text, _wasm_fill_shade, _wasm_fill_image, _wasm_fill_image_mask, _wasm_clip_image_mask, _wasm_pop_clip, _wasm_begin_mask, _wasm_end_mask, _wasm_begin_group, _wasm_end_group, _wasm_begin_tile, _wasm_end_tile, _wasm_begin_layer, _wasm_end_layer, _wasm_new_document_writer_with_buffer, _wasm_begin_page, _wasm_end_page, _wasm_close_document_writer, _wasm_print_stext_page_as_json, _wasm_search_stext_page, _wasm_snap_selection, _wasm_copy_selection, _wasm_highlight_selection, _wasm_print_stext_page_as_html, _wasm_print_stext_page_as_text, _wasm_open_document_with_buffer, _wasm_open_document_with_stream, _wasm_format_link_uri, _wasm_needs_password, _wasm_authenticate_password, _wasm_has_permission, _wasm_count_pages, _wasm_load_page, _wasm_lookup_metadata, _wasm_set_metadata, _wasm_resolve_link, _wasm_resolve_link_dest, _wasm_load_outline, _wasm_outline_get_page, _wasm_layout_document, _wasm_is_document_reflowable, _wasm_link_set_rect, _wasm_link_set_uri, _wasm_bound_page, _wasm_load_links, _wasm_create_link, _wasm_delete_link, _wasm_run_page, _wasm_run_page_contents, _wasm_run_page_annots, _wasm_run_page_widgets, _wasm_new_stext_page_from_page, _wasm_new_display_list_from_page, _wasm_new_display_list_from_page_contents, _wasm_page_label, _wasm_search_page, _wasm_new_outline_iterator, _wasm_outline_iterator_next, _wasm_outline_iterator_prev, _wasm_outline_iterator_up, _wasm_outline_iterator_down, _wasm_outline_iterator_delete, _wasm_outline_iterator_item, _wasm_outline_iterator_insert, _wasm_outline_iterator_update, _wasm_pdf_document_from_fz_document, _wasm_pdf_page_from_fz_page, _wasm_pdf_create_document, _wasm_pdf_version, _wasm_pdf_was_repaired, _wasm_pdf_has_unsaved_changes, _wasm_pdf_can_be_saved_incrementally, _wasm_pdf_count_versions, _wasm_pdf_count_unsaved_versions, _wasm_pdf_validate_change_history, _wasm_pdf_enable_journal, _wasm_pdf_undoredo_state_position, _wasm_pdf_undoredo_state_count, _wasm_pdf_undoredo_step, _wasm_pdf_begin_operation, _wasm_pdf_begin_implicit_operation, _wasm_pdf_end_operation, _wasm_pdf_abandon_operation, _wasm_pdf_undo, _wasm_pdf_redo, _wasm_pdf_can_undo, _wasm_pdf_can_redo, _wasm_pdf_document_language, _wasm_pdf_set_document_language, _wasm_pdf_trailer, _wasm_pdf_xref_len, _wasm_pdf_lookup_page_obj, _wasm_pdf_add_object, _wasm_pdf_create_object, _wasm_pdf_delete_object, _wasm_pdf_add_stream, _wasm_pdf_add_simple_font, _wasm_pdf_add_cjk_font, _wasm_pdf_add_cid_font, _wasm_pdf_add_image, _wasm_pdf_load_image, _wasm_pdf_set_page_tree_cache, _wasm_pdf_add_page, _wasm_pdf_insert_page, _wasm_pdf_delete_page, _wasm_pdf_set_page_labels, _wasm_pdf_delete_page_labels, _wasm_pdf_is_embedded_file, _wasm_pdf_get_filespec_params, _wasm_pdf_add_embedded_file, _wasm_pdf_load_embedded_file_contents, _wasm_pdf_write_document_buffer, _wasm_pdf_js_supported, _wasm_pdf_enable_js, _wasm_pdf_disable_js, _wasm_pdf_rearrange_pages, _wasm_pdf_subset_fonts, _wasm_pdf_bake_document, _wasm_pdf_count_layer_configs, _wasm_pdf_layer_config_creator, _wasm_pdf_layer_config_name, _wasm_pdf_select_layer_config, _wasm_pdf_count_layer_config_uis, _wasm_pdf_layer_config_ui_info, _wasm_pdf_count_layers, _wasm_pdf_layer_name, _wasm_pdf_layer_is_enabled, _wasm_pdf_enable_layer, _wasm_pdf_page_transform, _wasm_pdf_set_page_box, _wasm_pdf_first_annot, _wasm_pdf_next_annot, _wasm_pdf_first_widget, _wasm_pdf_next_widget, _wasm_pdf_create_annot, _wasm_pdf_delete_annot, _wasm_pdf_update_page, _wasm_pdf_redact_page, _wasm_pdf_new_graft_map, _wasm_pdf_graft_mapped_object, _wasm_pdf_graft_object, _wasm_pdf_graft_mapped_page, _wasm_pdf_graft_page, _wasm_pdf_bound_annot, _wasm_pdf_run_annot, _wasm_pdf_new_pixmap_from_annot, _wasm_pdf_new_display_list_from_annot, _wasm_pdf_update_annot, _wasm_pdf_annot_obj, _wasm_pdf_annot_type, _wasm_pdf_annot_flags, _wasm_pdf_set_annot_flags, _wasm_pdf_annot_contents, _wasm_pdf_set_annot_contents, _wasm_pdf_annot_name, _wasm_pdf_set_annot_name, _wasm_pdf_annot_author, _wasm_pdf_set_annot_author, _wasm_pdf_annot_subject, _wasm_pdf_set_annot_subject, _wasm_pdf_annot_creation_date, _wasm_pdf_set_annot_creation_date, _wasm_pdf_annot_modification_date, _wasm_pdf_set_annot_modification_date, _wasm_pdf_annot_border_width, _wasm_pdf_set_annot_border_width, _wasm_pdf_annot_border_style, _wasm_pdf_set_annot_border_style, _wasm_pdf_annot_border_effect, _wasm_pdf_set_annot_border_effect, _wasm_pdf_annot_border_effect_intensity, _wasm_pdf_set_annot_border_effect_intensity, _wasm_pdf_annot_opacity, _wasm_pdf_set_annot_opacity, _wasm_pdf_annot_filespec, _wasm_pdf_set_annot_filespec, _wasm_pdf_annot_quadding, _wasm_pdf_set_annot_quadding, _wasm_pdf_annot_is_open, _wasm_pdf_set_annot_is_open, _wasm_pdf_annot_hidden_for_editing, _wasm_pdf_set_annot_hidden_for_editing, _wasm_pdf_annot_icon_name, _wasm_pdf_set_annot_icon_name, _wasm_pdf_annot_intent, _wasm_pdf_set_annot_intent, _wasm_pdf_annot_callout_style, _wasm_pdf_set_annot_callout_style, _wasm_pdf_annot_line_leader, _wasm_pdf_set_annot_line_leader, _wasm_pdf_annot_line_leader_extension, _wasm_pdf_set_annot_line_leader_extension, _wasm_pdf_annot_line_leader_offset, _wasm_pdf_set_annot_line_leader_offset, _wasm_pdf_annot_line_caption, _wasm_pdf_set_annot_line_caption, _wasm_pdf_annot_rich_defaults, _wasm_pdf_set_annot_rich_defaults, _wasm_pdf_annot_callout_point, _wasm_pdf_annot_line_caption_offset, _wasm_pdf_annot_rect, _wasm_pdf_annot_popup, _wasm_pdf_annot_quad_point_count, _wasm_pdf_annot_quad_point, _wasm_pdf_annot_vertex_count, _wasm_pdf_annot_vertex, _wasm_pdf_annot_ink_list_count, _wasm_pdf_annot_ink_list_stroke_count, _wasm_pdf_annot_ink_list_stroke_vertex, _wasm_pdf_annot_rich_contents, _wasm_pdf_annot_border_dash_count, _wasm_pdf_annot_border_dash_item, _wasm_pdf_annot_has_rect, _wasm_pdf_annot_has_ink_list, _wasm_pdf_annot_has_quad_points, _wasm_pdf_annot_has_vertices, _wasm_pdf_annot_has_line, _wasm_pdf_annot_has_interior_color, _wasm_pdf_annot_has_line_ending_styles, _wasm_pdf_annot_has_border, _wasm_pdf_annot_has_border_effect, _wasm_pdf_annot_has_icon_name, _wasm_pdf_annot_has_open, _wasm_pdf_annot_has_author, _wasm_pdf_annot_has_subject, _wasm_pdf_annot_has_filespec, _wasm_pdf_annot_has_callout, _wasm_pdf_annot_has_rich_contents, _wasm_pdf_annot_language, _wasm_pdf_set_annot_language, _wasm_pdf_set_annot_popup, _wasm_pdf_set_annot_rect, _wasm_pdf_clear_annot_quad_points, _wasm_pdf_clear_annot_vertices, _wasm_pdf_clear_annot_ink_list, _wasm_pdf_clear_annot_border_dash, _wasm_pdf_add_annot_quad_point, _wasm_pdf_add_annot_vertex, _wasm_pdf_add_annot_ink_list_stroke, _wasm_pdf_add_annot_ink_list_stroke_vertex, _wasm_pdf_add_annot_border_dash_item, _wasm_pdf_annot_line_ending_styles_start, _wasm_pdf_annot_line_1, _wasm_pdf_annot_line_2, _wasm_pdf_set_annot_line, _wasm_pdf_set_annot_callout_point, _wasm_pdf_annot_callout_line, _wasm_pdf_set_annot_callout_line, _wasm_pdf_set_annot_line_caption_offset, _wasm_pdf_annot_line_ending_styles_end, _wasm_pdf_set_annot_line_ending_styles, _wasm_pdf_annot_color, _wasm_pdf_annot_interior_color, _wasm_pdf_set_annot_color, _wasm_pdf_set_annot_interior_color, _wasm_pdf_set_annot_default_appearance, _wasm_pdf_annot_default_appearance_font, _wasm_pdf_annot_default_appearance_size, _wasm_pdf_annot_default_appearance_color, _wasm_pdf_set_annot_rich_contents, _wasm_pdf_set_annot_stamp_image, _wasm_pdf_set_annot_appearance_from_display_list, _wasm_pdf_set_annot_appearance, _wasm_pdf_apply_redaction, _wasm_pdf_reset_form, _wasm_pdf_annot_field_type, _wasm_pdf_annot_field_flags, _wasm_pdf_annot_field_label, _wasm_pdf_annot_field_value, _wasm_pdf_load_field_name, _wasm_pdf_annot_text_widget_max_len, _wasm_pdf_set_annot_text_field_value, _wasm_pdf_set_annot_choice_field_value, _wasm_pdf_annot_choice_field_option_count, _wasm_pdf_annot_choice_field_option, _wasm_pdf_toggle_widget, _wasm_pdf_is_indirect, _wasm_pdf_is_bool, _wasm_pdf_is_int, _wasm_pdf_is_real, _wasm_pdf_is_number, _wasm_pdf_is_name, _wasm_pdf_is_string, _wasm_pdf_is_array, _wasm_pdf_is_dict, _wasm_pdf_is_stream, _wasm_pdf_to_num, _wasm_pdf_to_bool, _wasm_pdf_to_real, _wasm_pdf_to_name, _wasm_pdf_to_text_string, _wasm_pdf_new_indirect, _wasm_pdf_new_array, _wasm_pdf_new_dict, _wasm_pdf_new_bool, _wasm_pdf_new_int, _wasm_pdf_new_real, _wasm_pdf_new_name, _wasm_pdf_new_text_string, _wasm_pdf_new_string, _wasm_pdf_resolve_indirect, _wasm_pdf_array_len, _wasm_pdf_array_get, _wasm_pdf_dict_get, _wasm_pdf_dict_len, _wasm_pdf_dict_get_key, _wasm_pdf_dict_get_val, _wasm_pdf_dict_get_inheritable, _wasm_pdf_dict_gets, _wasm_pdf_dict_gets_inheritable, _wasm_pdf_dict_put, _wasm_pdf_dict_puts, _wasm_pdf_dict_del, _wasm_pdf_dict_dels, _wasm_pdf_array_put, _wasm_pdf_array_push, _wasm_pdf_array_delete, _wasm_pdf_sprint_obj, _wasm_pdf_load_stream, _wasm_pdf_load_raw_stream, _wasm_pdf_update_object, _wasm_pdf_update_stream, _wasm_pdf_to_string, _wasm_new_stream, _wasm_walk_path, _wasm_walk_text, _wasm_enable_log_callback, _wasm_new_js_device, _setThrew, __emscripten_stack_restore, _emscripten_stack_get_current, memory, __indirect_function_table, wasmMemory, wasmTable;

function assignWasmExports(wasmExports) {
  _wasm_init_context = Module["_wasm_init_context"] = wasmExports["eb"];
  _wasm_malloc = Module["_wasm_malloc"] = wasmExports["fb"];
  _wasm_free = Module["_wasm_free"] = wasmExports["gb"];
  _wasm_enable_icc = Module["_wasm_enable_icc"] = wasmExports["hb"];
  _wasm_disable_icc = Module["_wasm_disable_icc"] = wasmExports["ib"];
  _wasm_set_user_css = Module["_wasm_set_user_css"] = wasmExports["jb"];
  _wasm_empty_store = Module["_wasm_empty_store"] = wasmExports["kb"];
  _wasm_shrink_store = Module["_wasm_shrink_store"] = wasmExports["lb"];
  _wasm_Memento_checkAllMemory = Module["_wasm_Memento_checkAllMemory"] = wasmExports["mb"];
  _wasm_Memento_listBlocks = Module["_wasm_Memento_listBlocks"] = wasmExports["nb"];
  _wasm_keep_buffer = Module["_wasm_keep_buffer"] = wasmExports["ob"];
  _wasm_drop_buffer = Module["_wasm_drop_buffer"] = wasmExports["pb"];
  _wasm_keep_stream = Module["_wasm_keep_stream"] = wasmExports["qb"];
  _wasm_drop_stream = Module["_wasm_drop_stream"] = wasmExports["rb"];
  _wasm_keep_colorspace = Module["_wasm_keep_colorspace"] = wasmExports["sb"];
  _wasm_drop_colorspace = Module["_wasm_drop_colorspace"] = wasmExports["tb"];
  _wasm_keep_pixmap = Module["_wasm_keep_pixmap"] = wasmExports["ub"];
  _wasm_drop_pixmap = Module["_wasm_drop_pixmap"] = wasmExports["vb"];
  _wasm_keep_font = Module["_wasm_keep_font"] = wasmExports["wb"];
  _wasm_drop_font = Module["_wasm_drop_font"] = wasmExports["xb"];
  _wasm_keep_stroke_state = Module["_wasm_keep_stroke_state"] = wasmExports["yb"];
  _wasm_drop_stroke_state = Module["_wasm_drop_stroke_state"] = wasmExports["zb"];
  _wasm_keep_image = Module["_wasm_keep_image"] = wasmExports["Ab"];
  _wasm_drop_image = Module["_wasm_drop_image"] = wasmExports["Bb"];
  _wasm_keep_shade = Module["_wasm_keep_shade"] = wasmExports["Cb"];
  _wasm_drop_shade = Module["_wasm_drop_shade"] = wasmExports["Db"];
  _wasm_keep_path = Module["_wasm_keep_path"] = wasmExports["Eb"];
  _wasm_drop_path = Module["_wasm_drop_path"] = wasmExports["Fb"];
  _wasm_keep_text = Module["_wasm_keep_text"] = wasmExports["Gb"];
  _wasm_drop_text = Module["_wasm_drop_text"] = wasmExports["Hb"];
  _wasm_keep_device = Module["_wasm_keep_device"] = wasmExports["Ib"];
  _wasm_drop_device = Module["_wasm_drop_device"] = wasmExports["Jb"];
  _wasm_keep_display_list = Module["_wasm_keep_display_list"] = wasmExports["Kb"];
  _wasm_drop_display_list = Module["_wasm_drop_display_list"] = wasmExports["Lb"];
  _wasm_drop_stext_page = Module["_wasm_drop_stext_page"] = wasmExports["Mb"];
  _wasm_drop_document_writer = Module["_wasm_drop_document_writer"] = wasmExports["Nb"];
  _wasm_drop_outline_iterator = Module["_wasm_drop_outline_iterator"] = wasmExports["Ob"];
  _wasm_keep_document = Module["_wasm_keep_document"] = wasmExports["Pb"];
  _wasm_drop_document = Module["_wasm_drop_document"] = wasmExports["Qb"];
  _wasm_keep_page = Module["_wasm_keep_page"] = wasmExports["Rb"];
  _wasm_drop_page = Module["_wasm_drop_page"] = wasmExports["Sb"];
  _wasm_keep_link = Module["_wasm_keep_link"] = wasmExports["Tb"];
  _wasm_drop_link = Module["_wasm_drop_link"] = wasmExports["Ub"];
  _wasm_keep_outline = Module["_wasm_keep_outline"] = wasmExports["Vb"];
  _wasm_drop_outline = Module["_wasm_drop_outline"] = wasmExports["Wb"];
  _wasm_pdf_keep_annot = Module["_wasm_pdf_keep_annot"] = wasmExports["Xb"];
  _wasm_pdf_drop_annot = Module["_wasm_pdf_drop_annot"] = wasmExports["Yb"];
  _wasm_pdf_keep_obj = Module["_wasm_pdf_keep_obj"] = wasmExports["Zb"];
  _wasm_pdf_drop_obj = Module["_wasm_pdf_drop_obj"] = wasmExports["_b"];
  _wasm_pdf_keep_graft_map = Module["_wasm_pdf_keep_graft_map"] = wasmExports["$b"];
  _wasm_pdf_drop_graft_map = Module["_wasm_pdf_drop_graft_map"] = wasmExports["ac"];
  _wasm_buffer_get_data = Module["_wasm_buffer_get_data"] = wasmExports["bc"];
  _wasm_buffer_get_len = Module["_wasm_buffer_get_len"] = wasmExports["cc"];
  _wasm_colorspace_get_type = Module["_wasm_colorspace_get_type"] = wasmExports["dc"];
  _wasm_colorspace_get_n = Module["_wasm_colorspace_get_n"] = wasmExports["ec"];
  _wasm_colorspace_get_name = Module["_wasm_colorspace_get_name"] = wasmExports["fc"];
  _wasm_pixmap_get_w = Module["_wasm_pixmap_get_w"] = wasmExports["gc"];
  _wasm_pixmap_get_h = Module["_wasm_pixmap_get_h"] = wasmExports["hc"];
  _wasm_pixmap_get_x = Module["_wasm_pixmap_get_x"] = wasmExports["ic"];
  _wasm_pixmap_get_y = Module["_wasm_pixmap_get_y"] = wasmExports["jc"];
  _wasm_pixmap_get_n = Module["_wasm_pixmap_get_n"] = wasmExports["kc"];
  _wasm_pixmap_get_stride = Module["_wasm_pixmap_get_stride"] = wasmExports["lc"];
  _wasm_pixmap_get_alpha = Module["_wasm_pixmap_get_alpha"] = wasmExports["mc"];
  _wasm_pixmap_get_xres = Module["_wasm_pixmap_get_xres"] = wasmExports["nc"];
  _wasm_pixmap_get_yres = Module["_wasm_pixmap_get_yres"] = wasmExports["oc"];
  _wasm_pixmap_get_colorspace = Module["_wasm_pixmap_get_colorspace"] = wasmExports["pc"];
  _wasm_pixmap_get_samples = Module["_wasm_pixmap_get_samples"] = wasmExports["qc"];
  _wasm_pixmap_set_xres = Module["_wasm_pixmap_set_xres"] = wasmExports["rc"];
  _wasm_pixmap_set_yres = Module["_wasm_pixmap_set_yres"] = wasmExports["sc"];
  _wasm_font_get_name = Module["_wasm_font_get_name"] = wasmExports["tc"];
  _wasm_stroke_state_get_start_cap = Module["_wasm_stroke_state_get_start_cap"] = wasmExports["uc"];
  _wasm_stroke_state_set_start_cap = Module["_wasm_stroke_state_set_start_cap"] = wasmExports["vc"];
  _wasm_stroke_state_get_dash_cap = Module["_wasm_stroke_state_get_dash_cap"] = wasmExports["wc"];
  _wasm_stroke_state_set_dash_cap = Module["_wasm_stroke_state_set_dash_cap"] = wasmExports["xc"];
  _wasm_stroke_state_get_end_cap = Module["_wasm_stroke_state_get_end_cap"] = wasmExports["yc"];
  _wasm_stroke_state_set_end_cap = Module["_wasm_stroke_state_set_end_cap"] = wasmExports["zc"];
  _wasm_stroke_state_get_linejoin = Module["_wasm_stroke_state_get_linejoin"] = wasmExports["Ac"];
  _wasm_stroke_state_set_linejoin = Module["_wasm_stroke_state_set_linejoin"] = wasmExports["Bc"];
  _wasm_stroke_state_get_linewidth = Module["_wasm_stroke_state_get_linewidth"] = wasmExports["Cc"];
  _wasm_stroke_state_set_linewidth = Module["_wasm_stroke_state_set_linewidth"] = wasmExports["Dc"];
  _wasm_stroke_state_get_miterlimit = Module["_wasm_stroke_state_get_miterlimit"] = wasmExports["Ec"];
  _wasm_stroke_state_set_miterlimit = Module["_wasm_stroke_state_set_miterlimit"] = wasmExports["Fc"];
  _wasm_stroke_state_get_dash_phase = Module["_wasm_stroke_state_get_dash_phase"] = wasmExports["Gc"];
  _wasm_stroke_state_set_dash_phase = Module["_wasm_stroke_state_set_dash_phase"] = wasmExports["Hc"];
  _wasm_stroke_state_get_dash_len = Module["_wasm_stroke_state_get_dash_len"] = wasmExports["Ic"];
  _wasm_image_get_w = Module["_wasm_image_get_w"] = wasmExports["Jc"];
  _wasm_image_get_h = Module["_wasm_image_get_h"] = wasmExports["Kc"];
  _wasm_image_get_n = Module["_wasm_image_get_n"] = wasmExports["Lc"];
  _wasm_image_get_bpc = Module["_wasm_image_get_bpc"] = wasmExports["Mc"];
  _wasm_image_get_xres = Module["_wasm_image_get_xres"] = wasmExports["Nc"];
  _wasm_image_get_yres = Module["_wasm_image_get_yres"] = wasmExports["Oc"];
  _wasm_image_get_imagemask = Module["_wasm_image_get_imagemask"] = wasmExports["Pc"];
  _wasm_image_get_colorspace = Module["_wasm_image_get_colorspace"] = wasmExports["Qc"];
  _wasm_image_get_mask = Module["_wasm_image_get_mask"] = wasmExports["Rc"];
  _wasm_outline_get_title = Module["_wasm_outline_get_title"] = wasmExports["Sc"];
  _wasm_outline_get_uri = Module["_wasm_outline_get_uri"] = wasmExports["Tc"];
  _wasm_outline_get_next = Module["_wasm_outline_get_next"] = wasmExports["Uc"];
  _wasm_outline_get_down = Module["_wasm_outline_get_down"] = wasmExports["Vc"];
  _wasm_outline_get_is_open = Module["_wasm_outline_get_is_open"] = wasmExports["Wc"];
  _wasm_outline_item_get_title = Module["_wasm_outline_item_get_title"] = wasmExports["Xc"];
  _wasm_outline_item_get_uri = Module["_wasm_outline_item_get_uri"] = wasmExports["Yc"];
  _wasm_outline_item_get_is_open = Module["_wasm_outline_item_get_is_open"] = wasmExports["Zc"];
  _wasm_link_get_rect = Module["_wasm_link_get_rect"] = wasmExports["_c"];
  _wasm_link_get_uri = Module["_wasm_link_get_uri"] = wasmExports["$c"];
  _wasm_link_get_next = Module["_wasm_link_get_next"] = wasmExports["ad"];
  _wasm_stext_page_get_mediabox = Module["_wasm_stext_page_get_mediabox"] = wasmExports["bd"];
  _wasm_stext_page_get_first_block = Module["_wasm_stext_page_get_first_block"] = wasmExports["cd"];
  _wasm_stext_block_get_next = Module["_wasm_stext_block_get_next"] = wasmExports["dd"];
  _wasm_stext_block_get_type = Module["_wasm_stext_block_get_type"] = wasmExports["ed"];
  _wasm_stext_block_get_bbox = Module["_wasm_stext_block_get_bbox"] = wasmExports["fd"];
  _wasm_stext_block_get_first_line = Module["_wasm_stext_block_get_first_line"] = wasmExports["gd"];
  _wasm_stext_block_get_transform = Module["_wasm_stext_block_get_transform"] = wasmExports["hd"];
  _wasm_stext_block_get_image = Module["_wasm_stext_block_get_image"] = wasmExports["id"];
  _wasm_stext_block_get_v_flags = Module["_wasm_stext_block_get_v_flags"] = wasmExports["jd"];
  _wasm_stext_block_get_v_argb = Module["_wasm_stext_block_get_v_argb"] = wasmExports["kd"];
  _wasm_stext_line_get_next = Module["_wasm_stext_line_get_next"] = wasmExports["ld"];
  _wasm_stext_line_get_wmode = Module["_wasm_stext_line_get_wmode"] = wasmExports["md"];
  _wasm_stext_line_get_dir = Module["_wasm_stext_line_get_dir"] = wasmExports["nd"];
  _wasm_stext_line_get_bbox = Module["_wasm_stext_line_get_bbox"] = wasmExports["od"];
  _wasm_stext_line_get_first_char = Module["_wasm_stext_line_get_first_char"] = wasmExports["pd"];
  _wasm_stext_char_get_next = Module["_wasm_stext_char_get_next"] = wasmExports["qd"];
  _wasm_stext_char_get_c = Module["_wasm_stext_char_get_c"] = wasmExports["rd"];
  _wasm_stext_char_get_origin = Module["_wasm_stext_char_get_origin"] = wasmExports["sd"];
  _wasm_stext_char_get_quad = Module["_wasm_stext_char_get_quad"] = wasmExports["td"];
  _wasm_stext_char_get_size = Module["_wasm_stext_char_get_size"] = wasmExports["ud"];
  _wasm_stext_char_get_font = Module["_wasm_stext_char_get_font"] = wasmExports["vd"];
  _wasm_stext_char_get_argb = Module["_wasm_stext_char_get_argb"] = wasmExports["wd"];
  _wasm_stext_char_get_bidi = Module["_wasm_stext_char_get_bidi"] = wasmExports["xd"];
  _wasm_link_dest_get_chapter = Module["_wasm_link_dest_get_chapter"] = wasmExports["yd"];
  _wasm_link_dest_get_page = Module["_wasm_link_dest_get_page"] = wasmExports["zd"];
  _wasm_link_dest_get_type = Module["_wasm_link_dest_get_type"] = wasmExports["Ad"];
  _wasm_link_dest_get_x = Module["_wasm_link_dest_get_x"] = wasmExports["Bd"];
  _wasm_link_dest_get_y = Module["_wasm_link_dest_get_y"] = wasmExports["Cd"];
  _wasm_link_dest_get_w = Module["_wasm_link_dest_get_w"] = wasmExports["Dd"];
  _wasm_link_dest_get_h = Module["_wasm_link_dest_get_h"] = wasmExports["Ed"];
  _wasm_link_dest_get_zoom = Module["_wasm_link_dest_get_zoom"] = wasmExports["Fd"];
  _wasm_pdf_layer_config_ui_get_text = Module["_wasm_pdf_layer_config_ui_get_text"] = wasmExports["Gd"];
  _wasm_pdf_layer_config_ui_get_depth = Module["_wasm_pdf_layer_config_ui_get_depth"] = wasmExports["Hd"];
  _wasm_pdf_layer_config_ui_get_type = Module["_wasm_pdf_layer_config_ui_get_type"] = wasmExports["Id"];
  _wasm_pdf_layer_config_ui_get_selected = Module["_wasm_pdf_layer_config_ui_get_selected"] = wasmExports["Jd"];
  _wasm_pdf_layer_config_ui_get_locked = Module["_wasm_pdf_layer_config_ui_get_locked"] = wasmExports["Kd"];
  _wasm_pdf_filespec_params_get_filename = Module["_wasm_pdf_filespec_params_get_filename"] = wasmExports["Ld"];
  _wasm_pdf_filespec_params_get_mimetype = Module["_wasm_pdf_filespec_params_get_mimetype"] = wasmExports["Md"];
  _wasm_pdf_filespec_params_get_size = Module["_wasm_pdf_filespec_params_get_size"] = wasmExports["Nd"];
  _wasm_pdf_filespec_params_get_created = Module["_wasm_pdf_filespec_params_get_created"] = wasmExports["Od"];
  _wasm_pdf_filespec_params_get_modified = Module["_wasm_pdf_filespec_params_get_modified"] = wasmExports["Pd"];
  _wasm_pdf_page_get_obj = Module["_wasm_pdf_page_get_obj"] = wasmExports["Qd"];
  _wasm_new_buffer = Module["_wasm_new_buffer"] = wasmExports["Rd"];
  _wasm_new_buffer_from_data = Module["_wasm_new_buffer_from_data"] = wasmExports["Sd"];
  _wasm_append_string = Module["_wasm_append_string"] = wasmExports["Td"];
  _wasm_append_byte = Module["_wasm_append_byte"] = wasmExports["Ud"];
  _wasm_append_buffer = Module["_wasm_append_buffer"] = wasmExports["Vd"];
  _wasm_slice_buffer = Module["_wasm_slice_buffer"] = wasmExports["Wd"];
  _wasm_string_from_buffer = Module["_wasm_string_from_buffer"] = wasmExports["Xd"];
  _wasm_device_gray = Module["_wasm_device_gray"] = wasmExports["Yd"];
  _wasm_device_rgb = Module["_wasm_device_rgb"] = wasmExports["Zd"];
  _wasm_device_bgr = Module["_wasm_device_bgr"] = wasmExports["_d"];
  _wasm_device_cmyk = Module["_wasm_device_cmyk"] = wasmExports["$d"];
  _wasm_device_lab = Module["_wasm_device_lab"] = wasmExports["ae"];
  _wasm_new_icc_colorspace = Module["_wasm_new_icc_colorspace"] = wasmExports["be"];
  _wasm_new_stroke_state = Module["_wasm_new_stroke_state"] = wasmExports["ce"];
  _wasm_stroke_state_get_dash_item = Module["_wasm_stroke_state_get_dash_item"] = wasmExports["de"];
  _wasm_stroke_state_set_dash_item = Module["_wasm_stroke_state_set_dash_item"] = wasmExports["ee"];
  _wasm_new_base14_font = Module["_wasm_new_base14_font"] = wasmExports["fe"];
  _wasm_new_cjk_font = Module["_wasm_new_cjk_font"] = wasmExports["ge"];
  _wasm_new_font_from_buffer = Module["_wasm_new_font_from_buffer"] = wasmExports["he"];
  _wasm_encode_character = Module["_wasm_encode_character"] = wasmExports["ie"];
  _wasm_advance_glyph = Module["_wasm_advance_glyph"] = wasmExports["je"];
  _wasm_font_is_monospaced = Module["_wasm_font_is_monospaced"] = wasmExports["ke"];
  _wasm_font_is_serif = Module["_wasm_font_is_serif"] = wasmExports["le"];
  _wasm_font_is_bold = Module["_wasm_font_is_bold"] = wasmExports["me"];
  _wasm_font_is_italic = Module["_wasm_font_is_italic"] = wasmExports["ne"];
  _wasm_new_image_from_pixmap = Module["_wasm_new_image_from_pixmap"] = wasmExports["oe"];
  _wasm_new_image_from_buffer = Module["_wasm_new_image_from_buffer"] = wasmExports["pe"];
  _wasm_get_pixmap_from_image = Module["_wasm_get_pixmap_from_image"] = wasmExports["qe"];
  _wasm_new_pixmap_from_page = Module["_wasm_new_pixmap_from_page"] = wasmExports["re"];
  _wasm_new_pixmap_from_page_contents = Module["_wasm_new_pixmap_from_page_contents"] = wasmExports["se"];
  _wasm_pdf_new_pixmap_from_page_with_usage = Module["_wasm_pdf_new_pixmap_from_page_with_usage"] = wasmExports["te"];
  _wasm_pdf_new_pixmap_from_page_contents_with_usage = Module["_wasm_pdf_new_pixmap_from_page_contents_with_usage"] = wasmExports["ue"];
  _wasm_new_pixmap_with_bbox = Module["_wasm_new_pixmap_with_bbox"] = wasmExports["ve"];
  _wasm_clear_pixmap = Module["_wasm_clear_pixmap"] = wasmExports["we"];
  _wasm_clear_pixmap_with_value = Module["_wasm_clear_pixmap_with_value"] = wasmExports["xe"];
  _wasm_invert_pixmap = Module["_wasm_invert_pixmap"] = wasmExports["ye"];
  _wasm_invert_pixmap_luminance = Module["_wasm_invert_pixmap_luminance"] = wasmExports["ze"];
  _wasm_gamma_pixmap = Module["_wasm_gamma_pixmap"] = wasmExports["Ae"];
  _wasm_tint_pixmap = Module["_wasm_tint_pixmap"] = wasmExports["Be"];
  _wasm_new_buffer_from_pixmap_as_png = Module["_wasm_new_buffer_from_pixmap_as_png"] = wasmExports["Ce"];
  _wasm_new_buffer_from_pixmap_as_pam = Module["_wasm_new_buffer_from_pixmap_as_pam"] = wasmExports["De"];
  _wasm_new_buffer_from_pixmap_as_psd = Module["_wasm_new_buffer_from_pixmap_as_psd"] = wasmExports["Ee"];
  _wasm_new_buffer_from_pixmap_as_jpeg = Module["_wasm_new_buffer_from_pixmap_as_jpeg"] = wasmExports["Fe"];
  _wasm_convert_pixmap = Module["_wasm_convert_pixmap"] = wasmExports["Ge"];
  _wasm_warp_pixmap = Module["_wasm_warp_pixmap"] = wasmExports["He"];
  _wasm_bound_shade = Module["_wasm_bound_shade"] = wasmExports["Ie"];
  _wasm_new_display_list = Module["_wasm_new_display_list"] = wasmExports["Je"];
  _wasm_bound_display_list = Module["_wasm_bound_display_list"] = wasmExports["Ke"];
  _wasm_run_display_list = Module["_wasm_run_display_list"] = wasmExports["Le"];
  _wasm_new_pixmap_from_display_list = Module["_wasm_new_pixmap_from_display_list"] = wasmExports["Me"];
  _wasm_new_stext_page_from_display_list = Module["_wasm_new_stext_page_from_display_list"] = wasmExports["Ne"];
  _wasm_search_display_list = Module["_wasm_search_display_list"] = wasmExports["Oe"];
  _wasm_new_path = Module["_wasm_new_path"] = wasmExports["Pe"];
  _wasm_moveto = Module["_wasm_moveto"] = wasmExports["Qe"];
  _wasm_lineto = Module["_wasm_lineto"] = wasmExports["Re"];
  _wasm_curveto = Module["_wasm_curveto"] = wasmExports["Se"];
  _wasm_curvetov = Module["_wasm_curvetov"] = wasmExports["Te"];
  _wasm_curvetoy = Module["_wasm_curvetoy"] = wasmExports["Ue"];
  _wasm_closepath = Module["_wasm_closepath"] = wasmExports["Ve"];
  _wasm_rectto = Module["_wasm_rectto"] = wasmExports["We"];
  _wasm_transform_path = Module["_wasm_transform_path"] = wasmExports["Xe"];
  _wasm_bound_path = Module["_wasm_bound_path"] = wasmExports["Ye"];
  _wasm_new_text = Module["_wasm_new_text"] = wasmExports["Ze"];
  _wasm_bound_text = Module["_wasm_bound_text"] = wasmExports["_e"];
  _wasm_show_glyph = Module["_wasm_show_glyph"] = wasmExports["$e"];
  _wasm_show_string = Module["_wasm_show_string"] = wasmExports["af"];
  _wasm_new_draw_device = Module["_wasm_new_draw_device"] = wasmExports["bf"];
  _wasm_new_display_list_device = Module["_wasm_new_display_list_device"] = wasmExports["cf"];
  _wasm_close_device = Module["_wasm_close_device"] = wasmExports["df"];
  _wasm_fill_path = Module["_wasm_fill_path"] = wasmExports["ef"];
  _wasm_stroke_path = Module["_wasm_stroke_path"] = wasmExports["ff"];
  _wasm_clip_path = Module["_wasm_clip_path"] = wasmExports["gf"];
  _wasm_clip_stroke_path = Module["_wasm_clip_stroke_path"] = wasmExports["hf"];
  _wasm_fill_text = Module["_wasm_fill_text"] = wasmExports["jf"];
  _wasm_stroke_text = Module["_wasm_stroke_text"] = wasmExports["kf"];
  _wasm_clip_text = Module["_wasm_clip_text"] = wasmExports["lf"];
  _wasm_clip_stroke_text = Module["_wasm_clip_stroke_text"] = wasmExports["mf"];
  _wasm_ignore_text = Module["_wasm_ignore_text"] = wasmExports["nf"];
  _wasm_fill_shade = Module["_wasm_fill_shade"] = wasmExports["of"];
  _wasm_fill_image = Module["_wasm_fill_image"] = wasmExports["pf"];
  _wasm_fill_image_mask = Module["_wasm_fill_image_mask"] = wasmExports["qf"];
  _wasm_clip_image_mask = Module["_wasm_clip_image_mask"] = wasmExports["rf"];
  _wasm_pop_clip = Module["_wasm_pop_clip"] = wasmExports["sf"];
  _wasm_begin_mask = Module["_wasm_begin_mask"] = wasmExports["tf"];
  _wasm_end_mask = Module["_wasm_end_mask"] = wasmExports["uf"];
  _wasm_begin_group = Module["_wasm_begin_group"] = wasmExports["vf"];
  _wasm_end_group = Module["_wasm_end_group"] = wasmExports["wf"];
  _wasm_begin_tile = Module["_wasm_begin_tile"] = wasmExports["xf"];
  _wasm_end_tile = Module["_wasm_end_tile"] = wasmExports["yf"];
  _wasm_begin_layer = Module["_wasm_begin_layer"] = wasmExports["zf"];
  _wasm_end_layer = Module["_wasm_end_layer"] = wasmExports["Af"];
  _wasm_new_document_writer_with_buffer = Module["_wasm_new_document_writer_with_buffer"] = wasmExports["Bf"];
  _wasm_begin_page = Module["_wasm_begin_page"] = wasmExports["Cf"];
  _wasm_end_page = Module["_wasm_end_page"] = wasmExports["Df"];
  _wasm_close_document_writer = Module["_wasm_close_document_writer"] = wasmExports["Ef"];
  _wasm_print_stext_page_as_json = Module["_wasm_print_stext_page_as_json"] = wasmExports["Ff"];
  _wasm_search_stext_page = Module["_wasm_search_stext_page"] = wasmExports["Gf"];
  _wasm_snap_selection = Module["_wasm_snap_selection"] = wasmExports["Hf"];
  _wasm_copy_selection = Module["_wasm_copy_selection"] = wasmExports["If"];
  _wasm_highlight_selection = Module["_wasm_highlight_selection"] = wasmExports["Jf"];
  _wasm_print_stext_page_as_html = Module["_wasm_print_stext_page_as_html"] = wasmExports["Kf"];
  _wasm_print_stext_page_as_text = Module["_wasm_print_stext_page_as_text"] = wasmExports["Lf"];
  _wasm_open_document_with_buffer = Module["_wasm_open_document_with_buffer"] = wasmExports["Mf"];
  _wasm_open_document_with_stream = Module["_wasm_open_document_with_stream"] = wasmExports["Nf"];
  _wasm_format_link_uri = Module["_wasm_format_link_uri"] = wasmExports["Of"];
  _wasm_needs_password = Module["_wasm_needs_password"] = wasmExports["Pf"];
  _wasm_authenticate_password = Module["_wasm_authenticate_password"] = wasmExports["Qf"];
  _wasm_has_permission = Module["_wasm_has_permission"] = wasmExports["Rf"];
  _wasm_count_pages = Module["_wasm_count_pages"] = wasmExports["Sf"];
  _wasm_load_page = Module["_wasm_load_page"] = wasmExports["Tf"];
  _wasm_lookup_metadata = Module["_wasm_lookup_metadata"] = wasmExports["Uf"];
  _wasm_set_metadata = Module["_wasm_set_metadata"] = wasmExports["Vf"];
  _wasm_resolve_link = Module["_wasm_resolve_link"] = wasmExports["Wf"];
  _wasm_resolve_link_dest = Module["_wasm_resolve_link_dest"] = wasmExports["Xf"];
  _wasm_load_outline = Module["_wasm_load_outline"] = wasmExports["Yf"];
  _wasm_outline_get_page = Module["_wasm_outline_get_page"] = wasmExports["Zf"];
  _wasm_layout_document = Module["_wasm_layout_document"] = wasmExports["_f"];
  _wasm_is_document_reflowable = Module["_wasm_is_document_reflowable"] = wasmExports["$f"];
  _wasm_link_set_rect = Module["_wasm_link_set_rect"] = wasmExports["ag"];
  _wasm_link_set_uri = Module["_wasm_link_set_uri"] = wasmExports["bg"];
  _wasm_bound_page = Module["_wasm_bound_page"] = wasmExports["cg"];
  _wasm_load_links = Module["_wasm_load_links"] = wasmExports["dg"];
  _wasm_create_link = Module["_wasm_create_link"] = wasmExports["eg"];
  _wasm_delete_link = Module["_wasm_delete_link"] = wasmExports["fg"];
  _wasm_run_page = Module["_wasm_run_page"] = wasmExports["gg"];
  _wasm_run_page_contents = Module["_wasm_run_page_contents"] = wasmExports["hg"];
  _wasm_run_page_annots = Module["_wasm_run_page_annots"] = wasmExports["ig"];
  _wasm_run_page_widgets = Module["_wasm_run_page_widgets"] = wasmExports["jg"];
  _wasm_new_stext_page_from_page = Module["_wasm_new_stext_page_from_page"] = wasmExports["kg"];
  _wasm_new_display_list_from_page = Module["_wasm_new_display_list_from_page"] = wasmExports["lg"];
  _wasm_new_display_list_from_page_contents = Module["_wasm_new_display_list_from_page_contents"] = wasmExports["mg"];
  _wasm_page_label = Module["_wasm_page_label"] = wasmExports["ng"];
  _wasm_search_page = Module["_wasm_search_page"] = wasmExports["og"];
  _wasm_new_outline_iterator = Module["_wasm_new_outline_iterator"] = wasmExports["pg"];
  _wasm_outline_iterator_next = Module["_wasm_outline_iterator_next"] = wasmExports["qg"];
  _wasm_outline_iterator_prev = Module["_wasm_outline_iterator_prev"] = wasmExports["rg"];
  _wasm_outline_iterator_up = Module["_wasm_outline_iterator_up"] = wasmExports["sg"];
  _wasm_outline_iterator_down = Module["_wasm_outline_iterator_down"] = wasmExports["tg"];
  _wasm_outline_iterator_delete = Module["_wasm_outline_iterator_delete"] = wasmExports["ug"];
  _wasm_outline_iterator_item = Module["_wasm_outline_iterator_item"] = wasmExports["vg"];
  _wasm_outline_iterator_insert = Module["_wasm_outline_iterator_insert"] = wasmExports["wg"];
  _wasm_outline_iterator_update = Module["_wasm_outline_iterator_update"] = wasmExports["xg"];
  _wasm_pdf_document_from_fz_document = Module["_wasm_pdf_document_from_fz_document"] = wasmExports["yg"];
  _wasm_pdf_page_from_fz_page = Module["_wasm_pdf_page_from_fz_page"] = wasmExports["zg"];
  _wasm_pdf_create_document = Module["_wasm_pdf_create_document"] = wasmExports["Ag"];
  _wasm_pdf_version = Module["_wasm_pdf_version"] = wasmExports["Bg"];
  _wasm_pdf_was_repaired = Module["_wasm_pdf_was_repaired"] = wasmExports["Cg"];
  _wasm_pdf_has_unsaved_changes = Module["_wasm_pdf_has_unsaved_changes"] = wasmExports["Dg"];
  _wasm_pdf_can_be_saved_incrementally = Module["_wasm_pdf_can_be_saved_incrementally"] = wasmExports["Eg"];
  _wasm_pdf_count_versions = Module["_wasm_pdf_count_versions"] = wasmExports["Fg"];
  _wasm_pdf_count_unsaved_versions = Module["_wasm_pdf_count_unsaved_versions"] = wasmExports["Gg"];
  _wasm_pdf_validate_change_history = Module["_wasm_pdf_validate_change_history"] = wasmExports["Hg"];
  _wasm_pdf_enable_journal = Module["_wasm_pdf_enable_journal"] = wasmExports["Ig"];
  _wasm_pdf_undoredo_state_position = Module["_wasm_pdf_undoredo_state_position"] = wasmExports["Jg"];
  _wasm_pdf_undoredo_state_count = Module["_wasm_pdf_undoredo_state_count"] = wasmExports["Kg"];
  _wasm_pdf_undoredo_step = Module["_wasm_pdf_undoredo_step"] = wasmExports["Lg"];
  _wasm_pdf_begin_operation = Module["_wasm_pdf_begin_operation"] = wasmExports["Mg"];
  _wasm_pdf_begin_implicit_operation = Module["_wasm_pdf_begin_implicit_operation"] = wasmExports["Ng"];
  _wasm_pdf_end_operation = Module["_wasm_pdf_end_operation"] = wasmExports["Og"];
  _wasm_pdf_abandon_operation = Module["_wasm_pdf_abandon_operation"] = wasmExports["Pg"];
  _wasm_pdf_undo = Module["_wasm_pdf_undo"] = wasmExports["Qg"];
  _wasm_pdf_redo = Module["_wasm_pdf_redo"] = wasmExports["Rg"];
  _wasm_pdf_can_undo = Module["_wasm_pdf_can_undo"] = wasmExports["Sg"];
  _wasm_pdf_can_redo = Module["_wasm_pdf_can_redo"] = wasmExports["Tg"];
  _wasm_pdf_document_language = Module["_wasm_pdf_document_language"] = wasmExports["Ug"];
  _wasm_pdf_set_document_language = Module["_wasm_pdf_set_document_language"] = wasmExports["Vg"];
  _wasm_pdf_trailer = Module["_wasm_pdf_trailer"] = wasmExports["Wg"];
  _wasm_pdf_xref_len = Module["_wasm_pdf_xref_len"] = wasmExports["Xg"];
  _wasm_pdf_lookup_page_obj = Module["_wasm_pdf_lookup_page_obj"] = wasmExports["Yg"];
  _wasm_pdf_add_object = Module["_wasm_pdf_add_object"] = wasmExports["Zg"];
  _wasm_pdf_create_object = Module["_wasm_pdf_create_object"] = wasmExports["_g"];
  _wasm_pdf_delete_object = Module["_wasm_pdf_delete_object"] = wasmExports["$g"];
  _wasm_pdf_add_stream = Module["_wasm_pdf_add_stream"] = wasmExports["ah"];
  _wasm_pdf_add_simple_font = Module["_wasm_pdf_add_simple_font"] = wasmExports["bh"];
  _wasm_pdf_add_cjk_font = Module["_wasm_pdf_add_cjk_font"] = wasmExports["ch"];
  _wasm_pdf_add_cid_font = Module["_wasm_pdf_add_cid_font"] = wasmExports["dh"];
  _wasm_pdf_add_image = Module["_wasm_pdf_add_image"] = wasmExports["eh"];
  _wasm_pdf_load_image = Module["_wasm_pdf_load_image"] = wasmExports["fh"];
  _wasm_pdf_set_page_tree_cache = Module["_wasm_pdf_set_page_tree_cache"] = wasmExports["gh"];
  _wasm_pdf_add_page = Module["_wasm_pdf_add_page"] = wasmExports["hh"];
  _wasm_pdf_insert_page = Module["_wasm_pdf_insert_page"] = wasmExports["ih"];
  _wasm_pdf_delete_page = Module["_wasm_pdf_delete_page"] = wasmExports["jh"];
  _wasm_pdf_set_page_labels = Module["_wasm_pdf_set_page_labels"] = wasmExports["kh"];
  _wasm_pdf_delete_page_labels = Module["_wasm_pdf_delete_page_labels"] = wasmExports["lh"];
  _wasm_pdf_is_embedded_file = Module["_wasm_pdf_is_embedded_file"] = wasmExports["mh"];
  _wasm_pdf_get_filespec_params = Module["_wasm_pdf_get_filespec_params"] = wasmExports["nh"];
  _wasm_pdf_add_embedded_file = Module["_wasm_pdf_add_embedded_file"] = wasmExports["oh"];
  _wasm_pdf_load_embedded_file_contents = Module["_wasm_pdf_load_embedded_file_contents"] = wasmExports["ph"];
  _wasm_pdf_write_document_buffer = Module["_wasm_pdf_write_document_buffer"] = wasmExports["qh"];
  _wasm_pdf_js_supported = Module["_wasm_pdf_js_supported"] = wasmExports["rh"];
  _wasm_pdf_enable_js = Module["_wasm_pdf_enable_js"] = wasmExports["sh"];
  _wasm_pdf_disable_js = Module["_wasm_pdf_disable_js"] = wasmExports["th"];
  _wasm_pdf_rearrange_pages = Module["_wasm_pdf_rearrange_pages"] = wasmExports["uh"];
  _wasm_pdf_subset_fonts = Module["_wasm_pdf_subset_fonts"] = wasmExports["vh"];
  _wasm_pdf_bake_document = Module["_wasm_pdf_bake_document"] = wasmExports["wh"];
  _wasm_pdf_count_layer_configs = Module["_wasm_pdf_count_layer_configs"] = wasmExports["xh"];
  _wasm_pdf_layer_config_creator = Module["_wasm_pdf_layer_config_creator"] = wasmExports["yh"];
  _wasm_pdf_layer_config_name = Module["_wasm_pdf_layer_config_name"] = wasmExports["zh"];
  _wasm_pdf_select_layer_config = Module["_wasm_pdf_select_layer_config"] = wasmExports["Ah"];
  _wasm_pdf_count_layer_config_uis = Module["_wasm_pdf_count_layer_config_uis"] = wasmExports["Bh"];
  _wasm_pdf_layer_config_ui_info = Module["_wasm_pdf_layer_config_ui_info"] = wasmExports["Ch"];
  _wasm_pdf_count_layers = Module["_wasm_pdf_count_layers"] = wasmExports["Dh"];
  _wasm_pdf_layer_name = Module["_wasm_pdf_layer_name"] = wasmExports["Eh"];
  _wasm_pdf_layer_is_enabled = Module["_wasm_pdf_layer_is_enabled"] = wasmExports["Fh"];
  _wasm_pdf_enable_layer = Module["_wasm_pdf_enable_layer"] = wasmExports["Gh"];
  _wasm_pdf_page_transform = Module["_wasm_pdf_page_transform"] = wasmExports["Hh"];
  _wasm_pdf_set_page_box = Module["_wasm_pdf_set_page_box"] = wasmExports["Ih"];
  _wasm_pdf_first_annot = Module["_wasm_pdf_first_annot"] = wasmExports["Jh"];
  _wasm_pdf_next_annot = Module["_wasm_pdf_next_annot"] = wasmExports["Kh"];
  _wasm_pdf_first_widget = Module["_wasm_pdf_first_widget"] = wasmExports["Lh"];
  _wasm_pdf_next_widget = Module["_wasm_pdf_next_widget"] = wasmExports["Mh"];
  _wasm_pdf_create_annot = Module["_wasm_pdf_create_annot"] = wasmExports["Nh"];
  _wasm_pdf_delete_annot = Module["_wasm_pdf_delete_annot"] = wasmExports["Oh"];
  _wasm_pdf_update_page = Module["_wasm_pdf_update_page"] = wasmExports["Ph"];
  _wasm_pdf_redact_page = Module["_wasm_pdf_redact_page"] = wasmExports["Qh"];
  _wasm_pdf_new_graft_map = Module["_wasm_pdf_new_graft_map"] = wasmExports["Rh"];
  _wasm_pdf_graft_mapped_object = Module["_wasm_pdf_graft_mapped_object"] = wasmExports["Sh"];
  _wasm_pdf_graft_object = Module["_wasm_pdf_graft_object"] = wasmExports["Th"];
  _wasm_pdf_graft_mapped_page = Module["_wasm_pdf_graft_mapped_page"] = wasmExports["Uh"];
  _wasm_pdf_graft_page = Module["_wasm_pdf_graft_page"] = wasmExports["Vh"];
  _wasm_pdf_bound_annot = Module["_wasm_pdf_bound_annot"] = wasmExports["Wh"];
  _wasm_pdf_run_annot = Module["_wasm_pdf_run_annot"] = wasmExports["Xh"];
  _wasm_pdf_new_pixmap_from_annot = Module["_wasm_pdf_new_pixmap_from_annot"] = wasmExports["Yh"];
  _wasm_pdf_new_display_list_from_annot = Module["_wasm_pdf_new_display_list_from_annot"] = wasmExports["Zh"];
  _wasm_pdf_update_annot = Module["_wasm_pdf_update_annot"] = wasmExports["_h"];
  _wasm_pdf_annot_obj = Module["_wasm_pdf_annot_obj"] = wasmExports["$h"];
  _wasm_pdf_annot_type = Module["_wasm_pdf_annot_type"] = wasmExports["ai"];
  _wasm_pdf_annot_flags = Module["_wasm_pdf_annot_flags"] = wasmExports["bi"];
  _wasm_pdf_set_annot_flags = Module["_wasm_pdf_set_annot_flags"] = wasmExports["ci"];
  _wasm_pdf_annot_contents = Module["_wasm_pdf_annot_contents"] = wasmExports["di"];
  _wasm_pdf_set_annot_contents = Module["_wasm_pdf_set_annot_contents"] = wasmExports["ei"];
  _wasm_pdf_annot_name = Module["_wasm_pdf_annot_name"] = wasmExports["fi"];
  _wasm_pdf_set_annot_name = Module["_wasm_pdf_set_annot_name"] = wasmExports["gi"];
  _wasm_pdf_annot_author = Module["_wasm_pdf_annot_author"] = wasmExports["hi"];
  _wasm_pdf_set_annot_author = Module["_wasm_pdf_set_annot_author"] = wasmExports["ii"];
  _wasm_pdf_annot_subject = Module["_wasm_pdf_annot_subject"] = wasmExports["ji"];
  _wasm_pdf_set_annot_subject = Module["_wasm_pdf_set_annot_subject"] = wasmExports["ki"];
  _wasm_pdf_annot_creation_date = Module["_wasm_pdf_annot_creation_date"] = wasmExports["li"];
  _wasm_pdf_set_annot_creation_date = Module["_wasm_pdf_set_annot_creation_date"] = wasmExports["mi"];
  _wasm_pdf_annot_modification_date = Module["_wasm_pdf_annot_modification_date"] = wasmExports["ni"];
  _wasm_pdf_set_annot_modification_date = Module["_wasm_pdf_set_annot_modification_date"] = wasmExports["oi"];
  _wasm_pdf_annot_border_width = Module["_wasm_pdf_annot_border_width"] = wasmExports["pi"];
  _wasm_pdf_set_annot_border_width = Module["_wasm_pdf_set_annot_border_width"] = wasmExports["qi"];
  _wasm_pdf_annot_border_style = Module["_wasm_pdf_annot_border_style"] = wasmExports["ri"];
  _wasm_pdf_set_annot_border_style = Module["_wasm_pdf_set_annot_border_style"] = wasmExports["si"];
  _wasm_pdf_annot_border_effect = Module["_wasm_pdf_annot_border_effect"] = wasmExports["ti"];
  _wasm_pdf_set_annot_border_effect = Module["_wasm_pdf_set_annot_border_effect"] = wasmExports["ui"];
  _wasm_pdf_annot_border_effect_intensity = Module["_wasm_pdf_annot_border_effect_intensity"] = wasmExports["vi"];
  _wasm_pdf_set_annot_border_effect_intensity = Module["_wasm_pdf_set_annot_border_effect_intensity"] = wasmExports["wi"];
  _wasm_pdf_annot_opacity = Module["_wasm_pdf_annot_opacity"] = wasmExports["xi"];
  _wasm_pdf_set_annot_opacity = Module["_wasm_pdf_set_annot_opacity"] = wasmExports["yi"];
  _wasm_pdf_annot_filespec = Module["_wasm_pdf_annot_filespec"] = wasmExports["zi"];
  _wasm_pdf_set_annot_filespec = Module["_wasm_pdf_set_annot_filespec"] = wasmExports["Ai"];
  _wasm_pdf_annot_quadding = Module["_wasm_pdf_annot_quadding"] = wasmExports["Bi"];
  _wasm_pdf_set_annot_quadding = Module["_wasm_pdf_set_annot_quadding"] = wasmExports["Ci"];
  _wasm_pdf_annot_is_open = Module["_wasm_pdf_annot_is_open"] = wasmExports["Di"];
  _wasm_pdf_set_annot_is_open = Module["_wasm_pdf_set_annot_is_open"] = wasmExports["Ei"];
  _wasm_pdf_annot_hidden_for_editing = Module["_wasm_pdf_annot_hidden_for_editing"] = wasmExports["Fi"];
  _wasm_pdf_set_annot_hidden_for_editing = Module["_wasm_pdf_set_annot_hidden_for_editing"] = wasmExports["Gi"];
  _wasm_pdf_annot_icon_name = Module["_wasm_pdf_annot_icon_name"] = wasmExports["Hi"];
  _wasm_pdf_set_annot_icon_name = Module["_wasm_pdf_set_annot_icon_name"] = wasmExports["Ii"];
  _wasm_pdf_annot_intent = Module["_wasm_pdf_annot_intent"] = wasmExports["Ji"];
  _wasm_pdf_set_annot_intent = Module["_wasm_pdf_set_annot_intent"] = wasmExports["Ki"];
  _wasm_pdf_annot_callout_style = Module["_wasm_pdf_annot_callout_style"] = wasmExports["Li"];
  _wasm_pdf_set_annot_callout_style = Module["_wasm_pdf_set_annot_callout_style"] = wasmExports["Mi"];
  _wasm_pdf_annot_line_leader = Module["_wasm_pdf_annot_line_leader"] = wasmExports["Ni"];
  _wasm_pdf_set_annot_line_leader = Module["_wasm_pdf_set_annot_line_leader"] = wasmExports["Oi"];
  _wasm_pdf_annot_line_leader_extension = Module["_wasm_pdf_annot_line_leader_extension"] = wasmExports["Pi"];
  _wasm_pdf_set_annot_line_leader_extension = Module["_wasm_pdf_set_annot_line_leader_extension"] = wasmExports["Qi"];
  _wasm_pdf_annot_line_leader_offset = Module["_wasm_pdf_annot_line_leader_offset"] = wasmExports["Ri"];
  _wasm_pdf_set_annot_line_leader_offset = Module["_wasm_pdf_set_annot_line_leader_offset"] = wasmExports["Si"];
  _wasm_pdf_annot_line_caption = Module["_wasm_pdf_annot_line_caption"] = wasmExports["Ti"];
  _wasm_pdf_set_annot_line_caption = Module["_wasm_pdf_set_annot_line_caption"] = wasmExports["Ui"];
  _wasm_pdf_annot_rich_defaults = Module["_wasm_pdf_annot_rich_defaults"] = wasmExports["Vi"];
  _wasm_pdf_set_annot_rich_defaults = Module["_wasm_pdf_set_annot_rich_defaults"] = wasmExports["Wi"];
  _wasm_pdf_annot_callout_point = Module["_wasm_pdf_annot_callout_point"] = wasmExports["Xi"];
  _wasm_pdf_annot_line_caption_offset = Module["_wasm_pdf_annot_line_caption_offset"] = wasmExports["Yi"];
  _wasm_pdf_annot_rect = Module["_wasm_pdf_annot_rect"] = wasmExports["Zi"];
  _wasm_pdf_annot_popup = Module["_wasm_pdf_annot_popup"] = wasmExports["_i"];
  _wasm_pdf_annot_quad_point_count = Module["_wasm_pdf_annot_quad_point_count"] = wasmExports["$i"];
  _wasm_pdf_annot_quad_point = Module["_wasm_pdf_annot_quad_point"] = wasmExports["aj"];
  _wasm_pdf_annot_vertex_count = Module["_wasm_pdf_annot_vertex_count"] = wasmExports["bj"];
  _wasm_pdf_annot_vertex = Module["_wasm_pdf_annot_vertex"] = wasmExports["cj"];
  _wasm_pdf_annot_ink_list_count = Module["_wasm_pdf_annot_ink_list_count"] = wasmExports["dj"];
  _wasm_pdf_annot_ink_list_stroke_count = Module["_wasm_pdf_annot_ink_list_stroke_count"] = wasmExports["ej"];
  _wasm_pdf_annot_ink_list_stroke_vertex = Module["_wasm_pdf_annot_ink_list_stroke_vertex"] = wasmExports["fj"];
  _wasm_pdf_annot_rich_contents = Module["_wasm_pdf_annot_rich_contents"] = wasmExports["gj"];
  _wasm_pdf_annot_border_dash_count = Module["_wasm_pdf_annot_border_dash_count"] = wasmExports["hj"];
  _wasm_pdf_annot_border_dash_item = Module["_wasm_pdf_annot_border_dash_item"] = wasmExports["ij"];
  _wasm_pdf_annot_has_rect = Module["_wasm_pdf_annot_has_rect"] = wasmExports["jj"];
  _wasm_pdf_annot_has_ink_list = Module["_wasm_pdf_annot_has_ink_list"] = wasmExports["kj"];
  _wasm_pdf_annot_has_quad_points = Module["_wasm_pdf_annot_has_quad_points"] = wasmExports["lj"];
  _wasm_pdf_annot_has_vertices = Module["_wasm_pdf_annot_has_vertices"] = wasmExports["mj"];
  _wasm_pdf_annot_has_line = Module["_wasm_pdf_annot_has_line"] = wasmExports["nj"];
  _wasm_pdf_annot_has_interior_color = Module["_wasm_pdf_annot_has_interior_color"] = wasmExports["oj"];
  _wasm_pdf_annot_has_line_ending_styles = Module["_wasm_pdf_annot_has_line_ending_styles"] = wasmExports["pj"];
  _wasm_pdf_annot_has_border = Module["_wasm_pdf_annot_has_border"] = wasmExports["qj"];
  _wasm_pdf_annot_has_border_effect = Module["_wasm_pdf_annot_has_border_effect"] = wasmExports["rj"];
  _wasm_pdf_annot_has_icon_name = Module["_wasm_pdf_annot_has_icon_name"] = wasmExports["sj"];
  _wasm_pdf_annot_has_open = Module["_wasm_pdf_annot_has_open"] = wasmExports["tj"];
  _wasm_pdf_annot_has_author = Module["_wasm_pdf_annot_has_author"] = wasmExports["uj"];
  _wasm_pdf_annot_has_subject = Module["_wasm_pdf_annot_has_subject"] = wasmExports["vj"];
  _wasm_pdf_annot_has_filespec = Module["_wasm_pdf_annot_has_filespec"] = wasmExports["wj"];
  _wasm_pdf_annot_has_callout = Module["_wasm_pdf_annot_has_callout"] = wasmExports["xj"];
  _wasm_pdf_annot_has_rich_contents = Module["_wasm_pdf_annot_has_rich_contents"] = wasmExports["yj"];
  _wasm_pdf_annot_language = Module["_wasm_pdf_annot_language"] = wasmExports["zj"];
  _wasm_pdf_set_annot_language = Module["_wasm_pdf_set_annot_language"] = wasmExports["Aj"];
  _wasm_pdf_set_annot_popup = Module["_wasm_pdf_set_annot_popup"] = wasmExports["Bj"];
  _wasm_pdf_set_annot_rect = Module["_wasm_pdf_set_annot_rect"] = wasmExports["Cj"];
  _wasm_pdf_clear_annot_quad_points = Module["_wasm_pdf_clear_annot_quad_points"] = wasmExports["Dj"];
  _wasm_pdf_clear_annot_vertices = Module["_wasm_pdf_clear_annot_vertices"] = wasmExports["Ej"];
  _wasm_pdf_clear_annot_ink_list = Module["_wasm_pdf_clear_annot_ink_list"] = wasmExports["Fj"];
  _wasm_pdf_clear_annot_border_dash = Module["_wasm_pdf_clear_annot_border_dash"] = wasmExports["Gj"];
  _wasm_pdf_add_annot_quad_point = Module["_wasm_pdf_add_annot_quad_point"] = wasmExports["Hj"];
  _wasm_pdf_add_annot_vertex = Module["_wasm_pdf_add_annot_vertex"] = wasmExports["Ij"];
  _wasm_pdf_add_annot_ink_list_stroke = Module["_wasm_pdf_add_annot_ink_list_stroke"] = wasmExports["Jj"];
  _wasm_pdf_add_annot_ink_list_stroke_vertex = Module["_wasm_pdf_add_annot_ink_list_stroke_vertex"] = wasmExports["Kj"];
  _wasm_pdf_add_annot_border_dash_item = Module["_wasm_pdf_add_annot_border_dash_item"] = wasmExports["Lj"];
  _wasm_pdf_annot_line_ending_styles_start = Module["_wasm_pdf_annot_line_ending_styles_start"] = wasmExports["Mj"];
  _wasm_pdf_annot_line_1 = Module["_wasm_pdf_annot_line_1"] = wasmExports["Nj"];
  _wasm_pdf_annot_line_2 = Module["_wasm_pdf_annot_line_2"] = wasmExports["Oj"];
  _wasm_pdf_set_annot_line = Module["_wasm_pdf_set_annot_line"] = wasmExports["Pj"];
  _wasm_pdf_set_annot_callout_point = Module["_wasm_pdf_set_annot_callout_point"] = wasmExports["Qj"];
  _wasm_pdf_annot_callout_line = Module["_wasm_pdf_annot_callout_line"] = wasmExports["Rj"];
  _wasm_pdf_set_annot_callout_line = Module["_wasm_pdf_set_annot_callout_line"] = wasmExports["Sj"];
  _wasm_pdf_set_annot_line_caption_offset = Module["_wasm_pdf_set_annot_line_caption_offset"] = wasmExports["Tj"];
  _wasm_pdf_annot_line_ending_styles_end = Module["_wasm_pdf_annot_line_ending_styles_end"] = wasmExports["Uj"];
  _wasm_pdf_set_annot_line_ending_styles = Module["_wasm_pdf_set_annot_line_ending_styles"] = wasmExports["Vj"];
  _wasm_pdf_annot_color = Module["_wasm_pdf_annot_color"] = wasmExports["Wj"];
  _wasm_pdf_annot_interior_color = Module["_wasm_pdf_annot_interior_color"] = wasmExports["Xj"];
  _wasm_pdf_set_annot_color = Module["_wasm_pdf_set_annot_color"] = wasmExports["Yj"];
  _wasm_pdf_set_annot_interior_color = Module["_wasm_pdf_set_annot_interior_color"] = wasmExports["Zj"];
  _wasm_pdf_set_annot_default_appearance = Module["_wasm_pdf_set_annot_default_appearance"] = wasmExports["_j"];
  _wasm_pdf_annot_default_appearance_font = Module["_wasm_pdf_annot_default_appearance_font"] = wasmExports["$j"];
  _wasm_pdf_annot_default_appearance_size = Module["_wasm_pdf_annot_default_appearance_size"] = wasmExports["ak"];
  _wasm_pdf_annot_default_appearance_color = Module["_wasm_pdf_annot_default_appearance_color"] = wasmExports["bk"];
  _wasm_pdf_set_annot_rich_contents = Module["_wasm_pdf_set_annot_rich_contents"] = wasmExports["ck"];
  _wasm_pdf_set_annot_stamp_image = Module["_wasm_pdf_set_annot_stamp_image"] = wasmExports["dk"];
  _wasm_pdf_set_annot_appearance_from_display_list = Module["_wasm_pdf_set_annot_appearance_from_display_list"] = wasmExports["ek"];
  _wasm_pdf_set_annot_appearance = Module["_wasm_pdf_set_annot_appearance"] = wasmExports["fk"];
  _wasm_pdf_apply_redaction = Module["_wasm_pdf_apply_redaction"] = wasmExports["gk"];
  _wasm_pdf_reset_form = Module["_wasm_pdf_reset_form"] = wasmExports["hk"];
  _wasm_pdf_annot_field_type = Module["_wasm_pdf_annot_field_type"] = wasmExports["ik"];
  _wasm_pdf_annot_field_flags = Module["_wasm_pdf_annot_field_flags"] = wasmExports["jk"];
  _wasm_pdf_annot_field_label = Module["_wasm_pdf_annot_field_label"] = wasmExports["kk"];
  _wasm_pdf_annot_field_value = Module["_wasm_pdf_annot_field_value"] = wasmExports["lk"];
  _wasm_pdf_load_field_name = Module["_wasm_pdf_load_field_name"] = wasmExports["mk"];
  _wasm_pdf_annot_text_widget_max_len = Module["_wasm_pdf_annot_text_widget_max_len"] = wasmExports["nk"];
  _wasm_pdf_set_annot_text_field_value = Module["_wasm_pdf_set_annot_text_field_value"] = wasmExports["ok"];
  _wasm_pdf_set_annot_choice_field_value = Module["_wasm_pdf_set_annot_choice_field_value"] = wasmExports["pk"];
  _wasm_pdf_annot_choice_field_option_count = Module["_wasm_pdf_annot_choice_field_option_count"] = wasmExports["qk"];
  _wasm_pdf_annot_choice_field_option = Module["_wasm_pdf_annot_choice_field_option"] = wasmExports["rk"];
  _wasm_pdf_toggle_widget = Module["_wasm_pdf_toggle_widget"] = wasmExports["sk"];
  _wasm_pdf_is_indirect = Module["_wasm_pdf_is_indirect"] = wasmExports["tk"];
  _wasm_pdf_is_bool = Module["_wasm_pdf_is_bool"] = wasmExports["uk"];
  _wasm_pdf_is_int = Module["_wasm_pdf_is_int"] = wasmExports["vk"];
  _wasm_pdf_is_real = Module["_wasm_pdf_is_real"] = wasmExports["wk"];
  _wasm_pdf_is_number = Module["_wasm_pdf_is_number"] = wasmExports["xk"];
  _wasm_pdf_is_name = Module["_wasm_pdf_is_name"] = wasmExports["yk"];
  _wasm_pdf_is_string = Module["_wasm_pdf_is_string"] = wasmExports["zk"];
  _wasm_pdf_is_array = Module["_wasm_pdf_is_array"] = wasmExports["Ak"];
  _wasm_pdf_is_dict = Module["_wasm_pdf_is_dict"] = wasmExports["Bk"];
  _wasm_pdf_is_stream = Module["_wasm_pdf_is_stream"] = wasmExports["Ck"];
  _wasm_pdf_to_num = Module["_wasm_pdf_to_num"] = wasmExports["Dk"];
  _wasm_pdf_to_bool = Module["_wasm_pdf_to_bool"] = wasmExports["Ek"];
  _wasm_pdf_to_real = Module["_wasm_pdf_to_real"] = wasmExports["Fk"];
  _wasm_pdf_to_name = Module["_wasm_pdf_to_name"] = wasmExports["Gk"];
  _wasm_pdf_to_text_string = Module["_wasm_pdf_to_text_string"] = wasmExports["Hk"];
  _wasm_pdf_new_indirect = Module["_wasm_pdf_new_indirect"] = wasmExports["Ik"];
  _wasm_pdf_new_array = Module["_wasm_pdf_new_array"] = wasmExports["Jk"];
  _wasm_pdf_new_dict = Module["_wasm_pdf_new_dict"] = wasmExports["Kk"];
  _wasm_pdf_new_bool = Module["_wasm_pdf_new_bool"] = wasmExports["Lk"];
  _wasm_pdf_new_int = Module["_wasm_pdf_new_int"] = wasmExports["Mk"];
  _wasm_pdf_new_real = Module["_wasm_pdf_new_real"] = wasmExports["Nk"];
  _wasm_pdf_new_name = Module["_wasm_pdf_new_name"] = wasmExports["Ok"];
  _wasm_pdf_new_text_string = Module["_wasm_pdf_new_text_string"] = wasmExports["Pk"];
  _wasm_pdf_new_string = Module["_wasm_pdf_new_string"] = wasmExports["Qk"];
  _wasm_pdf_resolve_indirect = Module["_wasm_pdf_resolve_indirect"] = wasmExports["Rk"];
  _wasm_pdf_array_len = Module["_wasm_pdf_array_len"] = wasmExports["Sk"];
  _wasm_pdf_array_get = Module["_wasm_pdf_array_get"] = wasmExports["Tk"];
  _wasm_pdf_dict_get = Module["_wasm_pdf_dict_get"] = wasmExports["Uk"];
  _wasm_pdf_dict_len = Module["_wasm_pdf_dict_len"] = wasmExports["Vk"];
  _wasm_pdf_dict_get_key = Module["_wasm_pdf_dict_get_key"] = wasmExports["Wk"];
  _wasm_pdf_dict_get_val = Module["_wasm_pdf_dict_get_val"] = wasmExports["Xk"];
  _wasm_pdf_dict_get_inheritable = Module["_wasm_pdf_dict_get_inheritable"] = wasmExports["Yk"];
  _wasm_pdf_dict_gets = Module["_wasm_pdf_dict_gets"] = wasmExports["Zk"];
  _wasm_pdf_dict_gets_inheritable = Module["_wasm_pdf_dict_gets_inheritable"] = wasmExports["_k"];
  _wasm_pdf_dict_put = Module["_wasm_pdf_dict_put"] = wasmExports["$k"];
  _wasm_pdf_dict_puts = Module["_wasm_pdf_dict_puts"] = wasmExports["al"];
  _wasm_pdf_dict_del = Module["_wasm_pdf_dict_del"] = wasmExports["bl"];
  _wasm_pdf_dict_dels = Module["_wasm_pdf_dict_dels"] = wasmExports["cl"];
  _wasm_pdf_array_put = Module["_wasm_pdf_array_put"] = wasmExports["dl"];
  _wasm_pdf_array_push = Module["_wasm_pdf_array_push"] = wasmExports["el"];
  _wasm_pdf_array_delete = Module["_wasm_pdf_array_delete"] = wasmExports["fl"];
  _wasm_pdf_sprint_obj = Module["_wasm_pdf_sprint_obj"] = wasmExports["gl"];
  _wasm_pdf_load_stream = Module["_wasm_pdf_load_stream"] = wasmExports["hl"];
  _wasm_pdf_load_raw_stream = Module["_wasm_pdf_load_raw_stream"] = wasmExports["il"];
  _wasm_pdf_update_object = Module["_wasm_pdf_update_object"] = wasmExports["jl"];
  _wasm_pdf_update_stream = Module["_wasm_pdf_update_stream"] = wasmExports["kl"];
  _wasm_pdf_to_string = Module["_wasm_pdf_to_string"] = wasmExports["ll"];
  _wasm_new_stream = Module["_wasm_new_stream"] = wasmExports["ml"];
  _wasm_walk_path = Module["_wasm_walk_path"] = wasmExports["nl"];
  _wasm_walk_text = Module["_wasm_walk_text"] = wasmExports["ol"];
  _wasm_enable_log_callback = Module["_wasm_enable_log_callback"] = wasmExports["pl"];
  _wasm_new_js_device = Module["_wasm_new_js_device"] = wasmExports["ql"];
  _setThrew = wasmExports["sl"];
  __emscripten_stack_restore = wasmExports["tl"];
  _emscripten_stack_get_current = wasmExports["ul"];
  memory = wasmMemory = wasmExports["cb"];
  __indirect_function_table = wasmTable = wasmExports["rl"];
}

var wasmImports = {
  /** @export */ za: ___syscall_fcntl64,
  /** @export */ bb: ___syscall_ftruncate64,
  /** @export */ ab: ___syscall_ioctl,
  /** @export */ ya: ___syscall_openat,
  /** @export */ $a: ___syscall_rmdir,
  /** @export */ xa: ___syscall_unlinkat,
  /** @export */ Va: __emscripten_throw_longjmp,
  /** @export */ Ua: __gmtime_js,
  /** @export */ Ta: __timegm_js,
  /** @export */ Sa: __tzset_js,
  /** @export */ _a: _clock_time_get,
  /** @export */ s: _emscripten_asm_const_int,
  /** @export */ Ra: _emscripten_asm_const_ptr,
  /** @export */ Qa: _emscripten_date_now,
  /** @export */ Pa: _emscripten_resize_heap,
  /** @export */ Za: _environ_get,
  /** @export */ Ya: _environ_sizes_get,
  /** @export */ ua: _exit,
  /** @export */ wa: _fd_close,
  /** @export */ Xa: _fd_read,
  /** @export */ Wa: _fd_seek,
  /** @export */ va: _fd_write,
  /** @export */ w: invoke_fii,
  /** @export */ n: invoke_fiii,
  /** @export */ ia: invoke_fiiif,
  /** @export */ Oa: invoke_fiiifiif,
  /** @export */ F: invoke_fiiii,
  /** @export */ ha: invoke_fiiiii,
  /** @export */ Na: invoke_fiiiiiii,
  /** @export */ ta: invoke_i,
  /** @export */ e: invoke_ii,
  /** @export */ ga: invoke_iif,
  /** @export */ d: invoke_iii,
  /** @export */ Ma: invoke_iiidi,
  /** @export */ La: invoke_iiif,
  /** @export */ sa: invoke_iiiff,
  /** @export */ fa: invoke_iiiffffiii,
  /** @export */ Ka: invoke_iiiffiiii,
  /** @export */ ra: invoke_iiiffiiiiiii,
  /** @export */ b: invoke_iiii,
  /** @export */ qa: invoke_iiiif,
  /** @export */ ea: invoke_iiiifi,
  /** @export */ h: invoke_iiiii,
  /** @export */ Z: invoke_iiiiiffi,
  /** @export */ pa: invoke_iiiiiffiifiii,
  /** @export */ da: invoke_iiiiiffiii,
  /** @export */ Y: invoke_iiiiifiiii,
  /** @export */ j: invoke_iiiiii,
  /** @export */ k: invoke_iiiiiii,
  /** @export */ Ja: invoke_iiiiiiifi,
  /** @export */ t: invoke_iiiiiiii,
  /** @export */ M: invoke_iiiiiiiii,
  /** @export */ I: invoke_iiiiiiiiii,
  /** @export */ U: invoke_iiiiiiiiiii,
  /** @export */ T: invoke_iiiiiiiiiiii,
  /** @export */ E: invoke_iiiiiiiiiiiiii,
  /** @export */ Ia: invoke_iiiiiiiiiiiiiiiiii,
  /** @export */ Ha: invoke_iiiiiiiij,
  /** @export */ Ga: invoke_iiiiiijji,
  /** @export */ Fa: invoke_iiiiij,
  /** @export */ oa: invoke_iiiij,
  /** @export */ na: invoke_iiij,
  /** @export */ C: invoke_iiiji,
  /** @export */ ca: invoke_iiijj,
  /** @export */ S: invoke_iij,
  /** @export */ Ea: invoke_ji,
  /** @export */ v: invoke_jii,
  /** @export */ N: invoke_jiii,
  /** @export */ Da: invoke_jiij,
  /** @export */ f: invoke_vi,
  /** @export */ a: invoke_vii,
  /** @export */ r: invoke_viid,
  /** @export */ x: invoke_viif,
  /** @export */ u: invoke_viiff,
  /** @export */ X: invoke_viifff,
  /** @export */ K: invoke_viiffff,
  /** @export */ R: invoke_viiffffff,
  /** @export */ ma: invoke_viiffii,
  /** @export */ ba: invoke_viifi,
  /** @export */ g: invoke_viii,
  /** @export */ O: invoke_viiid,
  /** @export */ W: invoke_viiif,
  /** @export */ Q: invoke_viiiffff,
  /** @export */ aa: invoke_viiifffffiii,
  /** @export */ Ca: invoke_viiififfff,
  /** @export */ la: invoke_viiifii,
  /** @export */ c: invoke_viiii,
  /** @export */ ka: invoke_viiiif,
  /** @export */ A: invoke_viiiiff,
  /** @export */ Ba: invoke_viiiiffi,
  /** @export */ H: invoke_viiiifi,
  /** @export */ Aa: invoke_viiiifii,
  /** @export */ $: invoke_viiiifiiiiiii,
  /** @export */ i: invoke_viiiii,
  /** @export */ _: invoke_viiiiifii,
  /** @export */ l: invoke_viiiiii,
  /** @export */ ja: invoke_viiiiiiffffi,
  /** @export */ D: invoke_viiiiiifi,
  /** @export */ o: invoke_viiiiiii,
  /** @export */ L: invoke_viiiiiiif,
  /** @export */ z: invoke_viiiiiiifi,
  /** @export */ P: invoke_viiiiiiifiiifffffiii,
  /** @export */ y: invoke_viiiiiiii,
  /** @export */ G: invoke_viiiiiiiii,
  /** @export */ B: invoke_viiiiiiiiii,
  /** @export */ J: invoke_viiiiiiiiiii,
  /** @export */ V: invoke_viiiij,
  /** @export */ m: invoke_viiij,
  /** @export */ q: invoke_viij,
  /** @export */ p: invoke_viiji
};

function invoke_ii(index, a1) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iii(index, a1, a2) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_vi(index, a1) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_vii(index, a1, a2) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiii(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viii(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiijj(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiii(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_fiiii(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiii(index, a1, a2, a3, a4, a5, a6) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiiii(index, a1, a2, a3, a4, a5, a6, a7) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viif(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiii(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiii(index, a1, a2, a3, a4, a5, a6) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiff(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiffffff(index, a1, a2, a3, a4, a5, a6, a7, a8) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiffff(index, a1, a2, a3, a4, a5, a6) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiii(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiiiifi(index, a1, a2, a3, a4, a5, a6, a7, a8, a9) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiiifi(index, a1, a2, a3, a4, a5, a6, a7, a8) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiifi(index, a1, a2, a3, a4, a5, a6) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiiii(index, a1, a2, a3, a4, a5, a6, a7) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiiiif(index, a1, a2, a3, a4, a5, a6, a7, a8) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiffiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiii(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiif(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viifff(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiijji(index, a1, a2, a3, a4, a5, a6, a7, a8) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_jii(index, a1, a2) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
    return 0n;
  }
}

function invoke_viij(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_fii(index, a1, a2) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_fiii(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiifii(index, a1, a2, a3, a4, a5, a6) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiji(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iij(index, a1, a2) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iif(index, a1, a2) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiidi(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_ji(index, a1) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
    return 0n;
  }
}

function invoke_viiji(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_i(index) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)();
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiifiiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiffffiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_fiiiii(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiffiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiiiiiiiiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15, a16, a17) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15, a16, a17);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiiiiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiff(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiif(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiij(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiij(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiid(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiifii(index, a1, a2, a3, a4, a5, a6, a7) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viid(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_fiiif(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_jiii(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
    return 0n;
  }
}

function invoke_fiiifiif(index, a1, a2, a3, a4, a5, a6, a7) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiffff(index, a1, a2, a3, a4, a5, a6, a7) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_fiiiiiii(index, a1, a2, a3, a4, a5, a6, a7) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiifffffiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiffiifiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiffi(index, a1, a2, a3, a4, a5, a6, a7) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiiiifiiifffffiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15, a16, a17, a18, a19) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15, a16, a17, a18, a19);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiifii(index, a1, a2, a3, a4, a5, a6, a7, a8) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiiiffffi(index, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiifi(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiff(index, a1, a2, a3, a4, a5, a6) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viifi(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiiifi(index, a1, a2, a3, a4, a5, a6, a7, a8) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiffii(index, a1, a2, a3, a4, a5, a6) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiif(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiifiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiij(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiiiij(index, a1, a2, a3, a4, a5, a6, a7, a8) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_jiij(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
    return 0n;
  }
}

function invoke_iiij(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiij(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiffiiii(index, a1, a2, a3, a4, a5, a6, a7, a8) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiffi(index, a1, a2, a3, a4, a5, a6, a7) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiif(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiififfff(index, a1, a2, a3, a4, a5, a6, a7, a8, a9) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

// include: postamble.js
// === Auto-generated postamble setup entry stuff ===
function run() {
  preRun();
  function doRun() {
    // run may have just been called through dependencies being fulfilled just in this very frame,
    // or while the async setStatus time below was happening
    Module["calledRun"] = true;
    if (ABORT) return;
    initRuntime();
    readyPromiseResolve?.(Module);
    Module["onRuntimeInitialized"]?.();
    postRun();
  }
  if (Module["setStatus"]) {
    Module["setStatus"]("Running...");
    setTimeout(() => {
      setTimeout(() => Module["setStatus"](""), 1);
      doRun();
    }, 1);
  } else {
    doRun();
  }
}

var wasmExports;

// In modularize mode the generated code is within a factory function so we
// can use await here (since it's not top-level-await).
wasmExports = await (createWasm());

run();

// end include: postamble.js
// include: postamble_modularize.js
// In MODULARIZE mode we wrap the generated code in a factory function
// and return either the Module itself, or a promise of the module.
// We assign to the `moduleRtn` global here and configure closure to see
// this as an extern so it won't get minified.
if (runtimeInitialized) {
  moduleRtn = Module;
} else {
  // Set up the promise that indicates the Module is initialized
  moduleRtn = new Promise((resolve, reject) => {
    readyPromiseResolve = resolve;
    readyPromiseReject = reject;
  });
}


  return moduleRtn;
}

// Export using a UMD style export, or ES6 exports if selected
export default libmupdf_wasm;

