/* ==========================================================================
   移动后台 · 模块：license —— 授权码生成器（工具箱 / 在线版 / 离线版）
   --------------------------------------------------------------------------
   用途
     把桌面上的三套「授权码生成器」搬进手机，出门在外也能给客户发码：
       · 工具箱  机器码 BJXL- 开头    → HMAC-SHA256 授权码
       · 在线版  机器码 SXZWZ- 开头   → HMAC-SHA256 授权码
       · 离线版  机器码 XXXX-XXXX-…   → AES-256-CBC + PBKDF2 授权码（-LYT 结尾）

   算法来源（严格对齐，改任何一个参数都会让客户端验签失败）
     · 离线版：C# 工程 CAD散线转文字_后端/LicenseCore.cs
               SecurityConfig / CryptoHelper / LicenseGenerator
     · 工具箱、在线版：4-三端授权/统一授权管理.html
               （与 C# 端 GenerateLicenseKey 对齐的 HMAC-SHA256 方案）
     验证脚本：tools/test-license.js（与 Node crypto 及真实 C# 工程交叉验签）

   连接
     conns: []  —— 本模块**完全不联网**，纯本机计算。
     生成的授权码只写进手机浏览器本地（localStorage），不上云、不写数据库。

   ⚠️ 签发密钥不在代码里
     本应用部署在公开站点（GitHub Pages），把授权签发密钥写进代码＝公开 keygen。
     所以密钥必须在「密钥」页手动输入，只存本机浏览器 localStorage（键 license.keys）。
     各个值的来源见 README「🔑 授权码生成」一节。

   用到的表
     无（不连数据库）
   ========================================================================== */
