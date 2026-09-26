/* ============================================================
 * FileSender 前端
 * 设计约束：
 *  1) 所有请求一律使用相对路径（"api/..."），部署在任意反代子路径下都成立
 *  2) 发送与取件同页，hash 路由：#/c/取件码、#/admin
 *  3) 发送区是聊天式输入框：文字 + 多文件混搭，生成取件码后可继续追加
 *  4) 大文件默认走分片上传（并发 3、失败退避重试、断点续传）
 * ============================================================ */
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  composer: {
    code: null,      // 当前分享的取件码（null = 尚未生成）
    items: [],       // 已放入分享的内容（本地展示用）
    pending: [],     // 待发送的文件（File 对象）
    sending: false,
  },
  adminPage: 1,
};

/* ---------------- 基础工具 ---------------- */

function humanBytes(n) {
  if (n == null || isNaN(n)) return '-';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { /* ignore */ }
    ta.remove();
    return ok;
  }
}

async function flashButton(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1200);
}

function showError(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.hidden = false;
}

function hideError(id) { $(id).hidden = true; }

function fmtTime(unix) {
  if (!unix) return '';
  return new Date(unix * 1000).toLocaleString('zh-CN', { hour12: false });
}

function expireText(d) {
  if (d.expire_count > 0) {
    return `剩余 ${d.expire_count} 次可取` + (d.expire_at ? ` · ${fmtTime(d.expire_at)} 前有效` : '');
  }
  if (!d.expire_at) return '永久有效';
  return `${fmtTime(d.expire_at)} 前有效`;
}

/**
 * 统一 API 封装：path 必须是相对路径。
 * 自动携带管理端 Bearer Token；json 参数会序列化为请求体。
 */
async function apiFetch(path, options = {}) {
  const opts = { headers: {}, ...options };
  const token = localStorage.getItem('fs_admin_token');
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (opts.json !== undefined) {
    opts.method = opts.method || 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.json);
    delete opts.json;
  }
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch (_) { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error((body && body.message) || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return body ? body.data : null;
}

async function sha256Hex(blob) {
  if (!(window.crypto && crypto.subtle)) return null; // http 部署时不可用，自动降级
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- 发送：聊天式输入框 ---------------- */

function autogrow() {
  const el = $('sendText');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
}
$('sendText').addEventListener('input', autogrow);

function fileKey(file) { return `${file.name}:${file.size}:${file.lastModified}`; }

function validateFile(file) {
  if (state.config && file.size > state.config.max_upload_size) {
    return `文件超过大小限制（最大 ${humanBytes(state.config.max_upload_size)}）`;
  }
  if (state.config && !typesAllowed(file.name)) {
    return '文件类型不被允许';
  }
  return null;
}

function typesAllowed(name) {
  const list = (state.config && state.config.allowed_types) || ['*'];
  if (list.includes('*')) return true;
  const i = name.lastIndexOf('.');
  if (i < 0) return false;
  return list.includes(name.slice(i + 1).toLowerCase());
}

function addPendingFiles(files) {
  hideError('sendError');
  for (const f of files) {
    if (f.size === 0) { showError('sendError', `「${f.name}」是空文件，已跳过`); continue; }
    const err = validateFile(f);
    if (err) { showError('sendError', `「${f.name}」：${err}，已跳过`); continue; }
    if (state.composer.pending.some((p) => fileKey(p) === fileKey(f))) continue;
    if (state.composer.pending.length + 1 > 100) {
      showError('sendError', '单次最多添加 100 个文件');
      break;
    }
    state.composer.pending.push(f);
  }
  renderPending();
}

function renderPending() {
  const wrap = $('attachList');
  wrap.textContent = '';
  state.composer.pending.forEach((f, idx) => {
    const chip = document.createElement('span');
    chip.className = 'attchip';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M14 3v5h5M6 3h9l5 5v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('fill', 'none');
    svg.appendChild(path);
    chip.appendChild(svg);

    const name = document.createElement('span');
    name.className = 'attchip-name';
    name.textContent = f.name;
    name.title = `${f.name}（${humanBytes(f.size)}）`;
    chip.appendChild(name);

    const size = document.createElement('span');
    size.className = 'hint';
    size.textContent = humanBytes(f.size);
    chip.appendChild(size);

    const del = document.createElement('button');
    del.className = 'iconbtn';
    del.textContent = '✕';
    del.title = '移除';
    del.addEventListener('click', () => {
      state.composer.pending.splice(idx, 1);
      renderPending();
    });
    chip.appendChild(del);

    wrap.appendChild(chip);
  });
}

function clearPending() {
  state.composer.pending = [];
  renderPending();
}

$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', () => {
  addPendingFiles(Array.from($('fileInput').files || []));
  $('fileInput').value = '';
});

