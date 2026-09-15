/*!
 * decode.js — 部件正文解码（base64 / quoted-printable）、字符集嗅探、data URI 编码
 * 纯逻辑，无 DOM 依赖。
 */
(function (global) {
  'use strict';

  var B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var hasBtoa = typeof btoa === 'function';
  var hasAtob = typeof atob === 'function';

  /* ---------------- base64 ---------------- */

  var B64_LOOKUP = (function () {
    var t = new Uint8Array(256), i;
    for (i = 0; i < 256; i++) t[i] = 255;
    for (i = 0; i < B64CHARS.length; i++) t[B64CHARS.charCodeAt(i)] = i;
    t['-'.charCodeAt(0)] = 62; // URL-safe 兼容
    t['_'.charCodeAt(0)] = 63;
    return t;
  })();

  /** base64 字符串 -> Uint8Array（自动忽略换行/空白，容忍缺失填充） */
  function base64ToBytes(input) {
    var s = String(input).replace(/[\s\r\n]/g, '');
    if (!s) return new Uint8Array(0);
    if (hasAtob) {
      // 补齐 padding，浏览器 atob 要求长度是 4 的倍数
      var pad = s.length % 4;
      if (pad === 1) s = s.slice(0, -1);
      else if (pad) s += '===='.slice(0, 4 - pad);
      var bin;
      try {
        bin = atob(s);
      } catch (e) {
        bin = null;
      }
      if (bin !== null) {
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
        return out;
      }
    }
    return base64ToBytesFallback(s);
  }

  function base64ToBytesFallback(s) {
    var len = s.length;
    var out = new Uint8Array(((len * 3) >> 2) + 3);
    var p = 0, buffer = 0, bits = 0, i, v;
    for (i = 0; i < len; i++) {
      v = B64_LOOKUP[s.charCodeAt(i)];
      if (v === 255) continue;
      buffer = (buffer << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[p++] = (buffer >> bits) & 0xff;
      }
    }
    return out.subarray(0, p);
  }

  /** Uint8Array -> base64 字符串（分块，避免超长参数） */
  function bytesToBase64(bytes) {
    var CHUNK = 0x8000, parts = [], i;
    if (hasBtoa) {
      for (i = 0; i < bytes.length; i += CHUNK) {
        parts.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length))));
      }
      return btoa(parts.join(''));
    }
    return bytesToBase64Manual(bytes);
  }

  function bytesToBase64Manual(bytes) {
    var out = [], i, b0, b1, b2;
    for (i = 0; i < bytes.length; i += 3) {
      b0 = bytes[i];
      b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out.push(B64CHARS.charAt(b0 >> 2));
      out.push(B64CHARS.charAt(((b0 & 3) << 4) | (b1 >> 4)));
      out.push(i + 1 < bytes.length ? B64CHARS.charAt(((b1 & 15) << 2) | (b2 >> 6)) : '=');
      out.push(i + 2 < bytes.length ? B64CHARS.charAt(b2 & 63) : '=');
    }
    return out.join('');
  }

  /* ---------------- quoted-printable ---------------- */

  function isHexChar(c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
  }

  /** 解码 quoted-printable：处理软换行（=\r\n）与 =XX，输出仍是 latin1 字符串 */
  function decodeQuotedPrintable(text) {
    var out = [], last = 0, i = 0, len = text.length, eq, c1, c2;
    while (i < len) {
      eq = text.indexOf('=', i);
      if (eq < 0 || eq + 1 >= len) break;
      c1 = text.charAt(eq + 1);
      c2 = text.charAt(eq + 2);
      if (c1 === '\r' && c2 === '\n') {
        out.push(text.slice(last, eq));
        i = last = eq + 3;
      } else if (c1 === '\n') {
        out.push(text.slice(last, eq));
        i = last = eq + 2;
      } else if (isHexChar(c1) && isHexChar(c2)) {
        out.push(text.slice(last, eq), String.fromCharCode(parseInt(c1 + c2, 16)));
        i = last = eq + 3;
      } else {
        i = eq + 1; // 非法转义，原样保留该 '='
      }
    }
    out.push(text.slice(last));
    return out.join('');
  }

  /* ---------------- 字符集 ---------------- */

  var CHARSET_ALIAS = {
    'utf8': 'utf-8',
    'utf-8': 'utf-8',
    'unicode-1-1-utf-8': 'utf-8',
    'gb2312': 'gb18030',
    'gbk': 'gb18030',
    'gb-2312': 'gb18030',
    'gb_2312-80': 'gb18030',
    'x-gbk': 'gb18030',
    'csgb2312': 'gb18030',
    'ansi': 'windows-1252',
    'latin1': 'windows-1252',
    'iso-8859-1': 'windows-1252',
    'us-ascii': 'windows-1252',
    'shift-jis': 'shift_jis',
    'sjis': 'shift_jis',
    'ks_c_5601-1987': 'euc-kr',
    'utf-16': 'utf-16le'
  };

  function normalizeCharset(name) {
    var n = String(name || '').trim().toLowerCase().replace(/^["']|["']$/g, '');
    if (!n) return '';
    return CHARSET_ALIAS[n] || n;
  }

  function detectBom(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return { charset: 'utf-8', offset: 3 };
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { charset: 'utf-16le', offset: 2 };
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { charset: 'utf-16be', offset: 2 };
    return null;
  }

  /** 从正文前几 KB（按 ASCII 安全方式）抓取 meta charset 声明 */
  function sniffCharsetFromBytes(bytes, limit) {
    var n = Math.min(bytes.length, limit || 4096), s = '', i;
    for (i = 0; i < n; i++) {
      var b = bytes[i];
      s += b < 0x80 ? String.fromCharCode(b) : ' ';
    }
    var m = /charset\s*=\s*["']?\s*([a-z0-9_\-:.]+)/i.exec(s);
    return m ? m[1] : '';
  }

  function tryDecode(bytes, charset) {
    try {
      var dec = new TextDecoder(charset, { fatal: false });
      return dec.decode(bytes);
    } catch (e) {
      return null;
    }
  }

  function countReplacementChars(text) {
    var m = text.match(/\uFFFD/g);
    return m ? m.length : 0;
  }

  /**
   * 尽最大努力把字节解成文本：优先 BOM / 声明 / utf-8，
   * utf-8 出现替换字符时再尝试 GB18030、Big5 等，取"坏字符最少"的结果。
   */
  function decodeText(bytes, charsetHint) {
    var bom = detectBom(bytes);
    var candidates = [];
    if (bom) candidates.push(bom.charset);
    var hint = normalizeCharset(charsetHint);
    if (hint) candidates.push(hint);
    candidates.push('utf-8');
    if (hint !== 'gb18030' && hint !== 'big5') candidates.push('gb18030', 'big5');
    candidates.push('windows-1252');

    var seen = {}, best = null;
    for (var i = 0; i < candidates.length; i++) {
      var cs = candidates[i];
      if (!cs || seen[cs]) continue;
      seen[cs] = 1;
      var text = tryDecode(bytes, cs);
      if (text === null) continue;
      var bad = countReplacementChars(text);
      var result = { text: text, charset: cs, bad: bad };
      if (bad === 0) return result;
      if (!best || bad < best.bad) best = result;
      // utf-8 已经比较可信时，不必再去试更冷门的编码
      if (best && best.bad < bytes.length / 200 && i > 1) break;
    }
    return best || { text: '', charset: 'utf-8', bad: bytes.length };
  }

  function encodeUtf8(text) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text);
    var utf8 = unescape(encodeURIComponent(text));
    var out = new Uint8Array(utf8.length);
    for (var i = 0; i < utf8.length; i++) out[i] = utf8.charCodeAt(i) & 0xff;
    return out;
  }

  /* ---------------- 部件正文 ---------------- */

  /** 按 Content-Transfer-Encoding 解出部件原始字节 */
  function decodePartBody(part) {
    var enc = String(part.encoding || '').toLowerCase();
    if (enc === 'base64') return base64ToBytes(part.bodyText);
    if (enc === 'quoted-printable') return global.MhtMime.binaryToBytes(decodeQuotedPrintable(part.bodyText));
    return global.MhtMime.binaryToBytes(part.bodyText);
  }

  /** 该类型是否应当按文本处理（需要重写内部引用） */
  function isTextual(mediaType) {
    var mt = String(mediaType || '').toLowerCase();
    if (/^text\//.test(mt)) return true;
    return /(svg\+xml|xml|\+json|javascript|ecmascript|x-sh|x-www-form-urlencoded)/.test(mt);
  }

  function dataUri(mediaType, bytes, charset) {
    var mt = String(mediaType || 'application/octet-stream').replace(/[\r\n]/g, '').trim() || 'application/octet-stream';
    var head = 'data:' + mt + (charset ? ';charset=' + charset : '') + ';base64,';
    return head + bytesToBase64(bytes);
  }

  /** 1x1 透明 GIF，用于替换无法归档的外链图片（避免空白 src 触发再次请求） */
  var BLANK_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  global.MhtDecode = {
    base64ToBytes: base64ToBytes,
    bytesToBase64: bytesToBase64,
    decodeQuotedPrintable: decodeQuotedPrintable,
    normalizeCharset: normalizeCharset,
    sniffCharsetFromBytes: sniffCharsetFromBytes,
    decodeText: decodeText,
    encodeUtf8: encodeUtf8,
    decodePartBody: decodePartBody,
    isTextual: isTextual,
    dataUri: dataUri,
    BLANK_GIF: BLANK_GIF
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