(function () {
  'use strict';

  var DS = window.DS;

  /* ======================================================================
     1. 常量
     ====================================================================== */

  var LS_RECORDS = 'license.records';
  var LS_KIND = 'license.kind';
  var LS_KEYS = 'license.keys';
  var MAX_RECORDS = 300;

  /**
   * 授权签发密钥**不在代码里**（本站点公开，写进来等于公开 keygen）。
   * 在「密钥」页输入，只存本机浏览器。来源见 README「🔑 授权码生成」。
   */
  var EMPTY_KEYS = {
    toolbox: '',                    // 工具箱 HMAC 盐
    sxzwz: '',                      // 在线版 HMAC 盐
    lyt: { baseKeyHex: '', baseSaltHex: '', pepperHex: '', secretKeyHex: '' }
  };

  /** 密钥页的字段清单（name 里的 . 表示 lyt 子字段） */
  var KEY_FIELDS = [
    { name: 'toolbox', label: '工具箱 · HMAC 盐', ph: '粘贴工具箱的盐', hint: '桌面版「统一授权管理.html」源码里的 SECRET_KEYS.toolbox' },
    { name: 'sxzwz', label: '在线版 · HMAC 盐', ph: '粘贴在线版的盐', hint: '桌面版「统一授权管理.html」源码里的 SECRET_KEYS.sxzwz' },
    { name: 'lyt.baseKeyHex', label: '离线版 · baseKey（HEX）', ph: '64 位十六进制', hint: 'LicenseCore.cs → SecurityConfig._baseKey' },
    { name: 'lyt.baseSaltHex', label: '离线版 · baseSalt（HEX）', ph: '96 位十六进制', hint: 'LicenseCore.cs → SecurityConfig._baseSalt' },
    { name: 'lyt.pepperHex', label: '离线版 · pepper（HEX）', ph: '72 位十六进制', hint: 'LicenseCore.cs → SecurityConfig._pepper' },
    { name: 'lyt.secretKeyHex', label: '离线版 · secretKey（HEX）', ph: '108 位十六进制', hint: 'LicenseCore.cs → SecurityConfig._secretKey' }
  ];

  /** 非密钥参数（与 LicenseCore.cs 的 LicenseGenerator 一致，改动会导致验签失败） */
  var LYT = {
    iterations: 10000,
    typeNames: { 1: '试用版', 2: '专业版', 3: '永久版' },
    typeDays: { 1: 3, 2: 30, 3: -1 }
  };

  var KINDS = [
    { v: 'toolbox', l: '🧰 工具箱' },
    { v: 'sxzwz', l: '📝 在线版' },
    { v: 'lyt', l: '💻 离线版' }
  ];

  var META = {
    toolbox: {
      ic: '🧰', label: '工具箱', prefix: 'BJXL-', scheme: 'HMAC-SHA256',
      mcHint: 'BJXL-xxxxxx', mcHelp: '不加班的小刘_工具箱 的机器码，必须以 BJXL- 开头'
    },
    sxzwz: {
      ic: '📝', label: '在线版', prefix: 'SXZWZ-', scheme: 'HMAC-SHA256',
      mcHint: 'SXZWZ-xxxxxx', mcHelp: '散线转文字（在线）的机器码，必须以 SXZWZ- 开头'
    },
    lyt: {
      ic: '💻', label: '离线版', prefix: '', scheme: 'AES-256-CBC + PBKDF2',
      mcHint: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX',
      mcHelp: 'CAD 客户端「授权」窗口里显示的机器码，8 组 4 位十六进制'
    }
  };

  var kind = 'toolbox';
  try {
    var savedKind = DS.lsGet(LS_KIND, '');
    if (savedKind && META[savedKind]) kind = savedKind;
  } catch (e) { }

  /* ======================================================================
     2. 底层密码学原语
     ----------------------------------------------------------------------
     优先走浏览器原生 WebCrypto（快）。局域网 http 属于「非安全上下文」，
     此时 window.crypto.subtle 是 undefined，退化到纯 JS 实现。
     两条路径输出必须逐字节相同，tools/test-license.js 会分别与 Node crypto 比对。
     ====================================================================== */

  var HAS_SUBTLE = !!(window.crypto && window.crypto.subtle);

  function utf8Bytes(str) {
    str = String(str === undefined || str === null ? '' : str);
    var out = [];
    var i, c, c2, cp;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length &&
        str.charCodeAt(i + 1) >= 0xdc00 && str.charCodeAt(i + 1) <= 0xdfff) {
        c2 = str.charCodeAt(i + 1);
        cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        i++;
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return new Uint8Array(out);
  }

  function hexToBytes(hex) {
    hex = String(hex || '');
    var out = new Uint8Array(hex.length >> 1);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  /** 只用于处理纯 ASCII 的 pepper / secretKey，等价于 C# 的 Encoding.UTF8.GetString */
  function hexToAscii(hex) {
    var s = '';
    for (var i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    return s;
  }

  function bytesToHexUpper(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var h = bytes[i].toString(16).toUpperCase();
      s += h.length === 1 ? '0' + h : h;
    }
    return s;
  }

  var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  /** 标准 Base64（**保留 = 填充**，与 C# Convert.ToBase64String 一致） */
  function bytesToBase64(bytes) {
    var out = '';
    var i, b0, b1, b2;
    for (i = 0; i < bytes.length; i += 3) {
      b0 = bytes[i];
      b1 = bytes[i + 1];
      b2 = bytes[i + 2];
      out += B64_CHARS.charAt(b0 >> 2);
      out += B64_CHARS.charAt(((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4));
      out += b1 === undefined ? '=' : B64_CHARS.charAt(((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6));
      out += b2 === undefined ? '=' : B64_CHARS.charAt(b2 & 63);
    }
    return out;
  }

  /** Base64URL（去填充，+→-，/→_），HMAC 方案用 */
  function bytesToBase64Url(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /* ---- SHA-256（纯 JS 兜底） ---- */
  var SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

  function sha256Bytes(msg) {
    var len = msg.length;
    var padLen = (((len + 9) + 63) >> 6) << 6;
    var buf = new Uint8Array(padLen);
    var i, t;
    for (i = 0; i < len; i++) buf[i] = msg[i] & 255;
    buf[len] = 0x80;
    var hi = Math.floor(len / 536870912);
    var lo = (len << 3) >>> 0;
    buf[padLen - 8] = (hi >>> 24) & 255;
    buf[padLen - 7] = (hi >>> 16) & 255;
    buf[padLen - 6] = (hi >>> 8) & 255;
    buf[padLen - 5] = hi & 255;
    buf[padLen - 4] = (lo >>> 24) & 255;
    buf[padLen - 3] = (lo >>> 16) & 255;
    buf[padLen - 2] = (lo >>> 8) & 255;
    buf[padLen - 1] = lo & 255;

    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    var off, a, b, c, d, e, f, g, hh, s0, s1, S0, S1, ch, maj, tmp1, tmp2;

    for (off = 0; off < padLen; off += 64) {
      for (t = 0; t < 16; t++) {
        w[t] = ((buf[off + t * 4] << 24) | (buf[off + t * 4 + 1] << 16) |
          (buf[off + t * 4 + 2] << 8) | buf[off + t * 4 + 3]) >>> 0;
      }
      for (t = 16; t < 64; t++) {
        s0 = (rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)) >>> 0;
        s1 = (rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)) >>> 0;
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      a = h[0]; b = h[1]; c = h[2]; d = h[3];
      e = h[4]; f = h[5]; g = h[6]; hh = h[7];
      for (t = 0; t < 64; t++) {
        S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        ch = ((e & f) ^ ((~e) & g)) >>> 0;
        tmp1 = (hh + S1 + ch + SHA256_K[t] + w[t]) >>> 0;
        S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        tmp2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + tmp1) >>> 0;
        d = c; c = b; b = a; a = (tmp1 + tmp2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) {
      out[i * 4] = (h[i] >>> 24) & 255;
      out[i * 4 + 1] = (h[i] >>> 16) & 255;
      out[i * 4 + 2] = (h[i] >>> 8) & 255;
      out[i * 4 + 3] = h[i] & 255;
    }
    return out;
  }

  function hmacSha256Bytes(key, msg) {
    var k = key.length > 64 ? sha256Bytes(key) : key;
    var block = new Uint8Array(64);
    var i;
    for (i = 0; i < k.length; i++) block[i] = k[i];
    var inner = new Uint8Array(64 + msg.length);
    var outer = new Uint8Array(64 + 32);
    for (i = 0; i < 64; i++) {
      inner[i] = block[i] ^ 0x36;
      outer[i] = block[i] ^ 0x5c;
    }
    for (i = 0; i < msg.length; i++) inner[64 + i] = msg[i];
    var ih = sha256Bytes(inner);
    for (i = 0; i < 32; i++) outer[64 + i] = ih[i];
    return sha256Bytes(outer);
  }

  function pbkdf2BytesRaw(pw, salt, iterations, dkLen) {
    var hLen = 32;
    var blocks = Math.ceil(dkLen / hLen);
    var out = new Uint8Array(dkLen);
    var b, i, it, j, off;
    for (b = 1; b <= blocks; b++) {
      var msg = new Uint8Array(salt.length + 4);
      for (i = 0; i < salt.length; i++) msg[i] = salt[i];
      msg[salt.length] = (b >>> 24) & 255;
      msg[salt.length + 1] = (b >>> 16) & 255;
      msg[salt.length + 2] = (b >>> 8) & 255;
      msg[salt.length + 3] = b & 255;
      var u = hmacSha256Bytes(pw, msg);
      var t = new Uint8Array(u);
      for (it = 1; it < iterations; it++) {
        u = hmacSha256Bytes(pw, u);
        for (j = 0; j < hLen; j++) t[j] ^= u[j];
      }
      off = (b - 1) * hLen;
      for (j = 0; j < hLen && off + j < dkLen; j++) out[off + j] = t[j];
    }
    return out;
  }

  /* ---- AES-256-CBC（纯 JS，只做加密；每次只加密 12 个块，性能无所谓，可读性优先） ---- */
  var AES_SBOX = [
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16
  ];
  var AES_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

  function gmul(a, b) {
    var p = 0;
    for (var i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      var hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) a ^= 0x1b;
      b >>= 1;
    }
    return p & 0xff;
  }

  function subWord(x) {
    return ((AES_SBOX[(x >>> 24) & 255] << 24) | (AES_SBOX[(x >>> 16) & 255] << 16) |
      (AES_SBOX[(x >>> 8) & 255] << 8) | AES_SBOX[x & 255]) >>> 0;
  }

  function aesExpandKey(key) {
    var nk = key.length / 4;
    var nr = nk + 6;
    var total = 4 * (nr + 1);
    var w = new Array(total);
    var i;
    for (i = 0; i < nk; i++) {
      w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
    }
    for (i = nk; i < total; i++) {
      var t = w[i - 1];
      if (i % nk === 0) {
        t = ((t << 8) | (t >>> 24)) >>> 0;                     // RotWord
        t = (subWord(t) ^ (AES_RCON[i / nk - 1] << 24)) >>> 0;
      } else if (nk > 6 && i % nk === 4) {
        t = subWord(t);
      }
      w[i] = (w[i - nk] ^ t) >>> 0;
    }
    return { w: w, nr: nr };
  }

  function aesEncryptBlock(inB, inOff, out, outOff, ks) {
    var w = ks.w;
    var nr = ks.nr;
    var s = new Array(16);
    var i, r, c, t, a0, a1, a2, a3;

    for (c = 0; c < 4; c++) {
      t = w[c];
      s[4 * c] = inB[inOff + 4 * c] ^ ((t >>> 24) & 255);
      s[4 * c + 1] = inB[inOff + 4 * c + 1] ^ ((t >>> 16) & 255);
      s[4 * c + 2] = inB[inOff + 4 * c + 2] ^ ((t >>> 8) & 255);
      s[4 * c + 3] = inB[inOff + 4 * c + 3] ^ (t & 255);
    }

    for (r = 1; r <= nr; r++) {
      for (i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];          // SubBytes

      t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;      // ShiftRows
      t = s[2]; s[2] = s[10]; s[10] = t;
      t = s[6]; s[6] = s[14]; s[14] = t;
      t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;

      if (r !== nr) {                                           // MixColumns
        for (c = 0; c < 4; c++) {
          a0 = s[4 * c]; a1 = s[4 * c + 1]; a2 = s[4 * c + 2]; a3 = s[4 * c + 3];
          s[4 * c] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
          s[4 * c + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
          s[4 * c + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
          s[4 * c + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
        }
      }

      for (c = 0; c < 4; c++) {                                 // AddRoundKey
        t = w[r * 4 + c];
        s[4 * c] ^= (t >>> 24) & 255;
        s[4 * c + 1] ^= (t >>> 16) & 255;
        s[4 * c + 2] ^= (t >>> 8) & 255;
        s[4 * c + 3] ^= t & 255;
      }
    }
    for (i = 0; i < 16; i++) out[outOff + i] = s[i] & 255;
  }

  /** AES-CBC + PKCS#7（与 .NET Aes.Create() + CryptoStream 的默认行为一致） */
  function aesCbcEncryptRaw(keyBytes, ivBytes, plainBytes) {
    var pad = 16 - (plainBytes.length % 16);
    var total = plainBytes.length + pad;
    var data = new Uint8Array(total);
    data.set(plainBytes);
    for (var i = plainBytes.length; i < total; i++) data[i] = pad;

    var ks = aesExpandKey(keyBytes);
    var out = new Uint8Array(total);
    var prev = new Uint8Array(ivBytes.subarray(0, 16));
    var block = new Uint8Array(16);
    for (var off = 0; off < total; off += 16) {
      for (var j = 0; j < 16; j++) block[j] = data[off + j] ^ prev[j];
      aesEncryptBlock(block, 0, out, off, ks);
      prev = out.subarray(off, off + 16);
    }
    return out;
  }

  /* ---- 异步包装：有 WebCrypto 走原生，没有就走上面的纯 JS ---- */

  function sha256BytesAsync(bytes) {
    if (HAS_SUBTLE) {
      return window.crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
        return new Uint8Array(buf);
      });
    }
    return Promise.resolve(sha256Bytes(bytes));
  }

  function sha256HexUpper(bytes) {
    return sha256BytesAsync(bytes).then(bytesToHexUpper);
  }

  function hmacSha256Async(keyBytes, msgBytes) {
    if (HAS_SUBTLE) {
      return window.crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
        .then(function (k) { return window.crypto.subtle.sign('HMAC', k, msgBytes); })
        .then(function (sig) { return new Uint8Array(sig); });
    }
    return Promise.resolve(hmacSha256Bytes(keyBytes, msgBytes));
  }

  function pbkdf2Async(pwBytes, saltBytes, iterations, dkLen) {
    if (HAS_SUBTLE) {
      return window.crypto.subtle.importKey('raw', pwBytes, 'PBKDF2', false, ['deriveBits'])
        .then(function (k) {
          return window.crypto.subtle.deriveBits(
            { name: 'PBKDF2', salt: saltBytes, iterations: iterations, hash: 'SHA-256' }, k, dkLen * 8);
        })
        .then(function (bits) { return new Uint8Array(bits); });
    }
    return Promise.resolve(pbkdf2BytesRaw(pwBytes, saltBytes, iterations, dkLen));
  }

  /* ======================================================================
     3. 三套算法
     ====================================================================== */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** UTC：yyyy-MM-dd HH:mm:ss（等价 C# DateTime.ToString("yyyy-MM-dd HH:mm:ss")） */
  function utcStamp(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' +
      pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
  }

  /** 本地：yyyyMMddHHmm（等价 C# 端 datePart，注意 C# 用的是**本地时间**） */
  function localStamp(ms) {
    var d = new Date(ms);
    return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      pad2(d.getHours()) + pad2(d.getMinutes());
  }

  function joinBytes(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  }

  /* ---- 本机密钥存取 ---- */

  function getKeys() {
    var saved = DS.lsGet(LS_KEYS, null);
    var out = DS.clone(EMPTY_KEYS);
    if (saved && typeof saved === 'object' && !DS.isArr(saved)) {
      if (typeof saved.toolbox === 'string') out.toolbox = saved.toolbox;
      if (typeof saved.sxzwz === 'string') out.sxzwz = saved.sxzwz;
      if (saved.lyt && typeof saved.lyt === 'object' && !DS.isArr(saved.lyt)) {
        ['baseKeyHex', 'baseSaltHex', 'pepperHex', 'secretKeyHex'].forEach(function (n) {
          if (typeof saved.lyt[n] === 'string') out.lyt[n] = saved.lyt[n];
        });
      }
    }
    return out;
  }

  function saveKeys(k) { DS.lsSet(LS_KEYS, k); }

  /** 某个生成器的密钥是否已配置 */
  function hasKeys(k) {
    var all = getKeys();
    if (k === 'lyt') {
      return !!(all.lyt.baseKeyHex && all.lyt.baseSaltHex && all.lyt.pepperHex && all.lyt.secretKeyHex);
    }
    return !!all[k];
  }

  /**
   * 离线版：AES-256-CBC + PBKDF2，等价 C# LicenseGenerator.GenerateLicenseKey
   * @param {string} machineCode 机器码（8 组 4 位十六进制）
   * @param {number} typeNum 1=试用 2=专业 3=永久
   * @param {number|null} expiryMs 自定义到期（毫秒）；永久或留空时忽略
   * @param {object} lk 密钥 {baseKeyHex, baseSaltHex, pepperHex, secretKeyHex}
   */
  function generateLyt(machineCode, typeNum, expiryMs, lk) {
    var t = parseInt(typeNum, 10) || 1;
    if (t !== 1 && t !== 2 && t !== 3) t = 1;

    var expiryStr;
    if (t === 3) {
      expiryStr = '9999-12-31 23:59:59';                  // 对应 C# DateTime.MaxValue
    } else if (expiryMs) {
      expiryStr = utcStamp(expiryMs);
    } else {
      expiryStr = utcStamp(Date.now() + (t === 2 ? 30 : 3) * 86400000);
    }

    var pepper = hexToAscii(lk.pepperHex);
    var secretKey = hexToAscii(lk.secretKeyHex);

    return sha256HexUpper(utf8Bytes(machineCode + pepper)).then(function (fullHash) {
      var hwChecksum = fullHash.substring(0, 16);
      var licenseData = machineCode + '|' + t + '|' + expiryStr + '|' + hwChecksum + '|' + secretKey;

      return sha256HexUpper(utf8Bytes(licenseData + pepper)).then(function (hash) {
        var raw = machineCode + '|' + t + '|' + expiryStr + '|' + hwChecksum + '|' + hash;

        // 明文 = raw + pepper（对应 C# 先拼 pepper 再 AES 加密）
        var plain = joinBytes(utf8Bytes(raw), hexToBytes(lk.pepperHex));
        var baseKey = hexToBytes(lk.baseKeyHex);
        var salt = hexToBytes(lk.baseSaltHex);

        return Promise.all([
          pbkdf2Async(joinBytes(baseKey, utf8Bytes('LICENSE')), salt, LYT.iterations, 32),
          pbkdf2Async(joinBytes(baseKey, utf8Bytes('LICENSE_IV')), salt, LYT.iterations, 16)
        ]).then(function (ks) {
          var enc = aesCbcEncryptRaw(ks[0], ks[1], plain);
          return {
            licenseKey: formatLyt(bytesToBase64(enc)),
            info: {
              typeNum: t,
              typeName: LYT.typeNames[t],
              expiry: t === 3 ? '永久有效' : expiryStr,
              expiryMs: t === 3 ? null : (expiryMs || null),
              hwChecksum: hwChecksum
            }
          };
        });
      });
    });
  }

  /** 每 5 个字符插 '-'，末尾加 '-LYT'，等价 C# FormatLicenseKey（保留 = 填充） */
  function formatLyt(b64) {
    var s = '';
    for (var i = 0; i < b64.length; i++) {
      if (i > 0 && i % 5 === 0) s += '-';
      s += b64[i];
    }
    return s + '-LYT';
  }

  /**
   * 工具箱 / 在线版：HMAC-SHA256，等价统一授权管理.html 的 generateHmacLicense
   * @param {string} machineCode 机器码（BJXL- 或 SXZWZ- 开头）
   * @param {number} expiryMs 到期时间（毫秒）
   * @param {string} secretSalt 该端的盐
   */
  function generateHmac(machineCode, expiryMs, secretSalt) {
    var isSx = machineCode.indexOf('SXZWZ-') === 0;
    var prefix = isSx ? 'SXZWZ' : 'BJXL';
    var pLen = isSx ? 6 : 5;
    var machineHash = machineCode.substring(pLen);
    var datePart = localStamp(expiryMs);

    if (datePart.length !== 12) return Promise.reject(new Error('到期时间格式异常'));

    return sha256BytesAsync(utf8Bytes(secretSalt)).then(function (authSalt) {
      var coreSigData = machineHash + '|' + datePart + '|' + machineCode;

      return hmacSha256Async(authSalt, utf8Bytes(coreSigData)).then(function (sig) {
        var sigBytes = sig.subarray(0, 12);
        var dateBytes = utf8Bytes(datePart);
        var xored = new Uint8Array(12);
        for (var i = 0; i < 12; i++) xored[i] = dateBytes[i] ^ sigBytes[i] ^ 0x55;

        var coreSig = bytesToBase64Url(sigBytes);
        var dateToken = bytesToBase64Url(xored);

        return hmacSha256Async(authSalt, utf8Bytes(coreSig + dateToken)).then(function (vh) {
          var verify = bytesToBase64Url(vh.subarray(0, 5)).substring(0, 7);
          var licenseKey = prefix + '-' + coreSig + '-' + dateToken + '-' + verify;
          return {
            licenseKey: licenseKey,
            info: {
              typeNum: 0,
              typeName: '时限授权',
              expiry: new Date(expiryMs).toLocaleString(),
              expiryMs: expiryMs,
              hwChecksum: ''
            }
          };
        });
      });
    });
  }

  /**
   * 离线版自检：用 Node crypto 之外的办法做不到（需要 AES 解密），
   * 这里只做结构校验；真正的验签在 tools/test-license.js 里用 C# 跑。
   */
  function checkLytShape(key) {
    if (!/-LYT$/.test(key)) return '末尾缺少 -LYT';
    var body = key.replace(/-LYT$/, '').replace(/-/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return 'Base64 字符集异常';
    if (body.replace(/=+$/, '').length % 4 > 1) return 'Base64 长度异常';
    return '';
  }

  /**
   * HMAC 方案的自检：解回日期并验签，等价桌面版的 selfValidate
   *
   * ⚠️ 解析必须按**固定位置**切（0-15 / 17-32 / 34-40），不能 split('-')：
   *    base64url 会把 '+' 映射成 '-'，段内自带连字符是正常现象，
   *    客户端（C# ValidateLicenseKey）也是按固定位置解析的。
   */
  function checkHmac(key, secretSalt) {
    var isSx = key.indexOf('SXZWZ') === 0;
    var isBj = key.indexOf('BJXL') === 0;
    if (!isSx && !isBj) return Promise.resolve('前缀不是 BJXL / SXZWZ');

    var body = key.substring(isSx ? 6 : 5);
    if (body.length < 41) return Promise.resolve('长度不足：' + body.length);

    var cSig = body.substring(0, 16);
    var dTok = body.substring(17, 33);
    var vfy = body.substring(34, 41);

    return sha256BytesAsync(utf8Bytes(secretSalt)).then(function (authSalt) {
      return hmacSha256Async(authSalt, utf8Bytes(cSig + dTok)).then(function (vh) {
        var computed = bytesToBase64Url(vh.subarray(0, 5));
        if (computed !== vfy) return '签名不匹配';
        return '';
      });
    });
  }

  /* ======================================================================
     4. 记录（本机 localStorage）
     ====================================================================== */

  function getRecords() {
    var arr = DS.lsGet(LS_RECORDS, []);
    return DS.isArr(arr) ? arr : [];
  }

  function saveRecords(arr) {
    if (arr.length > MAX_RECORDS) arr = arr.slice(0, MAX_RECORDS);
    DS.lsSet(LS_RECORDS, arr);
  }

  function addRecord(rec) {
    rec.id = DS.uid();
    rec.at = new Date().toISOString();
    var arr = getRecords();
    arr.unshift(rec);
    saveRecords(arr);
    return rec;
  }

  function findRecord(id) {
    var arr = getRecords();
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }

  function removeRecord(id) {
    saveRecords(getRecords().filter(function (r) { return r.id !== id; }));
  }

  function expired(rec) {
    if (rec.expiryMs === null || rec.expiryMs === undefined) return false;   // 永久
    return rec.expiryMs <= Date.now();
  }

  /* ======================================================================
     5. 渲染 —— 生成页
     ====================================================================== */

  function formFieldsHtml() {
    var m = META[kind];
    var h = '';

    if (kind === 'lyt') {
      h += DS.input({
        name: 'lic_mc', label: '机器码', required: true, mono: true,
        placeholder: m.mcHint, help: m.mcHelp
      });
      h += DS.select({
        name: 'lic_type', label: '授权类型', value: '2',
        options: [
          { value: '1', label: '试用版（3 天）' },
          { value: '2', label: '专业版（30 天）' },
          { value: '3', label: '永久版' }
        ]
      });
      h += DS.input({
        name: 'lic_exp', label: '自定义到期（可选）', inputType: 'datetime-local',
        help: '留空则按授权类型自动算；填写时按 UTC 写入授权码'
      });
    } else {
      h += DS.input({ name: 'lic_user', label: '被授权人', required: true, placeholder: '姓名 / 备注' });
      h += DS.input({
        name: 'lic_mc', label: '机器码', required: true, mono: true,
        placeholder: m.mcHint, help: m.mcHelp
      });
      h += DS.input({ name: 'lic_exp', label: '到期时间', required: true, inputType: 'datetime-local' });
      h += DS.number({ name: 'lic_days', label: '天数（与到期时间联动）', value: 365, min: 1 });
    }
    return h;
  }

  function quickButtonsHtml() {
    if (kind === 'lyt') {
      return DS.actions([
        { text: '试用 3 天', onClick: { name: 'license:quick', payload: { mode: 'trial' } } },
        { text: '专业 30 天', onClick: { name: 'license:quick', payload: { mode: 'pro' } } },
        { text: '永久', onClick: { name: 'license:quick', payload: { mode: 'perm' } } }
      ]);
    }
    return DS.actions([
      { text: '1 年', onClick: { name: 'license:quick', payload: { mode: 'y1' } } },
      { text: '永久（2099）', onClick: { name: 'license:quick', payload: { mode: 'perm' } } }
    ]);
  }

  function renderGen(pageId, el) {
    var m = META[kind];

    var html = DS.fchips(KINDS, kind, 'license:kind');

    // 密钥没配：给引导，不给表单（表单即使填了也生成不了）
    if (!hasKeys(kind)) {
      html += DS.card(
        '<div class="empty" style="padding:26px 12px">' +
        '<span class="e-ic">🔐</span>' +
        '<div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:6px">还没配置 ' + DS.esc(m.label) + ' 的签发密钥</div>' +
        '<div class="muted tiny" style="margin-bottom:16px;line-height:1.8">这个站点是公开的，密钥不能写进代码。<br>' +
        '在「密钥」页输入一次，只存在你手机浏览器里。</div>' +
        '<button class="btn btn-primary btn-block"' + DS.act('license:tokeys') + '>去配置密钥</button>' +
        '</div>', { tight: true });
      html += '<div id="license-result"></div>';
      el.innerHTML = html;
      return;
    }

    html += DS.card(
      DS.banner('生成方式：<b>' + DS.esc(m.scheme) + '</b>　｜　本模块不联网，结果只存在本机', 'info') +
      formFieldsHtml() +
      quickButtonsHtml() +
      DS.actions([{ text: '✨ 生成授权码', cls: 'btn-primary', onClick: { name: 'license:gen' } }]),
      { title: m.ic + ' ' + m.label + ' 授权码' }
    );

    html += '<div id="license-result"></div>';

    html += '<div class="section-h">说明</div>' +
      DS.card(
        DS.kv([
          { k: '算法', v: m.scheme },
          { k: '机器码要求', v: kind === 'lyt' ? '8 组 4 位十六进制' : '必须以 ' + m.prefix + ' 开头' },
          { k: '离线版有效期', v: '试用 3 天 / 专业 30 天 / 永久' },
          { k: '数据存放', v: '手机浏览器本地（最多 300 条）' },
          { k: '签发密钥', v: '在「密钥」页输入，只存本机' }
        ]) +
        '<div class="lic-note">换手机或清浏览器数据后需要重新配一次密钥；' +
        '在「密钥」页可以导出/导入密钥包来迁移。</div>'
      );

    el.innerHTML = html;
    bindGen(el);
  }

  function bindGen(root) {
    if (!root || !root.querySelector) return;
    var exp = root.querySelector('[data-name="lic_exp"]');
    var days = root.querySelector('[data-name="lic_days"]');
    if (exp && days && exp.addEventListener) {
      days.addEventListener('change', function () {
        var d = parseInt(days.value, 10);
        if (d > 0 && d <= 36500) {
          var t = new Date(Date.now() + d * 86400000);
          exp.value = localInput(t);
        }
      });
      exp.addEventListener('change', function () {
        if (!exp.value) return;
        var diff = Math.ceil((new Date(exp.value).getTime() - Date.now()) / 86400000);
        if (diff > 0) days.value = diff;
      });
    }
    // 首次进入时给个默认到期，省得用户手动点
    if (exp && !exp.value && days && days.value) {
      var t0 = new Date(Date.now() + (parseInt(days.value, 10) || 365) * 86400000);
      exp.value = localInput(t0);
    }
  }

  /** Date → datetime-local 输入框的值（本地时间，yyyy-MM-ddTHH:mm） */
  function localInput(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function readForm() {
    var root = DS.$('#content');
    var f = root ? DS.formData(root) : {};
    return {
      mc: String(f.lic_mc === undefined || f.lic_mc === null ? '' : f.lic_mc).trim(),
      user: String(f.lic_user === undefined || f.lic_user === null ? '' : f.lic_user).trim(),
      type: String(f.lic_type === undefined || f.lic_type === null ? '2' : f.lic_type),
      exp: String(f.lic_exp === undefined || f.lic_exp === null ? '' : f.lic_exp).trim(),
      days: f.lic_days
    };
  }

  function setResult(html) {
    var box = DS.$('#license-result');
    if (box) box.innerHTML = html;
  }

  function resultCard(rec, title) {
    return DS.card(
      '<div class="lic-key" id="license-key-box">' + DS.esc(rec.licenseKey) + '</div>' +
      DS.actions([
        { text: '📋 复制授权码', cls: 'btn-primary', onClick: { name: 'license:copy', payload: { text: rec.licenseKey } } },
        { text: '查看记录', onClick: { name: 'license:torecords' } }
      ]) +
      DS.kv([
        { k: '类型', v: rec.typeName },
        { k: '机器码', v: rec.machineCode, mono: true },
        { k: '到期', v: rec.expiryText },
        { k: '自检', v: rec.selfCheck || '通过' },
        { k: '生成时间', v: DS.fmtTime(rec.at) }
      ]),
      { title: title || '✅ 生成成功' }
    );
  }

  function doGenerate(overrideExpiryMs) {
    var f = readForm();
    var m = META[kind];

    if (!f.mc) { DS.toast('请填写机器码', 'err'); return; }
    if (kind === 'lyt') {
      f.mc = f.mc.toUpperCase();
      if (!/^[0-9A-F]{4}(-[0-9A-F]{4}){7}$/.test(f.mc)) {
        DS.toast('机器码格式不对：应为 8 组 4 位十六进制，如 1A2B-3C4D-…', 'err');
        return;
      }
    } else {
      if (f.mc.indexOf(m.prefix) !== 0) {
        DS.toast('机器码必须以 ' + m.prefix + ' 开头', 'err');
        return;
      }
      if (!f.user) { DS.toast('请填写被授权人', 'err'); return; }
    }

    var fromInput = f.exp ? new Date(f.exp).getTime() : 0;
    if (isNaN(fromInput)) fromInput = 0;

    var keys = getKeys();
    var expiryMs;
    if (kind === 'lyt') {
      // type=3 永久时忽略到期时间（与 C# LicenseGenerator 一致）
      expiryMs = f.type === '3'
        ? null
        : (overrideExpiryMs || fromInput || Date.now() + (f.type === '2' ? 30 : 3) * 86400000);
    } else {
      expiryMs = overrideExpiryMs || fromInput;
      if (!expiryMs) { DS.toast('请选择到期时间', 'err'); return; }
    }

    setResult('<div class="lic-key">生成中…（离线版要做 2 万次 PBKDF2 迭代，约 1 秒）</div>');

    var job = kind === 'lyt'
      ? generateLyt(f.mc, f.type, expiryMs, keys.lyt)
      : generateHmac(f.mc, expiryMs, keys[kind]);

    return job.then(function (res) {
      return checkShapeOrHmac(kind, res.licenseKey, kind === 'lyt' ? null : keys[kind]).then(function (selfCheck) {
        var rec = addRecord({
          kind: kind,
          kindLabel: m.label,
          machineCode: f.mc,
          user: f.user,
          licenseKey: res.licenseKey,
          typeName: res.info.typeName,
          expiryMs: res.info.expiryMs,
          expiryText: res.info.expiry,
          selfCheck: selfCheck
        });
        setResult(resultCard(rec, res.info.typeName + ' · 生成成功'));
        DS.toast('已生成，已存入本机记录', 'ok');
      });
    }).catch(function (e) {
      setResult(DS.errBox('生成失败：' + DS.esc(e && e.message ? e.message : String(e))));
    });
  }

  function checkShapeOrHmac(k, key, salt) {
    if (k === 'lyt') {
      var bad = checkLytShape(key);
      return Promise.resolve(bad ? '⚠️ ' + bad : '结构校验通过');
    }
    return checkHmac(key, salt).then(function (bad) {
      return bad ? '⚠️ ' + bad : '签名自检通过';
    });
  }

  /* ======================================================================
     6. 渲染 —— 记录页
     ====================================================================== */

  function renderRecords(pageId, el) {
    var all = getRecords();
    var byKind = { toolbox: 0, sxzwz: 0, lyt: 0 };
    var okCount = 0;
    all.forEach(function (r) {
      if (byKind[r.kind] !== undefined) byKind[r.kind]++;
      if (!expired(r)) okCount++;
    });

    var html = DS.statGrid([
      { icon: '🔑', label: '记录总数', value: all.length },
      { icon: '✅', label: '有效', value: okCount },
      { icon: '⏳', label: '已过期', value: all.length - okCount },
      { icon: '🧰', label: '工具箱', value: byKind.toolbox },
      { icon: '📝', label: '在线版', value: byKind.sxzwz },
      { icon: '💻', label: '离线版', value: byKind.lyt }
    ]);

    if (!all.length) {
      html += DS.card(DS.empty('还没有生成过授权码', '🔑'), { tight: true });
      el.innerHTML = html;
      return;
    }

    var items = all.map(function (r) {
      var m = META[r.kind] || META.toolbox;
      var isPerm = r.expiryMs === null || r.expiryMs === undefined;
      var isExp = expired(r);
      var badge = isExp
        ? DS.dot('已过期', 'err')
        : DS.dot(isPerm ? '永久' : '有效', 'ok');
      return DS.li({
        ic: m.ic,
        title: DS.short(r.user || r.machineCode, 26),
        sub: DS.short(r.licenseKey, 42),
        badge: badge,
        right: '<button class="btn btn-sm btn-outline"' +
          DS.act('license:copy', { text: r.licenseKey }) + '>复制</button>',
        rawRight: true,
        onClick: { name: 'license:open', payload: { id: r.id } }
      });
    });

    html += DS.card(DS.list(items), { tight: true });
    html += DS.actions([
      { text: '📥 导出 JSON', onClick: { name: 'license:export' } },
      { text: '🗑 清空记录', cls: 'btn-danger', onClick: { name: 'license:clear' } }
    ]);

    el.innerHTML = html;
  }

  /* ======================================================================
     7. 渲染 —— 密钥页
     ====================================================================== */

  function renderKeys(pageId, el) {
    var k = getKeys();

    var html = DS.banner('签发密钥只存在本机浏览器（localStorage <code>license.keys</code>）。' +
      '代码里没有、部署包里也没有。换手机或清浏览器数据后要重配一次。', 'info');

    html += DS.card(
      KEY_FIELDS.map(function (f) {
        var val = f.name.indexOf('.') > 0 ? k.lyt[f.name.split('.')[1]] : k[f.name];
        return DS.input({
          name: 'lk_' + f.name.replace('.', '_'), label: f.label, value: val,
          mono: true, placeholder: f.ph, help: f.hint
        });
      }).join('') +
      DS.actions([{ text: '💾 保存密钥', cls: 'btn-primary', onClick: { name: 'license:savekeys' } }]),
      { title: '🔐 签发密钥' }
    );

    html += '<div class="section-h">配置状态</div>';
    html += DS.card(DS.list(KINDS.map(function (c) {
      var okk = hasKeys(c.v);
      return DS.li({
        ic: META[c.v].ic,
        title: META[c.v].label,
        sub: META[c.v].scheme,
        badge: okk ? DS.dot('已配置', 'ok') : DS.dot('未配置', 'warn')
      });
    })), { tight: true });

    html += '<div class="section-h">换机迁移</div>';
    html += DS.card(
      DS.textarea({
        name: 'lk_import', label: '粘贴密钥包（JSON）', rows: 5,
        placeholder: '{"toolbox":"…","sxzwz":"…","lyt":{"baseKeyHex":"…",…}}',
        help: '在电脑上把密钥包复制下来发给自己（微信文件传输助手），手机上粘贴导入，一次搞定 6 项'
      }) +
      DS.actions([
        { text: '📥 导入', onClick: { name: 'license:importkeys' } },
        { text: '📤 复制密钥包', onClick: { name: 'license:exportkeys' } },
        { text: '🗑 清除密钥', cls: 'btn-danger', onClick: { name: 'license:clearkeys' } }
      ])
    );

    el.innerHTML = html;
  }

  /* ======================================================================
     8. 事件
     ====================================================================== */

  DS.on('license:kind', function (v) {
    if (!META[v]) return;
    kind = v;
    DS.lsSet(LS_KIND, kind);
    DS.refresh();
  });

  DS.on('license:torecords', function () { DS.goPage('records'); });
  DS.on('license:tokeys', function () { DS.goPage('keys'); });

  DS.on('license:savekeys', function () {
    var root = DS.$('#content');
    var f = root ? DS.formData(root) : {};
    var k = getKeys();
    var bad = [];
    k.toolbox = String(f.lk_toolbox === undefined ? '' : f.lk_toolbox).trim();
    k.sxzwz = String(f.lk_sxzwz === undefined ? '' : f.lk_sxzwz).trim();
    ['baseKeyHex', 'baseSaltHex', 'pepperHex', 'secretKeyHex'].forEach(function (n) {
      k.lyt[n] = String(f['lk_lyt_' + n] === undefined ? '' : f['lk_lyt_' + n]).trim();
    });
    // 离线版的四项要么全填要么全空，填一半最容易排查半天
    var lytFilled = ['baseKeyHex', 'baseSaltHex', 'pepperHex', 'secretKeyHex']
      .filter(function (n) { return !!k.lyt[n]; }).length;
    if (lytFilled > 0 && lytFilled < 4) bad.push('离线版的 4 项密钥要么全填要么全空（现在只填了 ' + lytFilled + ' 项）');
    if (bad.length) { DS.toast(bad[0], 'err'); return; }
    saveKeys(k);
    DS.toast('已保存到本机', 'ok');
    DS.refresh();
  });

  DS.on('license:importkeys', function () {
    var root = DS.$('#content');
    var f = root ? DS.formData(root) : {};
    var raw = String(f.lk_import === undefined ? '' : f.lk_import).trim();
    if (!raw) { DS.toast('请先粘贴密钥包', 'err'); return; }
    var obj;
    try { obj = JSON.parse(raw); } catch (e) { DS.toast('不是合法 JSON：' + e.message, 'err'); return; }
    if (obj && obj.keys && typeof obj.keys === 'object') obj = obj.keys;   // 兼容导出时的包装

    var cur = getKeys();
    if (typeof obj.toolbox === 'string') cur.toolbox = obj.toolbox.trim();
    if (typeof obj.sxzwz === 'string') cur.sxzwz = obj.sxzwz.trim();
    if (obj.lyt && typeof obj.lyt === 'object') {
      ['baseKeyHex', 'baseSaltHex', 'pepperHex', 'secretKeyHex'].forEach(function (n) {
        if (typeof obj.lyt[n] === 'string') cur.lyt[n] = obj.lyt[n].trim();
      });
    }
    saveKeys(cur);
    DS.toast('导入成功，已保存到本机', 'ok');
    DS.refresh();
  });

  DS.on('license:exportkeys', function () {
    DS.copy(JSON.stringify({ app: 'mobile-admin', keys: getKeys() }, null, 2));
  });

  DS.on('license:clearkeys', function () {
    DS.confirm({
      title: '清除本机密钥',
      msg: '清除后三套生成器都不能用，需要重新输入。生成过的授权码记录不受影响。',
      okText: '清除', danger: true
    }).then(function (yes) {
      if (!yes) return;
      saveKeys(DS.clone(EMPTY_KEYS));
      DS.toast('已清除', 'ok');
      DS.refresh();
    });
  });

  DS.on('license:gen', function () { doGenerate(null); });

  DS.on('license:quick', function (p) {
    var mode = p && p.mode;
    var ms = null;
    var DAY = 86400000;
    if (mode === 'trial') ms = Date.now() + 3 * DAY;
    else if (mode === 'pro') ms = Date.now() + 30 * DAY;
    else if (mode === 'y1') ms = Date.now() + 365 * DAY;
    else if (mode === 'perm') ms = new Date('2099-12-31T23:59:00').getTime();

    if (kind === 'lyt') {
      var sel = DS.$('#f_lic_type');
      var expEl = DS.$('#f_lic_exp');
      if (mode === 'perm') { if (sel) sel.value = '3'; ms = null; }
      else if (sel) sel.value = (mode === 'trial' ? '1' : '2');
      if (expEl && ms) expEl.value = localInput(new Date(ms));
      doGenerate(ms);
      return;
    }
    var expEl2 = DS.$('#f_lic_exp');
    if (expEl2 && ms) expEl2.value = localInput(new Date(ms));
    doGenerate(ms);
  });

  DS.on('license:copy', function (p) {
    if (p && p.text) DS.copy(p.text);
  });

  DS.on('license:open', function (p) {
    var r = findRecord(p && p.id);
    if (!r) { DS.toast('记录不存在', 'err'); return; }
    var m = META[r.kind] || META.toolbox;
    DS.sheet({
      title: m.ic + ' ' + r.kindLabel,
      html:
        '<div class="lic-key">' + DS.esc(r.licenseKey) + '</div>' +
        DS.kv([
          { k: '类型', v: r.typeName },
          { k: '机器码', v: r.machineCode, mono: true },
          r.user ? { k: '被授权人', v: r.user } : null,
          { k: '到期', v: r.expiryText },
          { k: '状态', v: expired(r) ? '已过期' : '有效' },
          { k: '自检', v: r.selfCheck || '-' },
          { k: '生成时间', v: DS.fmtTime(r.at) }
        ]),
      buttons: [
        {
          text: '复制', cls: 'btn-primary',
          onClick: function () { DS.copy(r.licenseKey); return false; }
        },
        {
          text: '删除记录', cls: 'btn-danger',
          onClick: function (close) {
            removeRecord(r.id);
            close();
            DS.toast('已删除', 'ok');
            DS.refresh();
            return false;
          }
        }
      ]
    });
  });

  DS.on('license:export', function () {
    var data = { exportTime: new Date().toISOString(), records: getRecords() };
    DS.download(
      'license-records-' + new Date().toISOString().slice(0, 10) + '.json',
      JSON.stringify(data, null, 2),
      'application/json;charset=utf-8'
    );
  });

  DS.on('license:clear', function () {
    DS.confirm({
      title: '清空全部记录',
      msg: '本机保存的 ' + getRecords().length + ' 条授权码记录将被删除，不可恢复。',
      okText: '清空', danger: true
    }).then(function (yes) {
      if (!yes) return;
      saveRecords([]);
      DS.toast('已清空', 'ok');
      DS.refresh();
    });
  });

  /* ======================================================================
     8. 注册模块
     ====================================================================== */

  DS.registerModule({
    id: 'license',
    name: '授权码生成',
    tabName: '授权码',
    icon: '🔑',
    subtitle: '工具箱 · 在线版 · 离线版',
    conns: [],
    pages: [
      { id: 'gen', title: '生成' },
      { id: 'records', title: '记录' },
      { id: 'keys', title: '密钥' }
    ],
    render: function (pageId, el) {
      if (pageId === 'records') return renderRecords(pageId, el);
      if (pageId === 'keys') return renderKeys(pageId, el);
      return renderGen(pageId, el);
    }
  });

  /* ----------------------------------------------------------------------
     纯算法出口：**不含任何 DOM 依赖，也不含任何密钥**（密钥由调用方传入），
     供 tools/test-license.js 在 Node 里直接与 crypto 模块 / 真实 C# 工程交叉验签。
     浏览器里只是一个只读引用，不产生副作用。
     ---------------------------------------------------------------------- */
  window.__LICENSE_CORE__ = {
    // opts: { machineCode, type, expiryMs, lytKeys } 或 { machineCode, expiryMs, salt }
    generate: function (k, opts) {
      opts = opts || {};
      if (k === 'lyt') return generateLyt(opts.machineCode, opts.type, opts.expiryMs, opts.lytKeys);
      return generateHmac(opts.machineCode, opts.expiryMs, opts.salt);
    },
    generateLyt: generateLyt,
    generateHmac: generateHmac,
    checkHmac: checkHmac,
    checkLytShape: checkLytShape,
    // 非密钥参数表（测试脚本用来做对照，避免把常量抄两遍）
    config: { lyt: LYT, meta: META, keyFields: KEY_FIELDS },
    // 底层原语，测试脚本用来自证与 Node crypto 一致
    primitives: {
      hasSubtle: function () { return HAS_SUBTLE; },
      sha256HexUpper: function (s) { return sha256HexUpper(utf8Bytes(s)); },
      hmacSha256: function (key, msg) { return hmacSha256Async(key, utf8Bytes(msg)); },
      pbkdf2: function (pw, salt, iters, len) { return pbkdf2Async(pw, salt, iters, len); },
      aesCbcEncrypt: function (key, iv, data) { return aesCbcEncryptRaw(key, iv, data); },
      bytesToBase64: bytesToBase64,
      utf8Bytes: utf8Bytes,
      hexToBytes: hexToBytes,
      hexToAscii: hexToAscii
    }
  };
})();