// 拖拽文件到输入框
const composer = $('composer');
['dragover', 'dragenter'].forEach((ev) =>
  composer.addEventListener(ev, (e) => { e.preventDefault(); composer.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) =>
  composer.addEventListener(ev, (e) => { e.preventDefault(); composer.classList.remove('dragover'); }));
composer.addEventListener('drop', (e) => {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) addPendingFiles(Array.from(files));
});
// 拖到页面其他位置也别让浏览器直接打开文件
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// 粘贴文件（文字粘贴走 textarea 原生行为）
document.addEventListener('paste', (e) => {
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) {
    e.preventDefault();
    addPendingFiles(Array.from(files));
  }
});

/* ---------------- 分片上传 ---------------- */

function updateProgress(done, total, startTime, label) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('progressBar').style.width = pct + '%';
  $('progressText').textContent = (label ? label + ' · ' : '') +
    `${humanBytes(done)} / ${humanBytes(total)}（${pct}%）`;
  const sec = (Date.now() - startTime) / 1000;
  if (sec > 0.5) $('progressSpeed').textContent = humanBytes(done / sec) + '/s';
}

/**
 * 分片上传一个文件并追加到分享。
 * @param code 现有取件码；为空时由 complete 的 expire 参数创建新分享
 */
async function uploadFile(file, expire, code) {
  // 1) 初始化或续传：localStorage 里存着上次未完成的 upload_id
  let session = null;
  const savedId = localStorage.getItem('fs_up_' + fileKey(file));
  if (savedId) {
    try { session = await apiFetch(`api/upload/${encodeURIComponent(savedId)}/status`); }
    catch (_) { session = null; }
  }
  if (!session) {
    let fileHash = '';
    if (file.size <= 64 * 1024 * 1024) { // 整文件哈希仅对小文件计算，避免大文件卡顿
      try { fileHash = (await sha256Hex(file)) || ''; } catch (_) { /* ignore */ }
    }
    session = await apiFetch('api/upload/init', {
      json: { file_name: file.name, file_size: file.size, file_hash: fileHash },
    });
  }
  const { upload_id, chunk_size, total_chunks } = session;
  localStorage.setItem('fs_up_' + fileKey(file), upload_id);

  // 2) 并发上传分片
  const uploaded = new Set(session.uploaded || []);
  const startTime = Date.now();
  let completedBytes = 0;
  uploaded.forEach((i) => { completedBytes += Math.min(chunk_size, file.size - i * chunk_size); });
  updateProgress(completedBytes, file.size, startTime, file.name);

  let next = 0;
  let failure = null;
  const WORKERS = 3;

  async function worker() {
    while (!failure) {
      const i = next++;
      if (i >= total_chunks) return;
      if (uploaded.has(i)) continue;
      const start = i * chunk_size;
      const blob = file.slice(start, Math.min(start + chunk_size, file.size));
      const hash = await sha256Hex(blob);
      let attempt = 0;
      for (;;) {
        try {
          const headers = { 'Content-Type': 'application/octet-stream' };
          if (hash) headers['X-Chunk-Hash'] = hash;
          const res = await fetch(`api/upload/${encodeURIComponent(upload_id)}/${i}`, {
            method: 'PUT',
            body: blob,
            headers,
          });
          if (!res.ok) {
            let msg = `分片 ${i + 1} 上传失败（HTTP ${res.status}）`;
            try {
              const j = await res.json();
              if (j && j.message) msg = j.message;
            } catch (_) { /* ignore */ }
            throw new Error(msg);
          }
          break;
        } catch (err) {
          attempt++;
          if (attempt >= 3) { failure = err; return; }
          await new Promise((r) => setTimeout(r, 800 * attempt)); // 退避重试
        }
      }
      uploaded.add(i);
      completedBytes += blob.size;
      updateProgress(completedBytes, file.size, startTime, file.name);
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
  if (failure) throw failure;

  // 3) 合并并追加到分享
  const body = {};
  if (code) body.code = code;
  else { body.expire_value = expire.value; body.expire_style = expire.style; }
  const result = await apiFetch(`api/upload/${encodeURIComponent(upload_id)}/complete`, { json: body });
  localStorage.removeItem('fs_up_' + fileKey(file));
  return result;
}

/* ---------------- 发送主流程：可反复追加 ---------------- */

function readExpire() {
  let value = parseInt($('expireValue').value, 10);
  if (!Number.isFinite(value) || value < 1) value = 1;
  if (value > 9999) value = 9999;
  return { value, style: $('expireStyle').value };
}

function setSendingUI(on) {
  state.composer.sending = on;
  $('sendBtn').disabled = on;
  $('sendBtn').textContent = on
    ? '发送中…'
    : (state.composer.code ? '追加并发送' : '生成取件码');
}

function renderCodeCard() {
  const cp = state.composer;
  if (!cp.code) {
    $('sendResult').hidden = true;
    $('shareState').textContent = '同一个输入框可反复追加，共用一个取件码';
    return;
  }
  $('resultCode').textContent = cp.code;
  const list = $('sentItems');
  list.textContent = '';
  cp.items.forEach((it) => {
    const li = document.createElement('li');
    li.textContent = (it.type === 'text' ? '✏️ ' : '📎 ') + it.label;
    list.appendChild(li);
  });
  $('resultMeta').textContent = `已包含 ${cp.items.length} 项内容 · 还可以继续追加`;
  $('sendResult').hidden = false;
  $('shareState').textContent = `取件码 ${cp.code} · 可继续追加`;
  $('expireCtrl').hidden = true;
}

async function doSend() {
  const cp = state.composer;
  if (cp.sending) return;
  hideError('sendError');

  const text = $('sendText').value;
  const files = cp.pending.slice();
  if (!text.trim() && !files.length) {
    showError('sendError', '先输入文字或添加文件');
    return;
  }
  setSendingUI(true);
  let code = cp.code;
  const sent = cp.items.slice();

  try {
    // 1) 文字先入分享
    if (text.trim()) {
      const body = { text };
      if (code) body.code = code;
      else {
        const ex = readExpire();
        body.expire_value = ex.value;
        body.expire_style = ex.style;
      }
      const r = await apiFetch('api/send/text', { json: body });
      code = r.code;
      sent.push({ type: 'text', label: r.item_label });
      $('sendText').value = '';
      autogrow();
    }

    // 2) 文件逐个分片上传（串行，进度按文件展示）
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      $('progress').hidden = false;
      updateProgress(0, f.size, Date.now(), `（${i + 1}/${files.length}）${f.name}`);
      const r = await uploadFile(f, readExpire(), code);
      code = r.code;
      sent.push({ type: 'file', label: `${f.name}（${humanBytes(f.size)}）` });
    }

    // 3) 全部成功：更新本地状态
    cp.code = code;
    cp.items = sent;
    clearPending();
    $('progress').hidden = true;
    renderCodeCard();
  } catch (e) {
    // 失败的文件留在待发送列表，改完可直接重试
    cp.pending = cp.pending.filter((f) => !sent.some((s) => s.type === 'file' && s.label.startsWith(f.name)));
    renderPending();
    if (code && !cp.code) {
      cp.code = code;
      cp.items = sent;
      renderCodeCard();
    }
    $('progress').hidden = true;
    showError('sendError', e.message + '（未发送的文件已保留，可重试）');
  }
  setSendingUI(false);
}

$('sendBtn').addEventListener('click', doSend);

// 新开分享：清空当前取件码状态（替代旧的"再发一个"）
$('newShareBtn').addEventListener('click', () => {
  state.composer.code = null;
  state.composer.items = [];
  $('sendResult').hidden = true;
  $('expireCtrl').hidden = false;
  hideError('sendError');
  renderCodeCard();
  $('sendText').focus();
});

$('copyCodeBtn').addEventListener('click', async () => {
  (await copyText(state.composer.code || '')) && flashButton($('copyCodeBtn'), '已复制 ✓');
});
$('copyLinkBtn').addEventListener('click', async () => {
  const code = state.composer.code;
  if (!code) return;
  const link = location.origin + location.pathname.replace(/index\.html$/, '') + '#/c/' + code;
  (await copyText(link)) && flashButton($('copyLinkBtn'), '已复制 ✓');
});

/* ---------------- 取件：渲染内容条目 ---------------- */

function renderPick(data) {
  $('getResult').hidden = false;
  const items = data.items || [];
  $('pickMeta').textContent = `共 ${items.length} 项内容 · ${expireText(data)}`;

  const wrap = $('pickItems');
  wrap.textContent = '';
  for (const it of items) {
    if (it.type === 'text') {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';

      const pre = document.createElement('pre');
      pre.textContent = it.text || '';
      bubble.appendChild(pre);

      const bar = document.createElement('div');
      bar.className = 'bubble-bar';
      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn ghost';
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', async () => {
        (await copyText(it.text || '')) && flashButton(copyBtn, '已复制 ✓');
      });
      bar.appendChild(copyBtn);
      bubble.appendChild(bar);
      wrap.appendChild(bubble);
    } else {
      const card = document.createElement('div');
      card.className = 'filecard';

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '24');
      svg.setAttribute('height', '24');
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', 'M14 3v5h5M6 3h9l5 5v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.8');
      p.setAttribute('fill', 'none');
      svg.appendChild(p);
      card.appendChild(svg);

      const info = document.createElement('div');
      info.className = 'filecard-info';
      const nm = document.createElement('div');
      nm.className = 'filecard-name';
      nm.textContent = it.filename || '未命名文件';
      nm.title = it.filename || '';
      const sz = document.createElement('div');
      sz.className = 'hint';
      sz.textContent = humanBytes(it.size);
      info.append(nm, sz);
      card.appendChild(info);

      const a = document.createElement('a');
      a.className = 'btn';
      a.textContent = '下载';
      a.setAttribute('download', '');
      a.href = it.download_url || `api/download/${encodeURIComponent(data.code)}/${it.id}`;
      card.appendChild(a);

      wrap.appendChild(card);
    }
  }
}

