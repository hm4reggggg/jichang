/*!
 * app.js — 界面逻辑：文件队列、Worker 调度（失败自动降级主线程）、预览、下载、ZIP 打包
 * 所有计算都在浏览器本地完成，文件内容不会发送到任何服务器。
 */
(function () {
  'use strict';

  var MAX_FILE_SIZE = 20 * 1024 * 1024;   // 单文件上限 20MB
  var POOL_SIZE = 2;
  var TASK_TIMEOUT = 180000;

  var STATUS = {
    wait: { text: '等待中', cls: 'b-wait' },
    running: { text: '转换中', cls: 'b-run' },
    ok: { text: '完成', cls: 'b-ok' },
    warn: { text: '完成', cls: 'b-warn' },
    error: { text: '失败', cls: 'b-err' },
    over: { text: '超限跳过', cls: 'b-err' }
  };

  function $(id) { return document.getElementById(id); }

  var els = {
    dropZone: $('dropZone'), fileInput: $('fileInput'),
    optInlineStyle: $('optInlineStyle'), optDisableJs: $('optDisableJs'),
    optBom: $('optBom'), optStripMissing: $('optStripMissing'),
    btnConvert: $('btnConvert'), btnZip: $('btnZip'), btnClear: $('btnClear'),
    progressWrap: $('progressWrap'), progressText: $('progressText'),
    progressPct: $('progressPct'), progressFill: $('progressFill'),
    fileList: $('fileList'), emptyHint: $('emptyHint'), stats: $('stats'),
    previewMask: $('previewMask'), previewFrame: $('previewFrame'),
    previewTitle: $('previewTitle'), previewOpen: $('previewOpen'), previewClose: $('previewClose'),
    toast: $('toast')
  };

  var state = {
    items: [], seq: 0, taskSeq: 0,
    running: false, workers: [], workerOk: null, waiting: [], tasks: new Map(),
    previewItem: null
  };

  /* ---------------- 小工具 ---------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtSize(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function outName(name) {
    var base = String(name).replace(/\.[^.]+$/, '');
    if (!base) base = 'page';
    return base + '.html';
  }

  function stamp() {
    var d = new Date(), p = function (v) { return (v < 10 ? '0' : '') + v; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  var toastTimer = null;
  function toast(msg, duration) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('show'); }, duration || 2600);
  }

  function readOptions() {
    return {
      inlineStyle: els.optInlineStyle.checked,
      disableJs: els.optDisableJs.checked,
      bom: els.optBom.checked,
      stripMissing: els.optStripMissing.checked
    };
  }

  /* ---------------- 文件队列 ---------------- */

  function addFiles(list) {
    var added = 0, ignored = 0;
    var finished = state.items.filter(function (i) { return i.out && i.out.bytes; }).length;
    for (var i = 0; i < list.length; i++) {
      var file = list[i];
      if (!file || !file.size) { ignored++; continue; }
      var over = file.size > MAX_FILE_SIZE;
      state.items.push({
        id: 'F' + (++state.seq),
        file: file, name: file.name, size: file.size,
        status: over ? 'over' : 'wait',
        error: over ? ('文件大小 ' + fmtSize(file.size) + ' 超过 ' + fmtSize(MAX_FILE_SIZE) + ' 上限') : '',
        out: null, expanded: false
      });
      added++;
    }
    renderAll();

    if (!added) {
      toast(ignored ? '没有可解析的文件（可能是文件夹或空文件）' : '没有选择文件');
      return added;
    }

    var msg = '已添加 ' + added + ' 个文件';
    if (ignored) msg += '，忽略 ' + ignored + ' 个空条目';
    if (finished) {
      // 已有转换结果时，提醒用户新文件是"追加"进来的，按钮只会转换新增部分
      msg += '；已有 ' + finished + ' 个转换结果（会保留），点“转换新增文件”只处理新加的文件，刷新页面则全部消失';
      toast(msg, 6200);
    } else {
      toast(msg);
    }
    return added;
  }

  function removeItem(id) {
    state.items = state.items.filter(function (it) { return it.id !== id; });
    renderAll();
  }

  function clearAll() {
    if (state.running) return;
    state.items = [];
    state.previewItem = null;
    els.progressWrap.classList.remove('show');
    els.progressFill.style.width = '0%';
    renderAll();
    toast('列表已清空');
  }

  /* ---------------- Worker 池 ---------------- */

  function workerSupported() {
    if (state.workerOk === false) return false;
    if (state.workerOk === true) return true;
    if (typeof Worker === 'undefined' || location.protocol === 'file:') {
      state.workerOk = false;   // file:// 下浏览器不允许创建 Worker
      return false;
    }
    try {
      var url = new URL('js/worker.js', location.href).href;
      for (var i = 0; i < POOL_SIZE; i++) {
        var w = new Worker(url);
        w._busy = false; w._task = null;
        w.onmessage = onWorkerMessage;
        w.onerror = onWorkerError;
        state.workers.push(w);
      }
      state.workerOk = true;
      return true;
    } catch (e) {
      state.workerOk = false;
      return false;
    }
  }

  function onWorkerMessage(ev) {
    var msg = ev.data || {};
    if (msg.type === 'pong') return;
    var task = state.tasks.get(msg.id);
    if (!task) return;
    state.tasks.delete(msg.id);
    clearTimeout(task.timer);
    releaseWorker(task.worker);
    if (msg.type === 'done') task.resolve({ bytes: new Uint8Array(msg.bytes), stats: msg.stats });
    else task.reject(new Error(msg.message || '转换失败'));
  }

  function onWorkerError(ev) {
    state.workerOk = false;
    var w = ev.target;
    if (w && w._task && state.tasks.has(w._task)) {
      var task = state.tasks.get(w._task);
      state.tasks.delete(w._task);
      clearTimeout(task.timer);
      task.reject(new Error('Worker 不可用'));
    }
    state.workers.forEach(function (x) { try { x.terminate(); } catch (e) {} });
    state.workers = [];
    state.waiting = [];
  }

  function acquireWorker() {
    for (var i = 0; i < state.workers.length; i++) {
      if (!state.workers[i]._busy) {
        state.workers[i]._busy = true;
        return Promise.resolve(state.workers[i]);
      }
    }
    return new Promise(function (resolve) { state.waiting.push(resolve); });
  }

  function releaseWorker(w) {
    if (!w) return;
    w._busy = false;
    w._task = null;
    var next = state.waiting.shift();
    if (next) { w._busy = true; next(w); }
  }

  function runOnWorker(bytes, options) {
    return acquireWorker().then(function (w) {
      return new Promise(function (resolve, reject) {
        var id = 'T' + (++state.taskSeq);
        var timer = setTimeout(function () {
          state.tasks.delete(id);
          reject(new Error('转换超时'));
        }, TASK_TIMEOUT);
        state.tasks.set(id, { resolve: resolve, reject: reject, timer: timer, worker: w });
        w._task = id;
        try {
          w.postMessage({ type: 'convert', id: id, bytes: bytes, options: options }, [bytes.buffer]);
        } catch (e) {
          state.tasks.delete(id);
          clearTimeout(timer);
          releaseWorker(w);
          reject(e);
        }
      });
    });
  }

  function convertOnMainThread(bytes, options) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try { resolve(MhtConvert.convert(bytes, options)); }
        catch (e) { reject(e); }
      }, 0);
    });
  }

  function convertOne(item) {
    return item.file.arrayBuffer().then(function (buf) {
      var options = readOptions();
      if (!workerSupported()) return convertOnMainThread(new Uint8Array(buf), options);
      return runOnWorker(new Uint8Array(buf), options).catch(function () {
        // Worker 里 importScripts 被拦截等情况：重新读文件，退回主线程
        return item.file.arrayBuffer().then(function (buf2) {
          return convertOnMainThread(new Uint8Array(buf2), options);
        });
      });
    });
  }

  /* ---------------- 批量转换 ---------------- */

  function runPool(items, handler, concurrency) {
    return new Promise(function (resolve) {
      if (!items.length) return resolve();
      var idx = 0, active = 0, settled = false;
      function pump() {
        while (active < concurrency && idx < items.length) {
          var item = items[idx++];
          active++;
          Promise.resolve()
            .then(function () { return handler(item); })
            .catch(function () { })
            .then(function () {
              active--;
              if (idx >= items.length && active === 0) {
                if (!settled) { settled = true; resolve(); }
              } else {
                pump();
              }
            });
        }
      }
      pump();
    });
  }

  function setProgress(done, total, text) {
    var pct = total ? Math.round((done / total) * 100) : 0;
    els.progressFill.style.width = pct + '%';
    els.progressPct.textContent = pct + '%';
    els.progressText.textContent = text || '';
  }

  function convertAll() {
    // 有"还没结果"的文件（新加的、上次失败的）时只转换这些，保留已有结果；
    // 否则说明所有文件都转换过了 —— 整体重转一遍。
    var pending = state.items.filter(function (it) { return it.status === 'wait' || it.status === 'error'; });
    var hasResult = state.items.some(function (it) { return it.out && it.out.bytes; });
    if (!pending.length) pending = state.items.filter(function (it) { return it.status !== 'over'; });
    if (!pending.length) {
      toast('没有可转换的文件');
      return;
    }
    if (hasResult && pending.length < state.items.length) {
      toast('只转换新增的 ' + pending.length + ' 个文件，已有结果保持不变', 4200);
    }
    state.running = true;
    updateButtons();
    els.progressWrap.classList.add('show');
    var done = 0;
    setProgress(0, pending.length, '准备中…');

    runPool(pending, function (item) {
      item.status = 'running';
      item.error = '';
      item.out = null;
      renderRow(item);
      els.progressText.textContent = '正在转换：' + item.name;
      els.progressFill.style.width = Math.round((done / pending.length) * 100) + '%';

      return convertOne(item).then(function (res) {
        item.out = res;
        item.status = res.stats.missTotal > 0 ? 'warn' : 'ok';
      }).catch(function (err) {
        item.out = null;
        item.status = 'error';
        item.error = (err && err.message) ? err.message : String(err);
      }).then(function () {
        done++;
        renderRow(item);
        renderStats();
        setProgress(done, pending.length, done >= pending.length ? '全部完成' : ('已完成 ' + done + '/' + pending.length));
      });
    }, POOL_SIZE).then(function () {
      state.running = false;
      renderStats();
      updateButtons();
      var failed = pending.filter(function (i) { return i.status === 'error'; }).length;
      toast(failed ? ('转换完成，' + failed + ' 个文件失败') : '转换完成');
    });
  }

  /* ---------------- 预览 / 下载 ---------------- */

  function blobOf(item) {
    return new Blob([item.out.bytes], { type: 'text/html;charset=utf-8' });
  }

  /** 取转换结果的 HTML 文本：Worker 路径只回传字节（省内存/带宽），这里按需解码一次 */
  function htmlOf(item) {
    if (!item.out) return '';
    if (typeof item.out.html === 'string') return item.out.html;
    if (typeof item.out._htmlText === 'string') return item.out._htmlText;
    var text = '';
    try { text = new TextDecoder('utf-8').decode(item.out.bytes); } catch (e) { text = ''; }
    item.out._htmlText = text;
    return text;
  }

  function previewItem(item) {
    if (!item.out) return;
    state.previewItem = item;
    var frame = els.previewFrame;
    frame.removeAttribute('src');
    // 用 srcdoc + 沙箱 iframe：脚本可运行（保证版式与原页一致），但拿不到本工具页的权限
    frame.srcdoc = htmlOf(item);
    els.previewTitle.textContent = outName(item.name);
    els.previewMask.classList.add('show');
  }

  function closePreview() {
    els.previewMask.classList.remove('show');
    els.previewFrame.removeAttribute('srcdoc');
    state.previewItem = null;
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
  }

  function downloadItem(item) {
    if (!item.out) return;
    triggerDownload(blobOf(item), outName(item.name));
  }

  function downloadZip() {
    var ok = state.items.filter(function (i) { return i.out && i.out.bytes; });
    if (!ok.length) { toast('还没有可下载的结果'); return; }
    var used = Object.create(null);
    var entries = ok.map(function (item) {
      var name = outName(item.name);
      if (used[name]) {
        var stem = name.replace(/\.html$/i, '');
        var n = 2;
        while (used[stem + '_' + n + '.html']) n++;
        name = stem + '_' + n + '.html';
      }
      used[name] = true;
      return { name: name, bytes: item.out.bytes };
    });
    var zip = MhtZip.create(entries);
    triggerDownload(new Blob([zip], { type: 'application/zip' }), 'mht-html-' + stamp() + '.zip');
    toast('已打包 ' + entries.length + ' 个 HTML');
  }

  /* ---------------- 渲染 ---------------- */

  function ops(item) {
    var html = '';
    if (item.out) {
      html += '<button class="mini" data-act="preview" data-id="' + item.id + '">预览</button> ';
      html += '<button class="mini" data-act="download" data-id="' + item.id + '">下载</button> ';
    }
    html += '<button class="mini ghost" data-act="toggle" data-id="' + item.id + '">详情</button> ';
    html += '<button class="mini ghost" data-act="remove" data-id="' + item.id + '">移除</button>';
    return html;
  }

  function detailHtml(item) {
    if (item.status === 'over') {
      return '<div class="detail">文件大小 ' + fmtSize(item.size) + ' 超过 ' + fmtSize(MAX_FILE_SIZE) + ' 上限，已跳过。</div>';
    }
    if (!item.out) {
      return '<div class="detail">' + (item.error ? esc(item.error) : '等待转换…') + '</div>';
    }
    var s = item.out.stats, c = s.counts || {};
    var miss = s.misses.slice(0, 12).map(function (m) {
      return '<li>' + esc(m.url) + (m.count > 1 ? ' <span class="muted">×' + m.count + '</span>' : '') + '</li>';
    }).join('');
    return '' +
      '<div class="detail">' +
        '<h4>转换概要</h4>' +
        '<div>主文档编码：<b>' + esc(s.rootCharset) + '</b>' +
          (s.rootBadChars ? ' <span class="muted">（' + s.rootBadChars + ' 个字符无法识别）</span>' : '') +
          ' · 归档部件：<b>' + s.partCount + '</b>' +
          ' · 已内联引用：<b>' + s.resourcesInlined + '</b>' +
          ' · 源大小 ' + fmtSize(s.sourceSize) + ' → 输出 ' + fmtSize(s.outputSize) +
          ' · 耗时 ' + s.durationMs + ' ms' +
        '</div>' +
        '<div class="muted" style="margin-top:4px">资源构成：图片 ' + (c.image || 0) + ' · 样式 ' + (c.css || 0) +
          ' · 字体 ' + (c.font || 0) + ' · 脚本 ' + (c.script || 0) + ' · 子文档 ' + (c.subHtml || 0) + '</div>' +
        (s.baseUrl ? '<div class="muted" style="margin-top:4px;word-break:break-all">解析基准：' + esc(s.baseUrl) + '</div>' : '') +
      '</div>' +
      '<div class="detail">' +
        '<h4>未归档引用 ' + s.missTotal + ' 处</h4>' +
        (s.missTotal
          ? '<ul>' + miss + '</ul><div class="muted" style="margin-top:6px">这些资源在 MHT 里本来就不存在，离线打开时无法加载，不会影响其余部分。</div>'
          : '<div class="muted">无，页面内的引用全部已内联到文件中。</div>') +
      '</div>';
  }

  function rowHtml(item) {
    var st = STATUS[item.status] || STATUS.wait;
    return '<tr data-id="' + item.id + '">' +
      '<td><div class="fname" title="' + esc(item.name) + '">' + esc(item.name) + '</div>' +
        (item.error && item.status === 'error' ? '<div class="muted" style="font-size:12.5px">' + esc(item.error) + '</div>' : '') +
      '</td>' +
      '<td class="num">' + fmtSize(item.size) + '</td>' +
      '<td><span class="badge ' + st.cls + '">' + st.text + '</span></td>' +
      '<td class="num">' + (item.out ? item.out.stats.resourcesInlined : '—') + '</td>' +
      '<td class="num">' + (item.out ? fmtSize(item.out.stats.outputSize) : '—') + '</td>' +
      '<td class="cell-ops">' + ops(item) + '</td>' +
      '</tr>' +
      '<tr class="row-detail" data-detail="' + item.id + '"' + (item.expanded ? '' : ' style="display:none"') + '>' +
      '<td colspan="6" style="padding:0">' + detailHtml(item) + '</td></tr>';
  }

  function renderRow(item) {
    var old = els.fileList.querySelector('tr[data-id="' + item.id + '"]');
    if (!old) { renderAll(); return; }
    var detail = old.nextElementSibling;
    if (detail && detail.classList.contains('row-detail')) detail.remove();
    old.outerHTML = rowHtml(item);
  }

  function renderAll() {
    var html = state.items.map(rowHtml).join('');
    els.fileList.innerHTML = html;
    els.emptyHint.style.display = state.items.length ? 'none' : 'block';
    renderStats();
    updateButtons();
  }

  function renderStats() {
    var ok = 0, warn = 0, err = 0, wait = 0, out = 0;
    state.items.forEach(function (i) {
      if (i.status === 'ok') ok++;
      else if (i.status === 'warn') warn++;
      else if (i.status === 'error' || i.status === 'over') err++;
      else wait++;
      if (i.out) out += i.out.stats.outputSize;
    });
    els.stats.innerHTML = state.items.length
      ? ('共 <b>' + state.items.length + '</b> 个文件 · 完成 <b>' + (ok + warn) + '</b>' +
         (warn ? '（' + warn + ' 个有未归档引用）' : '') +
         (wait ? ' · 待转换 <b>' + wait + '</b>' : '') +
         ' · 失败/跳过 <b>' + err + '</b> · 合计输出 <b>' + fmtSize(out) + '</b>')
      : '';
  }

  function updateButtons() {
    var hasConvertible = state.items.some(function (i) { return i.status !== 'over'; });
    var hasResult = state.items.some(function (i) { return i.out && i.out.bytes; });
    var waiting = state.items.filter(function (i) { return i.status === 'wait' || i.status === 'error'; }).length;
    els.btnConvert.disabled = state.running || !hasConvertible;
    els.btnZip.disabled = state.running || !hasResult;
    els.btnClear.disabled = state.running || !state.items.length;

    var label;
    if (state.running) label = '转换中…';
    else if (waiting && hasResult) label = '转换新增文件 (' + waiting + ')';
    else if (waiting) label = '开始转换';
    else if (hasResult) label = '重新转换全部';
    else label = '开始转换';
    els.btnConvert.textContent = label;
    els.btnConvert.title = (waiting && hasResult)
      ? '只转换还没结果的 ' + waiting + ' 个文件，已有的转换结果会保留'
      : (hasResult ? '把所有文件重新转换一遍' : '开始转换列表中的文件');
  }

  /* ---------------- 事件绑定 ---------------- */

  function findItem(id) {
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
    return null;
  }

  function bind() {
    els.dropZone.addEventListener('click', function () { els.fileInput.click(); });
    els.fileInput.addEventListener('change', function () {
      addFiles(els.fileInput.files);
      els.fileInput.value = '';
    });

    ['dragenter', 'dragover'].forEach(function (type) {
      els.dropZone.addEventListener(type, function (e) {
        e.preventDefault(); e.stopPropagation();
        els.dropZone.classList.add('drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      els.dropZone.addEventListener(type, function (e) {
        e.preventDefault(); e.stopPropagation();
        els.dropZone.classList.remove('drag');
      });
    });
    els.dropZone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    els.btnConvert.addEventListener('click', convertAll);
    els.btnZip.addEventListener('click', downloadZip);
    els.btnClear.addEventListener('click', clearAll);

    els.fileList.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      var item = findItem(btn.getAttribute('data-id'));
      if (!item) return;
      var act = btn.getAttribute('data-act');
      if (act === 'preview') previewItem(item);
      else if (act === 'download') downloadItem(item);
      else if (act === 'remove') removeItem(item.id);
      else if (act === 'toggle') { item.expanded = !item.expanded; renderRow(item); }
    });

    els.previewClose.addEventListener('click', closePreview);
    els.previewMask.addEventListener('click', function (e) { if (e.target === els.previewMask) closePreview(); });
    els.previewOpen.addEventListener('click', function () {
      var item = state.previewItem;
      if (!item || !item.out) return;
      var url = URL.createObjectURL(blobOf(item));
      var w = null;
      try { w = window.open(url, '_blank', 'noopener'); } catch (err) { w = null; }
      if (!w) toast('浏览器拦截了新窗口，请先用“下载”保存后再打开');
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && els.previewMask.classList.contains('show')) closePreview();
    });

    ['optInlineStyle', 'optDisableJs', 'optBom', 'optStripMissing'].forEach(function (id) {
      els[id].addEventListener('change', function () {
        if (!state.items.some(function (i) { return i.out; })) return;
        state.items.forEach(function (i) {
          if (i.status === 'over') return;
          i.out = null; i.status = 'wait'; i.error = '';
        });
        renderAll();
        els.progressWrap.classList.remove('show');
        toast('选项已变更，请重新转换');
      });
    });
  }

  bind();
  renderAll();
})();
