// 临时脚本：生成把样例 MHT 内嵌进页面的 e2e 测试页（无头浏览器验证 UI 全流程）
// 用法: node tools/e2e-gen.mjs sample.mht
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mht = fs.readFileSync(process.argv[2]);
const b64 = mht.toString('base64');

const test = `
<script>
window.__MHT_B64__ = "${b64}";
</script>
<script>
(function () {
  var log = [];
  function mark(tag, extra) {
    log.push(tag + (extra ? ' <> ' + extra : ''));
    document.title = 'E2E[' + log.join(' | ') + ']';
  }
  function b64ToBytes(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function feed(bytes, name) {
    var file = new File([bytes], name, { type: 'message/rfc822' });
    var dt = new DataTransfer();
    dt.items.add(file);
    var input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function rows() { return document.querySelectorAll('#fileList tr[data-id]').length; }
  function badge() {
    var b = document.querySelector('#fileList .badge');
    return b ? b.textContent.trim() : 'none';
  }
  function btn() { return document.getElementById('btnConvert').textContent.trim(); }
  function txt(node) { return node ? node.textContent.trim().replace(/[ \\t\\r\\n]+/g, ' ') : 'none'; }
  function cells() {
    return Array.prototype.map.call(
      document.querySelectorAll('#fileList tr[data-id="F1"] td'),
      function (t) { return txt(t); }
    ).join(' / ');
  }
  window.onerror = function (m, s, l) { mark('JS-ERROR', m + ' @line' + l); };

  // 探测 Worker 能否加载（托管场景 = http/https 时应用会走 Worker 路径）
  try {
    var probe = new Worker('js/worker.js');
    probe.onmessage = function (ev) { mark('S0-worker', 'reply=' + JSON.stringify(ev.data)); probe.terminate(); };
    probe.onerror = function (ev) { mark('S0-worker', 'ERROR ' + (ev.message || 'unknown')); };
    probe.postMessage({ type: 'ping', id: 1 });
  } catch (e0) {
    mark('S0-worker', 'throw ' + e0.message + ' (protocol=' + location.protocol + ')');
  }

  function afterConvert(cb) {
    if (/完成|失败/.test(badge())) return cb();
    var list = document.getElementById('fileList');
    var mo = new MutationObserver(function () {
      if (/完成|失败/.test(badge())) { mo.disconnect(); cb(); }
    });
    mo.observe(list, { childList: true, subtree: true, characterData: true });
    setTimeout(function () { mo.disconnect(); mark('TIMEOUT-waitConvert', 'badge=' + badge()); }, 60000);
  }

  try {
    var bytes = b64ToBytes(window.__MHT_B64__);
    mark('S1-bytes', bytes.length);

    feed(bytes, 'sample.mht');
    mark('S2-added', 'rows=' + rows() + ',btn=' + btn());
    if (!rows()) throw new Error('文件没有被加入列表');

    document.getElementById('btnConvert').click();
    mark('S3-clicked', 'btn=' + btn());

    afterConvert(function () {
      try {
        mark('S4-converted', 'badge=' + badge() + ',cells=' + cells());
        mark('S5-progress', txt(document.getElementById('progressText')) + ' | ' +
          txt(document.getElementById('stats')));

        document.querySelector('#fileList button[data-act="toggle"]').click();
        mark('S6-detail', txt(document.querySelector('.row-detail .detail')).slice(0, 230));

        document.querySelector('#fileList button[data-act="preview"]').click();
        var fr = document.getElementById('previewFrame');
        var doc = null;
        try { doc = fr.contentDocument; } catch (e) { doc = null; }
        mark('S7-preview', 'srcdocLen=' + (fr.getAttribute('srcdoc') || '').length +
          ',mask=' + document.getElementById('previewMask').className +
          ',frameDoc=' + (doc ? (doc.title || 'ok') : 'blocked-by-sandbox'));
        document.getElementById('previewClose').click();
        mark('S8-closed', 'srcdocAttr=' + fr.getAttribute('srcdoc'));
        document.querySelector('#fileList button[data-act="toggle"]').click();

        feed(bytes, 'sample2.mht');
        mark('S9-added2', 'rows=' + rows() + ',btn=' + btn() + ',toast=' + txt(document.getElementById('toast')));

        document.getElementById('btnZip').click();
        mark('S10-zip', 'clicked');
      } catch (e2) {
        mark('FATAL2', e2.message);
      }
      // 等一轮事件循环后（此时 convertAll 的收尾代码已跑完）再取最终按钮文案
      setTimeout(function () {
        mark('S11-finalBtn', 'btn=' + btn() + ',stats=' + txt(document.getElementById('stats')));
        mark('DONE', 'ok');
        var keep = document.title;
        document.body.innerHTML = '<pre id="e2e-result">' + log.join('\\n') + '</pre>';
        document.title = keep;
        // 把结果回传给本地静态服务器（真实时间下运行，不依赖虚拟时钟）
        try {
          fetch(location.origin + '/E2E-REPORT?log=' + encodeURIComponent(log.join(' | ')));
        } catch (e3) { }
      }, 1500);
    });
  } catch (e) {
    mark('FATAL', e.message);
  }
})();
</script>
`;

const outHtml = html.replace('</body>', test + '</body>');
const out = path.join(root, 'e2e-temp.html');
fs.writeFileSync(out, outHtml);
console.log('生成:', out, (outHtml.length / 1048576).toFixed(1) + 'MB');