async function doGet(codeRaw) {
  const code = String(codeRaw != null ? codeRaw : $('getCode').value).trim().toUpperCase();
  if (codeRaw != null) $('getCode').value = code;
  hideError('getError');
  $('getResult').hidden = true;
  if (!code) { showError('getError', '请输入取件码'); return; }

  $('getBtn').disabled = true;
  try {
    const data = await apiFetch('api/get', { json: { code } });
    renderPick(data);
  } catch (e) {
    showError('getError', e.message);
  } finally {
    $('getBtn').disabled = false;
  }
}

$('getForm').addEventListener('submit', (e) => { e.preventDefault(); doGet(); });
$('pickAgainBtn').addEventListener('click', () => {
  $('getResult').hidden = true;
  $('getCode').value = '';
  $('getCode').focus();
});
$('getCode').addEventListener('input', () => {
  const el = $('getCode');
  el.value = el.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
});

/* ---------------- 路由 ---------------- */

function showMain() {
  $('adminView').hidden = true;
  $('mainView').hidden = false;
}

async function showAdmin() {
  $('mainView').hidden = true;
  $('adminView').hidden = false;
  $('adminAuthCard').hidden = false;
  $('adminPanel').hidden = true;
  $('loginForm').hidden = true;
  $('setupForm').hidden = true;
  hideError('adminAuthError');

  let st;
  try {
    st = await apiFetch('api/admin/status');
  } catch (e) {
    showError('adminAuthError', '无法连接服务器：' + e.message);
    return;
  }
  if (!st.initialized) {
    $('adminAuthTitle').textContent = '初始化';
    $('setupForm').hidden = false;
    return;
  }
  $('adminAuthTitle').textContent = '管理登录';
  const token = localStorage.getItem('fs_admin_token');
  if (!token) {
    $('loginForm').hidden = false;
    return;
  }
  try {
    await loadAdminConfig();
    $('adminAuthCard').hidden = true;
    $('adminPanel').hidden = false;
    loadList(1);
  } catch (e) {
    localStorage.removeItem('fs_admin_token');
    $('loginForm').hidden = false;
    if (e.status !== 401) showError('adminAuthError', e.message);
  }
}

