/*!
 * convert.js — MHT -> 自包含单文件 HTML 的主流程
 * 输入 Uint8Array，输出 UTF-8 字节的自包含 HTML（资源全部内联为 data: URI）。
 */
(function (global) {
  'use strict';

  var Mime = global.MhtMime;
  var Dec = global.MhtDecode;
  var RW = global.MhtRewrite;

  var DEFAULTS = {
    inlineStyle: true,   // <link rel=stylesheet> 内联为 <style>
    disableJs: false,    // 移除页面脚本
    bom: true,           // 输出加 UTF-8 BOM
    stripMissing: false  // 移除未归档的外链引用
  };

  var MAX_MISS_RECORDS = 120;

  function createStats() {
    var missMap = new Map();
    return {
      inlined: 0,
      missTotal: 0,
      misses: [],          // [{url, count}]
      addMiss: function (url) {
        if (url == null) return;
        var key = String(url).trim();
        if (!key || /^data:/i.test(key)) return;
        this.missTotal++;
        var rec = missMap.get(key);
        if (rec) { rec.count++; return; }
        if (missMap.size >= MAX_MISS_RECORDS) return;
        rec = { url: key, count: 1 };
        missMap.set(key, rec);
        this.misses.push(rec);
      },
      missList: function () {
        return this.misses.slice().sort(function (a, b) { return b.count - a.count; });
      }
    };
  }

  function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  /** 修正 <meta charset>，保证文档按 UTF-8 解析 */
  function fixCharsetMeta(html) {
    var done = false;
    var out = html.replace(/<meta\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi, function (tag, attrs) {
      if (done) return tag;
      var m = /charset\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>;]+))/i.exec(attrs);
      if (!m) return tag;
      done = true;
      return '<meta' + attrs.replace(m[0], 'charset="utf-8"') + '>';
    });
    if (!done) {
      if (/<head\b[^>]*>/i.test(out)) return out.replace(/<head\b[^>]*>/i, function (t) { return t + '<meta charset="utf-8">'; });
      if (/<html\b[^>]*>/i.test(out)) return out.replace(/<html\b[^>]*>/i, function (t) { return t + '<head><meta charset="utf-8"></head>'; });
      out = '<meta charset="utf-8">' + out;
    }
    return out;
  }

  /**
   * 主转换函数
   * @param {Uint8Array|ArrayBuffer} input MHT 字节
   * @param {Object} [options]
   * @returns {{bytes:Uint8Array, html:string, stats:Object}}
   */
  function convert(input, options) {
    var t0 = nowMs();
    var opts = {};
    for (var k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) opts[k] = DEFAULTS[k];
    if (options) for (var k2 in options) if (options[k2] !== undefined) opts[k2] = options[k2];

    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var parsed = Mime.parseMime(bytes);
    var rootPart = parsed.rootPart;
    var baseUrl = rootPart.location || parsed.snapshotLocation || '';

    var stats = createStats();
    var index = RW.indexResources(parsed.parts, rootPart);

    var prepared = new Map();   // part -> entry
    var visiting = new Set();
    var counts = { css: 0, image: 0, font: 0, script: 0, subHtml: 0, other: 0 };

    /** 该部件自身可用的"真实 URL"基准 */
    function realUrl(v) {
      return (v && /^(https?|file|ftp):/i.test(v)) ? v : '';
    }

    /** 取出文档里的 <base href> */
    function baseTagOf(htmlText) {
      var m = /<base\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(htmlText);
      if (!m) return '';
      var v = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
      return RW.unescapeEntities(v || '').trim();
    }

    /** 相对引用的基准候选，从最精确到最宽松：<base href> → 部件自身 URL → 主文档 URL */
    function basesFor(part, docHtml) {
      var list = [];
      var own = realUrl(part.base) || realUrl(part.location);
      if (docHtml) {
        var tagBase = baseTagOf(docHtml);
        if (tagBase) {
          var abs = RW.absoluteUrl(tagBase, own || baseUrl);
          if (abs) list.push(abs);
        }
      }
      if (own) list.push(own);
      if (baseUrl) list.push(baseUrl);
      return list.filter(function (v, i, arr) { return v && arr.indexOf(v) === i; });
    }

    function ctxFor(bases) {
      return {
        base: bases[0] || '',
        resolve: RW.makeResolver(index, bases),
        entryOf: entryOf,
        cssTextOf: function (entry) { return entry && entry.kind === 'css' ? entry.text : null; },
        stats: stats,
        options: opts
      };
    }

    function classify(mediaType) {
      var mt = String(mediaType || '').toLowerCase();
      if (/^text\/css/.test(mt)) return 'css';
      if (/^image\//.test(mt)) return 'image';
      if (/^font\/|woff|ttf|otf|eot/.test(mt)) return 'font';
      if (/javascript|ecmascript/.test(mt)) return 'script';
      if (/^text\/html/.test(mt)) return 'subHtml';
      return 'other';
    }

    function entryOf(part) {
      if (!part) return null;
      if (prepared.has(part)) return prepared.get(part);
      if (visiting.has(part)) return null;   // 循环引用：放弃重写，退回原字节
      visiting.add(part);
      var entry = null;
      try {
        entry = buildEntry(part);
      } catch (e) {
        entry = null;
      }
      visiting.delete(part);
      if (entry) prepared.set(part, entry);
      return entry;
    }

    function buildEntry(part) {
      var mt = String(part.mediaType || 'application/octet-stream').toLowerCase();
      var raw = Dec.decodePartBody(part);
      var kind = classify(mt);
      counts[kind] = (counts[kind] || 0) + 1;

      // 需要"先重写内部引用、再整体内联"的文本类部件
      if (kind === 'css' || kind === 'subHtml' || /svg\+xml|\+xml/.test(mt)) {
        var hint = part.charset || Dec.sniffCharsetFromBytes(raw);
        var decoded = Dec.decodeText(raw, hint);
        // 关键：CSS/子文档里的相对路径要按它自己的 URL（或 <base href>）解析
        var pctx = ctxFor(basesFor(part, kind === 'css' ? '' : decoded.text));
        var text = kind === 'css'
          ? RW.rewriteCss(decoded.text, pctx)
          : RW.rewriteHtml(decoded.text, pctx);
        // 子文档（iframe 等）同样需要把 meta charset 改成 utf-8
        if (kind === 'subHtml') text = fixCharsetMeta(text);
        var utf8 = Dec.encodeUtf8(text);
        return {
          part: part, kind: kind, mediaType: part.mediaType,
          charset: 'utf-8', text: text, byteLength: utf8.length,
          dataUri: Dec.dataUri(part.mediaType, utf8, 'utf-8')
        };
      }

      // JS / JSON 等：原字节直通，不重新编码，避免任何语义变化
      if (kind === 'script' || kind === 'other' && Dec.isTextual(mt)) {
        return {
          part: part, kind: kind, mediaType: part.mediaType,
          charset: '', text: null, byteLength: raw.length,
          dataUri: Dec.dataUri(part.mediaType, raw, '')
        };
      }

      // 二进制资源：原样内联
      return {
        part: part, kind: kind, mediaType: part.mediaType,
        charset: '', text: null, byteLength: raw.length,
        dataUri: Dec.dataUri(part.mediaType, raw, '')
      };
    }

    // ---- 主文档 ----
    var rootRaw = Dec.decodePartBody(rootPart);
    var rootHint = rootPart.charset || Dec.sniffCharsetFromBytes(rootRaw);
    var rootDecoded = Dec.decodeText(rootRaw, rootHint);
    var rootCtx = ctxFor(basesFor(rootPart, rootDecoded.text));
    var html = RW.rewriteHtml(rootDecoded.text, rootCtx);
    html = fixCharsetMeta(html);

    var outText = opts.bom ? '\uFEFF' + html : html;
    var outBytes = Dec.encodeUtf8(outText);

    var durationMs = Math.round(nowMs() - t0);
    return {
      bytes: outBytes,
      html: outText,
      stats: {
        rootCharset: rootDecoded.charset,
        rootBadChars: rootDecoded.bad,
        baseUrl: baseUrl,
        sourceSize: bytes.length,
        outputSize: outBytes.length,
        partCount: parsed.parts.length,
        resourcesInlined: stats.inlined,
        missTotal: stats.missTotal,
        misses: stats.missList(),
        counts: counts,
        isMultipart: parsed.isMultipart,
        durationMs: durationMs,
        options: opts
      }
    };
  }

  global.MhtConvert = { convert: convert, fixCharsetMeta: fixCharsetMeta };
})(typeof globalThis !== 'undefined' ? globalThis : this);
