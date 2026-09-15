/*!
 * zip.js — 极简 ZIP 打包器（store 模式，不压缩）
 * 只用标准库能力，无第三方依赖；批量下载时把多个 HTML 打成一个 zip。
 */
(function (global) {
  'use strict';

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256), c, n, k;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function Writer(sizeHint) {
    this.buf = new Uint8Array(Math.max(sizeHint || 4096, 64));
    this.len = 0;
  }
  Writer.prototype.ensure = function (extra) {
    if (this.len + extra <= this.buf.length) return;
    var next = this.buf.length;
    while (next < this.len + extra) next *= 2;
    var nb = new Uint8Array(next);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  };
  Writer.prototype.u16 = function (v) {
    this.ensure(2);
    this.buf[this.len++] = v & 0xFF;
    this.buf[this.len++] = (v >>> 8) & 0xFF;
  };
  Writer.prototype.u32 = function (v) {
    this.ensure(4);
    this.buf[this.len++] = v & 0xFF;
    this.buf[this.len++] = (v >>> 8) & 0xFF;
    this.buf[this.len++] = (v >>> 16) & 0xFF;
    this.buf[this.len++] = (v >>> 24) & 0xFF;
  };
  Writer.prototype.raw = function (bytes) {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  };
  Writer.prototype.offsetView = function () {
    return this.len;
  };
  Writer.prototype.patchU32 = function (offset, v) {
    this.buf[offset] = v & 0xFF;
    this.buf[offset + 1] = (v >>> 8) & 0xFF;
    this.buf[offset + 2] = (v >>> 16) & 0xFF;
    this.buf[offset + 3] = (v >>> 24) & 0xFF;
  };
  Writer.prototype.result = function () {
    return this.buf.subarray(0, this.len);
  };

  function utf8Bytes(str) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(str);
    var s = unescape(encodeURIComponent(str));
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
    return out;
  }

  function dosDateTime(date) {
    var d = date || new Date();
    var year = d.getFullYear();
    if (year < 1980) year = 1980;
    var time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
    var day = (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time: time, date: day };
  }

  /**
   * 生成 ZIP
   * @param {Array<{name:string, bytes:Uint8Array}>} entries
   * @returns {Uint8Array}
   */
  function create(entries) {
    var w = new Writer(1 << 20);
    var dt = dosDateTime(new Date());
    var central = [];

    for (var i = 0; i < entries.length; i++) {
      var item = entries[i];
      var nameBytes = utf8Bytes(item.name);
      var data = item.bytes instanceof Uint8Array ? item.bytes : new Uint8Array(item.bytes);
      var crc = crc32(data);
      var offset = w.offsetView();

      // 本地文件头
      w.u32(0x04034b50);
      w.u16(20);
      w.u16(0x0800);          // 文件名使用 UTF-8
      w.u16(0);               // 存储方式：不压缩
      w.u16(dt.time);
      w.u16(dt.date);
      w.u32(crc);
      w.u32(data.length);
      w.u32(data.length);
      w.u16(nameBytes.length);
      w.u16(0);
      w.raw(nameBytes);
      w.raw(data);

      central.push({
        name: nameBytes, crc: crc, size: data.length, offset: offset
      });
    }

    var cdStart = w.offsetView();
    for (var j = 0; j < central.length; j++) {
      var c = central[j];
      w.u32(0x02014b50);
      w.u16(20);
      w.u16(20);
      w.u16(0x0800);
      w.u16(0);
      w.u16(dt.time);
      w.u16(dt.date);
      w.u32(c.crc);
      w.u32(c.size);
      w.u32(c.size);
      w.u16(c.name.length);
      w.u16(0);
      w.u16(0);
      w.u16(0);
      w.u16(0);
      w.u32(0);
      w.u32(c.offset);
      w.raw(c.name);
    }
    var cdSize = w.offsetView() - cdStart;

    // 中央目录结束记录
    w.u32(0x06054b50);
    w.u16(0);
    w.u16(0);
    w.u16(central.length);
    w.u16(central.length);
    w.u32(cdSize);
    w.u32(cdStart);
    w.u16(0);

    return w.result();
  }

  global.MhtZip = { create: create, crc32: crc32 };
})(typeof globalThis !== 'undefined' ? globalThis : this);
