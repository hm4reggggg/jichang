/*!
 * rewrite.js — 资源索引与引用重写
 * 把 HTML / CSS 中指向归档资源的 URL（cid:、绝对 URL、相对路径）替换为 data: URI，
 * 全部为字符串级操作，尽量不改动原始文档结构（不经过 DOM 序列化，避免版式被改写）。
 */
(function (global) {
  'use strict';

  var BLANK_GIF = global.MhtDecode.BLANK_GIF;

  /* ---------------- URL 小工具 ---------------- */

  function stripHash(u) { var i = u.indexOf('#'); return i < 0 ? u : u.slice(0, i); }
  function stripQuery(u) { var i = u.indexOf('?'); return i < 0 ? u : u.slice(0, i); }
  function stripBoth(u) { return stripQuery(stripHash(u)); }

  function basename(u) {
    var s = stripBoth(u).replace(/[\\/]+$/, '');
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i < 0 ? s : s.slice(i + 1);
  }

  function safeDecodeURI(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function unescapeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi, function (all, body) {
      var b = body.toLowerCase();
      if (b === 'amp') return '&';
      if (b === 'quot') return '"';
      if (b === 'apos') return "'";
      if (b === 'lt') return '<';
      if (b === 'gt') return '>';
      if (b.charAt(0) === '#') {
        var code = b.charAt(1) === 'x' ? parseInt(b.slice(2), 16) : parseInt(b.slice(1), 10);
        return isFinite(code) ? String.fromCharCode(code) : all;
      }
      return all;
    });
  }

  function isSkippable(v) {
    var low = v.toLowerCase();
    return low.indexOf('data:') === 0 || low.indexOf('about:') === 0 || low.indexOf('javascript:') === 0 ||
      low.indexOf('mailto:') === 0 || low.indexOf('tel:') === 0 || low.indexOf('blob:') === 0 ||
      low.indexOf('#') === 0 || v === '';
  }

  function isExternal(v) {
    var low = v.toLowerCase();
    return low.indexOf('http://') === 0 || low.indexOf('https://') === 0 || low.indexOf('//') === 0 ||
      low.indexOf('file://') === 0 || low.indexOf('ftp://') === 0 || !/^[a-z][a-z0-9+.-]*:/.test(low);
  }

  function absoluteUrl(rel, base) {
    if (!rel) return '';
    if (/^(https?:|file:|ftp:)/i.test(rel)) return rel;
    if (rel.indexOf('//') === 0) {
      var m = /^(https?:)/i.exec(base || '');
      return m ? m[1] + rel : rel;
    }
    if (!base) return '';
    try { return new URL(rel, base).href; } catch (e) { return ''; }
  }

  /* ---------------- 资源索引 ---------------- */

  function addUrlKey(map, key, part) {
    if (!key) return;
    var k = key.trim();
    if (!k) return;
    if (map.has(k)) {
      if (map.get(k) !== part) map.set(k, null); // 同一 URL 出现多个部件 -> 歧义，不采用
      return;
    }
    map.set(k, part);
  }

  function addVariants(map, location, part) {
    if (!location) return;
    var v = location.trim();
    var set = [v, stripHash(v), stripQuery(v), stripBoth(v), safeDecodeURI(v), safeDecodeURI(stripBoth(v))];
    if (/^https?:\/\//i.test(v)) set.push(v.replace(/^https?/i, ''));
    if (/^file:\/\//i.test(v)) set.push(safeDecodeURI(v));
    for (var i = 0; i < set.length; i++) addUrlKey(map, set[i], part);
  }

  /**
   * 为所有"资源部件"建立查找表（主文档本身不入表）
   * @returns {{byCid:Map, byUrl:Map, byBase:Map}}
   */
  function indexResources(parts, rootPart) {
    var byCid = new Map(), byUrl = new Map(), byBase = new Map();
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === rootPart) {
        // 主文档只按 Content-ID 入表（可能被 iframe 以 cid: 引用），不按 URL 入表，避免自引用
        if (p.contentId) addUrlKey(byCid, p.contentId.toLowerCase(), p);
        continue;
      }
      if (p.contentId) addUrlKey(byCid, p.contentId.toLowerCase(), p);
      // Chrome 快照里动态插入的样式表，Content-Location 就是 `cid:css-xxx@mhtml.blink`
      if (/^cid:/i.test(p.location)) addUrlKey(byCid, p.location.slice(4).trim().toLowerCase(), p);
      if (p.location) {
        addVariants(byUrl, p.location, p);
        var base = basename(p.location).toLowerCase();
        if (base) {
          if (byBase.has(base) && byBase.get(base) !== p) byBase.set(base, null);
          else byBase.set(base, p);
        }
      }
      if (p.filename) {
        var fn = p.filename.toLowerCase();
        if (byBase.has(fn) && byBase.get(fn) !== p) byBase.set(fn, null);
        else byBase.set(fn, p);
      }
    }
    return { byCid: byCid, byUrl: byUrl, byBase: byBase };
  }

  /**
   * 生成引用解析器：把 HTML/CSS 里的原始引用值转成资源部件
   * @param {Object} index  indexResources 的结果
   * @param {string|string[]} bases 相对路径解析基准，按精确度从高到低依次尝试
   */
  function makeResolver(index, bases) {
    var baseList = Array.isArray(bases) ? bases.filter(Boolean) : (bases ? [bases] : []);
    return function (rawValue) {
      if (rawValue == null) return null;
      var v = unescapeEntities(String(rawValue)).trim();
      if (!v || isSkippable(v)) return null;

      if (/^cid:/i.test(v)) {
        var cid = v.slice(4).replace(/^<|>$/g, '').trim();
        var hit = index.byCid.get(cid.toLowerCase());
        if (!hit) hit = index.byCid.get(safeDecodeURI(cid).toLowerCase());
        if (!hit) hit = index.byUrl.get(v) || index.byUrl.get(v.toLowerCase());
        return hit || null;
      }

      var p = index.byUrl.get(v);
      if (p === undefined) p = index.byUrl.get(stripHash(v));
      if (p === undefined) p = index.byUrl.get(stripBoth(v));
      if (p === undefined) p = index.byUrl.get(unescapeEntities(safeDecodeURI(v)));
      for (var bi = 0; p === undefined && bi < baseList.length; bi++) {
        var abs = absoluteUrl(v, baseList[bi]);
        if (!abs) continue;
        p = index.byUrl.get(abs);
        if (p === undefined) p = index.byUrl.get(stripBoth(abs));
      }
      if (p === undefined) {
        var bn = basename(v).toLowerCase();
        if (bn && index.byBase.has(bn)) {
          var cand = index.byBase.get(bn);
          if (cand) p = cand;
        }
      }
      return p || null;
    };
  }

  /* ---------------- CSS 重写 ---------------- */

  var URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;
  var IMPORT_RE = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)|"([^"]*)"|'([^']*)')([^;]*);/gi;
  var CHARSET_RE = /@charset\s+(?:"[^"]*"|'[^']*')\s*;/i;

  function resolveAny(raw, ctx) {
    var part = ctx.resolve(raw);
    if (!part) return null;
    var entry = ctx.entryOf(part);
    if (entry && entry.dataUri) {
      if (ctx.stats) ctx.stats.inlined++;
      return entry;
    }
    return null;
  }

  function markMiss(raw, ctx) {
    if (ctx.stats) ctx.stats.addMiss(raw);
  }

  /**
   * 重写 CSS 文本中的 @charset / @import / url()
   * @param {string} css
   * @param {Object} ctx {resolve, entryOf, stats, options, base}
   */
  function rewriteCss(css, ctx) {
    var out = String(css);

    if (CHARSET_RE.test(out)) out = out.replace(CHARSET_RE, '@charset "utf-8";');

    out = out.replace(IMPORT_RE, function (all, u1, u2, u3, u4, u5, tail) {
      var raw = u1 || u2 || u3 || u4 || u5 || '';
      var entry = resolveAny(raw, ctx);
      if (!entry || !/text\/css/i.test(entry.mediaType)) {
        if (!/^data:/i.test(raw)) markMiss(raw, ctx);
        return all;
      }
      return '@import url("' + entry.dataUri + '")' + (tail || '') + ';';
    });

    out = out.replace(URL_RE, function (all, q1, q2, bare) {
      var raw = (q1 !== undefined && q1 !== '') ? q1 : ((q2 !== undefined && q2 !== '') ? q2 : bare);
      if (raw == null) return all;
      raw = unescapeEntities(raw);
      if (!raw || /^data:/i.test(raw) || raw.charAt(0) === '#') return all;
      var entry = resolveAny(raw, ctx);
      if (entry) return 'url("' + entry.dataUri + '")';
      markMiss(raw, ctx);
      if (ctx.options && ctx.options.stripMissing && isExternal(raw)) return 'url("' + BLANK_GIF + '")';
      return all;
    });

    return out;
  }

  /* ---------------- HTML 重写 ---------------- */

  // 始终尝试解析的 URL 型属性
  var URL_ATTRS = {
    'src': 1, 'poster': 1, 'background': 1, 'xlink:href': 1,
    'data-src': 1, 'data-original': 1, 'data-lazy-src': 1, 'data-actualsrc': 1,
    'data-echo': 1, 'data-bg': 1, 'data-background': 1, 'data-background-image': 1,
    'data-cover': 1, 'data-thumb': 1, 'data-image': 1, 'data-url': 1
  };
  var SRCSET_ATTRS = { 'srcset': 1, 'data-srcset': 1 };
  var FALLBACK_GIF_ATTRS = {
    'src': 1, 'poster': 1, 'background': 1, 'data-src': 1, 'data-original': 1,
    'data-bg': 1, 'data-background': 1, 'data-background-image': 1, 'data-cover': 1
  };
  var HREF_TAGS = { 'link': 1 };

  var ATTR_RE = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  var STYLE_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;

  /** 改写 style="..." 内嵌样式里的 url() */
  function rewriteStyleAttr(value, ctx) {
    return value.replace(STYLE_URL_RE, function (all, q1, q2, bare) {
      var raw = unescapeEntities((q1 || q2 || bare || ''));
      if (!raw || /^data:/i.test(raw) || raw.charAt(0) === '#') return all;
      var entry = resolveAny(raw, ctx);
      if (entry) return 'url("' + entry.dataUri + '")';
      markMiss(raw, ctx);
      if (ctx.options && ctx.options.stripMissing && isExternal(raw)) return 'url("' + BLANK_GIF + '")';
      return all;
    });
  }

  /** 改写 srcset="url 1x, url 2x" */
  function rewriteSrcset(value, ctx) {
    var changed = false;
    var parts = value.split(/\s*,\s*/);
    var out = parts.map(function (item) {
      var trimmed = item.trim();
      if (!trimmed) return trimmed;
      var m = /^(\S+)([\s\S]*)$/.exec(trimmed);
      if (!m) return trimmed;
      var url = unescapeEntities(m[1]);
      var desc = m[2] || '';
      if (/^data:/i.test(url)) return trimmed;
      var entry = resolveAny(url, ctx);
      if (entry) { changed = true; return entry.dataUri + desc; }
      markMiss(url, ctx);
      if (ctx.options && ctx.options.stripMissing && isExternal(url)) return '';
      return trimmed;
    });
    if (!changed && !(ctx.options && ctx.options.stripMissing)) return value;
    return out.filter(function (s) { return s !== ''; }).join(', ');
  }

  /** 改写一个标签的属性串 */
  function rewriteAttrs(attrs, tagName, ctx) {
    if (!attrs || attrs.indexOf('=') < 0) return attrs;
    var tag = String(tagName || '').toLowerCase();
    return attrs.replace(ATTR_RE, function (all, name, raw, dq, sq, uq) {
      var lname = name.toLowerCase();
      var value = dq !== undefined ? dq : (sq !== undefined ? sq : (uq !== undefined ? uq : ''));
      var out = null;

      if (lname === 'style') {
        var rewritten = rewriteStyleAttr(value, ctx);
        if (rewritten !== value) out = rewritten;
      } else if (SRCSET_ATTRS[lname]) {
        var rs = rewriteSrcset(value, ctx);
        if (rs !== value) out = rs;
      } else if (lname === 'href') {
        var isCid = /^cid:/i.test(unescapeEntities(value));
        if (!HREF_TAGS[tag] && !isCid) return all;
        var entry = resolveAny(value, ctx);
        if (entry) out = entry.dataUri;
        else {
          markMiss(value, ctx);
          if (ctx.options && ctx.options.stripMissing && HREF_TAGS[tag] && isExternal(value)) out = 'data:text/css,';
          else return all;
        }
      } else if (lname === 'content') {
        if (tag !== 'meta') return all;
        var metaEntry = resolveAny(value, ctx);
        if (metaEntry) out = metaEntry.dataUri;
      } else if (URL_ATTRS[lname]) {
        var hit = resolveAny(value, ctx);
        if (hit) out = hit.dataUri;
        else {
          markMiss(value, ctx);
          if (ctx.options && ctx.options.stripMissing && isExternal(value)) {
            if (FALLBACK_GIF_ATTRS[lname]) out = BLANK_GIF;
            else if (lname === 'data') out = '';
            else out = BLANK_GIF;
          } else return all;
        }
      } else {
        return all;
      }

      if (out === null || out === undefined) return all;
      // 保持原有引号风格
      var quote = dq !== undefined ? '"' : (sq !== undefined ? "'" : '');
      if (quote) return name + '=' + quote + out + quote;
      return name + '=' + out;
    });
  }

  // 分段扫描：注释、<script>/<style> 内容、普通标签分别处理，
  // 避免误伤注释与脚本字符串里的内容。
  var SEG_RE = new RegExp(
    '<!--[\\s\\S]*?-->' +
    '|<(script|style)((?:"[^"]*"|\'[^\']*\'|[^>"\'])*)>([\\s\\S]*?)<\\/\\1\\s*>' +
    '|<(\\/?)([a-zA-Z][\\w:.-]*)((?:"[^"]*"|\'[^\']*\'|[^>"\'])*)>',
    'gi'
  );

  function mediaAttrOf(attrs) {
    var m = /(^|\s)media\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (!m) return '';
    var v = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]);
    return v ? ' media="' + v + '"' : '';
  }

  function idAttrOf(attrs) {
    var m = /(^|\s)id\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (!m) return '';
    var v = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]);
    return v ? ' id="' + v + '"' : '';
  }

  /**
   * 重写整份 HTML
   * @param {string} html
   * @param {Object} ctx {resolve, entryOf, stats, options}
   * @returns {string}
   */
  function rewriteHtml(html, ctx) {
    var opts = ctx.options || {};
    return String(html).replace(SEG_RE, function (all, scriptTag, tagAttrs, inner, slash, tagName, attrs) {
      // 注释：原样保留
      if (all.slice(0, 4) === '<!--') return all;

      // <script> / <style>
      if (scriptTag) {
        var name = scriptTag.toLowerCase();
        if (name === 'script' && opts.disableJs) return '';
        var newAttrs = rewriteAttrs(tagAttrs, name, ctx);
        if (name === 'style') {
          return '<style' + newAttrs + '>' + rewriteCss(inner, ctx) + '</style>';
        }
        return '<script' + newAttrs + '>' + inner + '</script>';
      }

      // 闭合标签
      if (slash) return all;

      var tag = (tagName || '').toLowerCase();

      // <link rel="stylesheet"> 可选：直接内联为 <style>，避免 data: 链接的任何兼容问题
      if (opts.inlineStyle && tag === 'link' && /rel\s*=\s*("|')?[^"'>]*stylesheet/i.test(attrs)) {
        var hrefMatch = /(^|\s)href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
        if (hrefMatch) {
          var hrefVal = hrefMatch[3] !== undefined ? hrefMatch[3] : (hrefMatch[4] !== undefined ? hrefMatch[4] : hrefMatch[5]);
          var part = ctx.resolve(hrefVal);
          if (part) {
            var entry = ctx.entryOf(part);
            var cssText = entry && ctx.cssTextOf ? ctx.cssTextOf(entry) : null;
            if (cssText != null) {
              if (ctx.stats) ctx.stats.inlined++;
              return '<style' + idAttrOf(attrs) + mediaAttrOf(attrs) + '>' + cssText + '</style>';
            }
          }
        }
      }

      return '<' + tag + rewriteAttrs(attrs, tag, ctx) + '>';
    });
  }

  global.MhtRewrite = {
    indexResources: indexResources,
    makeResolver: makeResolver,
    rewriteCss: rewriteCss,
    rewriteHtml: rewriteHtml,
    rewriteAttrs: rewriteAttrs,
    rewriteStyleAttr: rewriteStyleAttr,
    rewriteSrcset: rewriteSrcset,
    absoluteUrl: absoluteUrl,
    basename: basename,
    stripBoth: stripBoth,
    unescapeEntities: unescapeEntities,
    isExternal: isExternal,
    BLANK_GIF: BLANK_GIF
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
