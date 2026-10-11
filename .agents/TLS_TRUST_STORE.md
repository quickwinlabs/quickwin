# TLS 信任根与 wolfSSL 3072 位 RSA 上限（2026-09-30，XP 实测，已修复）

## 背景

XP SP3 的根证书库冻结在 2008 年，因此根证书内联在 `lib/certs.ts` 里，随 JS bundle
一起分发，模块导入时推入 wolfSSL 的全局信任库，握手时不读盘。

## 现象

9 个站点探测（`wolfssl.clearTrustedCAs()` 现场换库 + `fetch`）：

| 站点 | 改前 | 改后 |
|---|---|---|
| baidu.com / cdn.jsdelivr / esm.sh | 200 | 200 |
| bilibili.com / jd.com | 200 | 200 |
| github.com | **-188** | 200 |
| taobao.com / qq.com / bing.com | **-155** | 200 |

改前 5/9，改后 9/9。

## 根因一：SP 大数 3072 位硬上限（taobao / qq / bing 的 -155）

`-155` 是 `ASN_SIG_CONFIRM_E`，但它不是验签失败的直接原因，而是 wolfSSL 把**所有**
密码学错误都压成了这个码：

```c
// wolfcrypt/src/asn.c:17732
if (ret < 0) {
    /* treat all errors as ASN_SIG_CONFIRM_E */
    ret = ASN_SIG_CONFIRM_E;   // -155
```

真正报错的是 RSA 密钥尺寸检查：

```c
// wolfssl/wolfcrypt/rsa.h:144
#define RSA_MAX_SIZE    WC_BITS_FULL_BYTES(SP_INT_BITS)

// wolfssl/wolfcrypt/settings.h:67
#define WC_BITS_FULL_BYTES(x) (WC_BITS_TO_BYTES(x) << 3)

// wolfcrypt/src/rsa.c:834 (另有 2870 / 3053 / 3487 三处同样检查)
if (MP_BITS_OVER_MAX(mp_bitsused(&key->n), RSA_MAX_SIZE)) {
    return WC_KEY_SIZE_E;      // -234
```

而 `SP_INT_BITS` 我们没定义，走 wolfSSL 的默认档位：

```c
// wolfssl/wolfcrypt/sp_int.h:468
    #else
        /* Default to max 3072 for general RSA and DH. */
        #define SP_INT_BITS     3072
```

该默认值只跟随已编译的 FFDHE 参数选档，Makefile 里 `-DWOLFSSL_DH=OFF` 且没有
`HAVE_FFDHE_4096`，于是永远落在 3072。`RSA_MAX_SIZE` 因此等于 3072，
**所有 RSA > 3072 位的公钥直接被拒**。

受影响根（均为 RSA 4096）：GlobalSign Root R46、ISRG Root X1、
Microsoft TLS RSA Root G2。EC 曲线根不受影响——ECC 用独立的
`SP_INT_BITS_ECC`，且 `ecc.h:413` 把它收敛到 `MAX_ECC_BITS`（P-521，即 521 位），
远低于 3072。所以 github 之前是缺根（-188）而不是尺寸问题。

## 根因二：缺根（github 的 -188）

`github.com` 的链是 `CN=github.com → Sectigo PSA CA DV E36 → Sectigo PSA Root E46`，
E46 在 Mozilla 根库里有但当时 bundle 里没有。

## 各站点链与所需根

| 站点 | 中间 CA | 链顶（wolfSSL 实际用的信任锚） |
|---|---|---|
| baidu / jsdelivr / bilibili / jd | GlobalSign RSA OV SSL CA 2018 | GLOBALSIGN_R3（交叉签名，R1 签发） |
| taobao | GlobalSign GCC R46 OV TLS CA 2025 | GLOBALSIGN_R46 |
| qq | GlobalSign Atlas R46 OV TLS CA 2026 Q3 | GLOBALSIGN_R46 |
| github | Sectigo PSA CA DV E36 | USERTRUST_ECC_CA（E46 的交叉父） |
| bing | Microsoft TLS G2 RSA CA OCSP 10 | DIGICERT_GLOBAL_G2（MS G2 的交叉父） |

后三个站点的链顶本身都是**交叉签名版**，wolfSSL 只会用到它的交叉父，所以补的是
父根而不是链顶本身。

## 修复

**1. `Makefile` — 抬 SP 大数上限**

