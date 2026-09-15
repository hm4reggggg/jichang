/*!
 * mime.js — MHT(MHTML) 的 MIME multipart 结构解析
 * 纯逻辑、无 DOM 依赖，可同时在浏览器主线程 / Web Worker / Node 中运行。
 *
 * 思路：把字节按 latin1 一一映射成字符串（1 字符 = 1 字节），
 * 这样所有切片、查找、正则操作都不会破坏二进制部件，最后再原样还原成字节。
 */
(function (global) {
  'use strict';

  var NEARLY_EMPTY_RE = /^[\s\r\n]*$/;

  /* ---------------- 字节 <-> latin1 字符串 ---------------- */

  function bytesToBinary(bytes) {
    var CHUNK = 0x8000, out = '', i;
    for (i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return out;
  }

  function binaryToBytes(str) {
    var out = new Uint8Array(str.length), i;
    for (i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  /* ---------------- 头部解析 ---------------- */

  /** 拆分 `a="x;y"; b=z` 形式的参数列表，引号内的分号不切断 */
  function splitParams(value) {
    var parts = [], buf = '', quote = null, i, c;
    for (i = 0; i < value.length; i++) {
      c = value.charAt(i);
      if (quote) {
        if (c === quote) quote = null;
        else buf += c;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ';') {
        parts.push(buf);
        buf = '';
      } else {
        buf += c;
      }
    }
    parts.push(buf);
    return parts;
  }

  /** 解析 Content-Type，返回 { mediaType, params } */
  function parseContentType(value) {
    var result = { mediaType: '', params: {} };
    if (!value) return result;
    var segs = splitParams(String(value));
    result.mediaType = (segs.shift() || '').trim().toLowerCase();
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i], eq = seg.indexOf('=');
      if (eq < 0) continue;
      result.params[seg.slice(0, eq).trim().toLowerCase()] = seg.slice(eq + 1).trim();
    }
    return result;
  }

  /** 解析部件头；以空格/制表符开头的行视为折行（RFC 5322 续行） */
  function parseHeaders(head) {
    var headers = {};
    var lines = String(head).split(/\r\n|\n|\r/);
    var current = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || NEARLY_EMPTY_RE.test(line)) continue;
      if (/^[ \t]/.test(line)) {
        if (current) headers[current] += ' ' + line.trim();
        continue;
      }
      var m = /^([^:\r\n]+):([\s\S]*)$/.exec(line);
      if (!m) continue;
      var name = m[1].trim().toLowerCase();
      var val = m[2].trim();
      if (Object.prototype.hasOwnProperty.call(headers, name)) headers[name] += ', ' + val;
      else headers[name] = val;
      current = name;
    }
    return headers;
  }

  /** Content-ID 归一化：去掉尖括号与空白 */
  function normalizeCid(value) {
    return String(value || '').trim().replace(/^</, '').replace(/>$/, '').trim();
  }

  function splitHeadBody(text) {
    var i4 = text.indexOf('\r\n\r\n');
    var i2 = text.indexOf('\n\n');
    if (i4 >= 0 && (i2 < 0 || i4 <= i2)) return { head: text.slice(0, i4), body: text.slice(i4 + 4) };
    if (i2 >= 0) return { head: text.slice(0, i2), body: text.slice(i2 + 2) };
    return { head: text, body: '' };
  }

  /* ---------------- boundary 切分 ---------------- */

  function eolAfter(s, from) {
    var i = s.indexOf('\n', from);
    return i < 0 ? s.length : i + 1;
  }

  /** 在 from 之后查找处于行首的边界行，返回该行起始下标 */
  function findBoundaryLine(s, delim, from) {
    if (from <= 0 && s.lastIndexOf(delim, 0) === 0) return 0;
    var idx = s.indexOf('\n' + delim, from);
    return idx < 0 ? -1 : idx + 1;
  }

  function trimOneTrailingEol(s) {
    if (s.slice(-2) === '\r\n') return s.slice(0, -2);
    if (s.slice(-1) === '\n') return s.slice(0, -1);
    return s;
  }

  /** 按 boundary 把 multipart 正文切成各部件正文（去掉边界行本身） */
  function splitParts(body, boundary) {
    var out = [];
    var delim = '--' + boundary;
    var start = findBoundaryLine(body, delim, 0);
    if (start < 0) return out;
    var pos = eolAfter(body, start);
    while (pos <= body.length) {
      var next = findBoundaryLine(body, delim, pos);
      var end = next < 0 ? body.length : next;
      var chunk = body.slice(pos, end);
      if (next >= 0) chunk = trimOneTrailingEol(chunk);
      if (chunk.length) out.push(chunk);
      if (next < 0) break;
      // 结束边界形如 `--boundary--`
      if (body.slice(next + delim.length, next + delim.length + 2) === '--') break;
      pos = eolAfter(body, next);
    }
    return out;
  }

  /* ---------------- 实体解析 ---------------- */

  function parseEntity(text, depth) {
    var hb = splitHeadBody(text);
    var headers = parseHeaders(hb.head);
    var ct = parseContentType(headers['content-type']);
    var encoding = String(headers['content-transfer-encoding'] || '7bit').split(';')[0].trim().toLowerCase();

    var node = {
      depth: depth || 0,
      headers: headers,
      mediaType: ct.mediaType || 'text/plain',
      charset: ct.params.charset || '',
      filename: ct.params.name || ct.params.filename || '',
      encoding: encoding || '7bit',
      contentId: normalizeCid(headers['content-id']),
      location: String(headers['content-location'] || '').trim(),
      base: String(headers['content-base'] || '').trim(),
      children: null,
      bodyText: hb.body
    };

    if (/^multipart\//.test(node.mediaType) && ct.params.boundary) {
      var chunks = splitParts(hb.body, ct.params.boundary);
      node.children = chunks.map(function (c) { return parseEntity(c, node.depth + 1); });
      node.bodyText = '';
    }
    return node;
  }

  /** 递归展开成叶子部件列表（保留文档顺序） */
  function flatten(node, out) {
    out = out || [];
    if (node.children && node.children.length) {
      for (var i = 0; i < node.children.length; i++) flatten(node.children[i], out);
    } else {
      out.push(node);
    }
    return out;
  }

  /** 叶子总数，用于统计 */
  function countLeaves(node) {
    return flatten(node).length;
  }

  /* ---------------- 对外入口 ---------------- */

  /**
   * 解析 MHT 字节流
   * @param {Uint8Array|ArrayBuffer} input
   * @returns {{headers:Object, root:Object, parts:Object[], rootPart:Object, snapshotLocation:string, isMultipart:boolean}}
   */
  function parseMime(input) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!bytes.length) throw new Error('文件为空');
    var text = bytesToBinary(bytes);
    var root = parseEntity(text, 0);
    var isMultipart = /^multipart\//.test(root.mediaType);

    var parts = flatten(root);
    if (isMultipart && !parts.length) {
      throw new Error('MIME 结构异常：未能在 boundary 之间找到任何内容部件');
    }

    var htmlParts = parts.filter(function (p) { return p.mediaType === 'text/html'; });
    if (!htmlParts.length) {
      throw new Error('归档中没有找到 HTML 主文档（text/html 部件）');
    }

    // 主文档选取：优先与前缀 Content-Location / 顶层 type 参数一致的部件
    var hint = String(root.headers['snapshot-content-location'] || '').trim();
    var rootPart = null;
    if (hint) {
      for (var i = 0; i < htmlParts.length; i++) {
        if (htmlParts[i].location === hint) { rootPart = htmlParts[i]; break; }
      }
    }
    if (!rootPart) {
      var shallow = htmlParts.slice().sort(function (a, b) { return a.depth - b.depth; });
      rootPart = shallow[0];
    }

    return {
      headers: root.headers,
      root: root,
      parts: parts,
      rootPart: rootPart,
      snapshotLocation: hint,
      isMultipart: isMultipart
    };
  }

  global.MhtMime = {
    parseMime: parseMime,
    parseHeaders: parseHeaders,
    parseContentType: parseContentType,
    splitParts: splitParts,
    splitHeadBody: splitHeadBody,
    bytesToBinary: bytesToBinary,
    binaryToBytes: binaryToBytes,
    normalizeCid: normalizeCid,
    flatten: flatten,
    countLeaves: countLeaves
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