function route() {
  const h = location.hash;
  if (h.startsWith('#/admin')) { showAdmin(); return; }
  showMain();
  const m = h.match(/^#\/c\/([0-9A-Za-z]{1,16})/);
  if (m) doGet(m[1]);
}

window.addEventListener('hashchange', route);

/* ---------------- 管理后台 ---------------- */

async function loadAdminConfig() {
  const cfg = await apiFetch('api/admin/config');
  $('cfgName').value = cfg.name || '';
  $('cfgDesc').value = cfg.description || '';
  $('cfgOpenUpload').checked = !!cfg.open_upload;
  $('cfgMaxUpload').value = Math.round(cfg.max_upload_size / 1048576);
  $('cfgMaxText').value = Math.round(cfg.max_text_size / 1024);
  $('cfgChunk').value = Math.round(cfg.chunk_size / 1048576);
  $('cfgCodeType').value = cfg.code_type || 'number';
  $('cfgTypes').value = (cfg.allowed_types || []).join(', ');
  $('cfgMaxSave').value = cfg.max_save_seconds ? Math.round(cfg.max_save_seconds / 86400) : 0;
  $('cfgRateCount').value = cfg.rate_limit_count;
  $('cfgRateWindow').value = cfg.rate_limit_window;
  $('cfgChunkExpire').value = cfg.chunk_expire_hours;
}

$('configForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const int = (id, def) => {
    const n = parseInt($(id).value, 10);
    return Number.isFinite(n) ? n : def;
  };
  const body = {
    name: $('cfgName').value.trim() || '文件快递',
    description: $('cfgDesc').value,
    open_upload: $('cfgOpenUpload').checked,
    max_upload_size: int('cfgMaxUpload', 1024) * 1048576,
    max_text_size: int('cfgMaxText', 1024) * 1024,
    chunk_size: int('cfgChunk', 5) * 1048576,
    code_type: $('cfgCodeType').value,
    allowed_types: $('cfgTypes').value.split(',').map((s) => s.trim()).filter(Boolean),
    max_save_seconds: int('cfgMaxSave', 7) * 86400,
    rate_limit_count: int('cfgRateCount', 30),
    rate_limit_window: int('cfgRateWindow', 60),
    chunk_expire_hours: int('cfgChunkExpire', 24),
  };
  try {
    await apiFetch('api/admin/config', { method: 'PUT', json: body });
    await loadPublicConfig();
    alert('配置已保存');
  } catch (err) {
    alert('保存失败：' + err.message);
  }
});