```diff
 	-DCMAKE_C_FLAGS_RELEASE="-Os" \
+	-DCMAKE_C_FLAGS="-DSP_INT_BITS=4096" \
```

wolfSSL 没有对应的 cmake 开关，只能走编译宏；`sp_int.h:446` 是
`#ifndef SP_INT_BITS`，命令行 `-D` 优先。侧效应：`SP_INT_DIGITS` 从 193 变 257
（ia32，`SP_WORD_SIZE=32`），`sp_int_ctx` 的 `dp[]` 增加 256 字节。

**2. `lib/certs.ts` — 根证书 2 → 7 张**

新增 USERTRUST_ECC_CA、DIGICERT_GLOBAL_G2、GLOBALSIGN_R46、ISRG_X1、ISRG_X2。
根证书一律从 `cacert.pem` 切分后用脚本生成 PEM 文本块，不做手抄——手抄漏一个
base64 字符会产生 wolfSSL 解析不了的证书。

## 验证

- 9 站点探测全 200（baidu 28918B / jsdelivr 611B / esm.sh 134B / bilibili
  167654B / jd 185919B / taobao 89600B / qq 118351B / github 576128B / bing 15035B）
- XP 回归：`http_test.sh xp net` 84/84；全量 551/552（唯一失败是既有的打印机
  ffi 差异 `pcbNeeded`）

## 踩坑记录

**1. 换 wolfSSL 编译选项后必须删静态库**

`$(WOLFSSL_LIB_STATIC)` 目标没有依赖 Makefile，改了 `WOLFSSL_CMAKE_OPTS`
之后 `make cc32` 会直接报 `libwolfssl.a is up to date`，什么都不重编：

```sh
# 容器内：podman exec quickwin-dev bash -lc 'cd /workspace && <cmd>'
rm -f _build/deps/ia32-cross/libwolfssl.a
make js && make cc32
```

改完用 `grep CMAKE_C_FLAGS: _build/deps/ia32-cross/wolfssl-build/CMakeCache.txt`
确认生效。

**2. 交叉签名根与自签根是同一公钥**

对 SPKI 取 SHA256 比对，交叉版与自签版完全相同：

| 根 | SPKI-SHA256 前缀 | 自签/交叉是否同钥 |
|---|---|---|
| GlobalSign R3 | `706bb101…` | 是（SKID 也同为 `8F:F0:4B:7F…`） |
| GlobalSign R46 | `ae7f962c…` | 是 |
| Sectigo E46 | `b0b56335…` | 是 |

所以补交叉父是安全的，不存在"补错根导致验签失败"的风险。

**3. 曾被误导的一次判断**

最初以为 `-155` 来自 GlobalSign 复用了 R3 的 SKID 却换了公钥，进而推断 wolfSSL
"不会尝试第二个 SKID 冲突的根"。实测证伪：自签 R3 + R1 也能让 baidu 返回 200。
真正原因是上面的 3072 位上限。教训是 `-155` 覆盖面太宽（`asn.c:17732` 把所有
错误都归到这里），不能拿它当验签失败用，得追到 `WC_KEY_SIZE_E` 这类原始码。

**4. 自签 E46 入 store 仍报 -188**

把 Sectigo E46 自签根放进库，github 依旧 `-188`，换成 USERTRUST_ECC_CA 才通。
原因未查（同 SKID、同为 EC P-384、CA:TRUE + keyCertSign 都正常），但补 USERTRUST
已覆盖该链，未继续追。

**5. 取不到自签 Microsoft TLS RSA Root G2**

`crt.sh` 当时 502，拿不到该根证书。不影响修复：bing 下发的是交叉链，
补 DigiCert Global Root G2 即可。

## 复现探测

`_build/test/probe_roots.js`（gitignore 内）：内联若干 PEM，循环
`clearTrustedCAs()` + `addTrustedCA()` 现场换库，逐个站点 `fetch` 打印状态与
body 长度。生成器在 `/tmp/opencode/gen_probe3.py`，跑法：

```sh
podman exec quickwin-dev bash -lc 'curl -sS -X POST http://127.0.0.1:8005/exec \
  -H "Content-Type: application/json" -d "{\"cmd\":\"qwin-x86.exe test/probe_roots.js\"}"'
```

抓链用 `openssl s_client -connect HOST:443 -servername HOST -showcerts`。
比对 SKID/AKID 时注意 openssl 3.5 的 `-text` 输出在 `Subject Key Identifier:` 后
带**尾随空格**，正则漏掉空格会全部解析为空。
