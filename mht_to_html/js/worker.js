/*!
 * worker.js — 转换工作线程
 * 只负责把 MHT 字节转成自包含 HTML 字节，避免大文件卡住界面。
 */
importScripts('mime.js', 'decode.js', 'rewrite.js', 'convert.js');

self.onmessage = function (e) {
  var msg = e.data || {};

  if (msg.type === 'ping') {
    self.postMessage({ type: 'pong', id: msg.id });
    return;
  }

  if (msg.type !== 'convert') return;

  try {
    var result = MhtConvert.convert(msg.bytes, msg.options);
    var bytes = result.bytes;
    self.postMessage(
      { type: 'done', id: msg.id, bytes: bytes, stats: result.stats },
      [bytes.buffer]
    );
  } catch (err) {
    self.postMessage({
      type: 'error',
      id: msg.id,
      message: (err && err.message) ? err.message : String(err)
    });
  }
};