async function loadList(page) {
  try {
    const data = await apiFetch(`api/admin/list?page=${page}&page_size=20`);
    state.adminPage = page;
    const tbody = $('listBody');
    tbody.textContent = '';
    for (const it of data.items || []) {
      const tr = document.createElement('tr');
      if (it.expired) tr.className = 'row-expired';

      const tdCode = document.createElement('td');
      tdCode.className = 'cell-code';
      tdCode.textContent = it.code;

      const tdType = document.createElement('td');
      tdType.textContent = `${it.item_count} 项（文${it.text_count}/件${it.file_count}）`;

      const tdContent = document.createElement('td');
      tdContent.className = 'cell-dim';
      tdContent.textContent = it.preview || '-';
      tdContent.title = it.preview || '';

      const tdSize = document.createElement('td');
      tdSize.textContent = humanBytes(it.total_size);

      const tdUsed = document.createElement('td');
      tdUsed.textContent = `已取 ${it.used_count} · ${it.expired ? '已过期' : (it.expire_count < 0 ? '不限次' : `剩 ${it.expire_count}`)}`;

      const tdExpire = document.createElement('td');
      tdExpire.textContent = it.expire_at ? fmtTime(it.expire_at) : '永久';

      const tdOp = document.createElement('td');
      const delBtn = document.createElement('button');
      delBtn.className = 'iconbtn';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`确定删除取件码 ${it.code} 吗？其中所有文件也会被删除。`)) return;
        try {
          await apiFetch(`api/admin/share/${encodeURIComponent(it.code)}`, { method: 'DELETE' });
          loadList(state.adminPage);
        } catch (e) { alert('删除失败：' + e.message); }
      });
      tdOp.appendChild(delBtn);

      tr.append(tdCode, tdType, tdContent, tdSize, tdUsed, tdExpire, tdOp);
      tbody.appendChild(tr);
    }
    const pages = Math.max(1, Math.ceil(data.total / (data.page_size || 20)));
    $('pageInfo').textContent = `第 ${data.page} / ${pages} 页 · 共 ${data.total} 条`;
    $('prevPage').disabled = page <= 1;
    $('nextPage').disabled = page >= pages;
  } catch (e) {
    alert('加载列表失败：' + e.message);
  }
}

$('prevPage').addEventListener('click', () => loadList(Math.max(1, state.adminPage - 1)));
$('nextPage').addEventListener('click', () => loadList(state.adminPage + 1));

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError('adminAuthError');
  try {
    const data = await apiFetch('api/admin/login', { json: { password: $('loginPassword').value } });
    localStorage.setItem('fs_admin_token', data.token);
    $('loginPassword').value = '';
    showAdmin();
  } catch (err) {
    showError('adminAuthError', err.message);
  }
});

$('setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError('adminAuthError');
  const pw = $('setupPassword').value;
  if (pw.length < 8) { showError('adminAuthError', '密码至少 8 位'); return; }
  if (pw !== $('setupPassword2').value) { showError('adminAuthError', '两次输入的密码不一致'); return; }
  try {
    const data = await apiFetch('api/admin/setup', { json: { password: pw } });
    localStorage.setItem('fs_admin_token', data.token);
    $('setupPassword').value = '';
    $('setupPassword2').value = '';
    await loadPublicConfig();
    showAdmin();
  } catch (err) {
    showError('adminAuthError', err.message);
  }
});

$('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('fs_admin_token');
  showAdmin();
});

/* ---------------- 启动 ---------------- */

async function loadPublicConfig() {
  try {
    state.config = await apiFetch('api/config');
  } catch (_) {
    state.config = null;
    return;
  }
  const cfg = state.config;
  document.title = cfg.name || '文件快递';
  $('siteName').textContent = cfg.name || '文件快递';
  $('siteDesc').textContent = cfg.description || '';
  $('ver').textContent = 'v' + (cfg.version || '');
  $('setupBanner').hidden = !!cfg.initialized;
  $('sizeLimit') && ($('sizeLimit').textContent = '');
}

(async function boot() {
  await loadPublicConfig();
  route();
})();
