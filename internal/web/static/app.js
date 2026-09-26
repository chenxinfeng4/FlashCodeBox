/* ============================================================
 * FileSender 前端
 * 设计约束：
 *  1) 所有请求一律使用相对路径（"api/..."），部署在任意反代子路径下都成立
 *  2) 发送与取件同页，hash 路由：#/c/取件码、#/admin
 *  3) 发送区是微信式聊天窗口：文字+文件成为气泡，取件码后可继续发
 *  4) 大文件默认走分片上传（并发 3、失败退避重试、断点续传）
 * ============================================================ */
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  composer: {
    code: null,      // 当前分享的取件码（null = 尚未生成）
    messages: [],    // {uid, kind:'text'|'file', text?, file?, status, pct, err?}
    busy: false,
  },
  adminPage: 1,
};

let msgSeq = 0;

/* ---------------- 主题 ---------------- */

function applyTheme(dark, persist) {
  document.documentElement.classList.toggle('theme-dark', dark);
  $('themeBtn').textContent = dark ? '☀️' : '🌙';
  if (persist) localStorage.setItem('fs_theme', dark ? 'dark' : 'light');
}

$('themeBtn').addEventListener('click', () => {
  applyTheme(!document.documentElement.classList.contains('theme-dark'), true);
});

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

/* ---------------- 发送：聊天流 ---------------- */

function autogrow() {
  const el = $('sendText');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}
$('sendText').addEventListener('input', autogrow);

function fileKey(file) { return `${file.name}:${file.size}:${file.lastModified}`; }

function typesAllowed(name) {
  const list = (state.config && state.config.allowed_types) || ['*'];
  if (list.includes('*')) return true;
  const i = name.lastIndexOf('.');
  if (i < 0) return false;
  return list.includes(name.slice(i + 1).toLowerCase());
}

function validateFile(file) {
  if (state.config && file.size > state.config.max_upload_size) {
    return `超过大小限制（最大 ${humanBytes(state.config.max_upload_size)}）`;
  }
  if (state.config && !typesAllowed(file.name)) return '类型不被允许';
  return null;
}

// 选择/拖拽/粘贴的文件立即进入消息流（pending 状态，点发送才上传）
function addFiles(files) {
  hideError('sendError');
  const cp = state.composer;
  for (const f of files) {
    if (f.size === 0) { showError('sendError', `「${f.name}」是空文件，已跳过`); continue; }
    const err = validateFile(f);
    if (err) { showError('sendError', `「${f.name}」${err}，已跳过`); continue; }
    if (cp.messages.some((m) => m.kind === 'file' && fileKey(m.file) === fileKey(f))) continue;
    if (cp.messages.length >= 100) { showError('sendError', '单个分享最多 100 条内容'); break; }
    cp.messages.push({ uid: ++msgSeq, kind: 'file', file: f, status: 'pending' });
  }
  renderChat();
}

$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', () => {
  addFiles(Array.from($('fileInput').files || []));
  $('fileInput').value = '';
});

// 拖拽文件到聊天窗口
const composer = $('composer');
['dragover', 'dragenter'].forEach((ev) =>
  composer.addEventListener(ev, (e) => { e.preventDefault(); composer.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) =>
  composer.addEventListener(ev, (e) => { e.preventDefault(); composer.classList.remove('dragover'); }));
composer.addEventListener('drop', (e) => {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) addFiles(Array.from(files));
});
// 拖到页面其他位置也别让浏览器直接打开文件
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// 粘贴文件（文字粘贴走 textarea 原生行为）
document.addEventListener('paste', (e) => {
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) {
    e.preventDefault();
    addFiles(Array.from(files));
  }
});

/* ---------------- 分片上传 ---------------- */

async function uploadFile(msg, expire, code) {
  const file = msg.file;
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
  let completedBytes = 0;
  uploaded.forEach((i) => { completedBytes += Math.min(chunk_size, file.size - i * chunk_size); });
  msg.pct = file.size ? Math.round((completedBytes / file.size) * 100) : 100;
  updateMsgProgress(msg);

  let next = 0;
  let failure = null;
  const WORKERS = 3;
  const startTime = Date.now();

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
            let m = `分片上传失败（HTTP ${res.status}）`;
            try {
              const j = await res.json();
              if (j && j.message) m = j.message;
            } catch (_) { /* ignore */ }
            throw new Error(m);
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
      msg.pct = file.size ? Math.round((completedBytes / file.size) * 100) : 100;
      updateMsgProgress(msg);
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
  if (failure) throw failure;

  // 3) 合并并放入分享
  const body = {};
  if (code) body.code = code;
  else { body.expire_value = expire.value; body.expire_style = expire.style; }
  return apiFetch(`api/upload/${encodeURIComponent(upload_id)}/complete`, { json: body });
}

function updateMsgProgress(msg) {
  const el = document.querySelector(`[data-uid="${msg.uid}"] .msg-progress .bar`);
  if (el) el.style.width = (msg.pct || 0) + '%';
}

/* ---------------- 消息流渲染 ---------------- */

function renderChat() {
  const cp = state.composer;
  const flow = $('chatFlow');
  flow.textContent = '';

  for (const m of cp.messages) {
    const row = document.createElement('div');
    row.className = `msg ${m.kind} ${m.status}`;
    row.dataset.uid = m.uid;

    const bubble = document.createElement('div');
    bubble.className = m.kind === 'file' ? 'msg-bubble filebubble' : 'msg-bubble';

    if (m.kind === 'text') {
      bubble.textContent = m.text;
    } else {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '30');
      svg.setAttribute('height', '30');
      svg.setAttribute('class', 'filebubble-icon');
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', 'M14 3v5h5M6 3h9l5 5v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.6');
      p.setAttribute('fill', 'none');
      svg.appendChild(p);
      bubble.appendChild(svg);

      const info = document.createElement('div');
      info.className = 'filebubble-info';
      const nm = document.createElement('div');
      nm.className = 'filebubble-name';
      nm.textContent = m.file.name;
      nm.title = m.file.name;
      const sz = document.createElement('div');
      sz.className = 'filebubble-size';
      sz.textContent = humanBytes(m.file.size);
      info.append(nm, sz);
      bubble.appendChild(info);

      const prog = document.createElement('div');
      prog.className = 'msg-progress';
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.width = (m.pct || 0) + '%';
      prog.appendChild(bar);
      bubble.appendChild(prog);
    }
    row.appendChild(bubble);

    // 右侧状态：发送中转圈 / 失败重试
    const stateEl = document.createElement('div');
    stateEl.className = 'msg-state';
    if (m.status === 'sending') {
      const sp = document.createElement('div');
      sp.className = 'spinner';
      stateEl.appendChild(sp);
    } else if (m.status === 'failed') {
      const btn = document.createElement('button');
      btn.className = 'retry';
      btn.textContent = '⚠';
      btn.title = (m.err || '发送失败') + '，点击重试';
      btn.addEventListener('click', () => { m.status = 'sending'; renderChat(); doSend(); });
      stateEl.appendChild(btn);
    }
    row.appendChild(stateEl);

    flow.appendChild(row);
  }
  flow.scrollTop = flow.scrollHeight;

  // 头部状态
  $('codeArea').hidden = !cp.code;
  $('newShareBtn').hidden = !cp.code;
  $('expireCtrl').hidden = !!cp.code;
  if (cp.code) $('resultCode').textContent = cp.code;
}

function setSendingUI(on) {
  state.composer.busy = on;
  $('sendBtn').disabled = on;
}

function readExpire() {
  let value = parseInt($('expireValue').value, 10);
  if (!Number.isFinite(value) || value < 1) value = 1;
  if (value > 9999) value = 9999;
  return { value, style: $('expireStyle').value };
}

async function doSend() {
  const cp = state.composer;
  if (cp.busy) return;

  const text = $('sendText').value.trim();
  const hasPendingFiles = cp.messages.some((m) => m.kind === 'file' && m.status === 'pending');
  if (!text && !hasPendingFiles) return;
  if (!cp.code && $('expireCtrl').hidden) { /* 不会发生，防御 */ }
  hideError('sendError');

  // 文字入流
  if (text) {
    cp.messages.push({ uid: ++msgSeq, kind: 'text', text, status: 'sending' });
    $('sendText').value = '';
    autogrow();
  }
  // 待发文件转为 sending
  for (const m of cp.messages) {
    if (m.kind === 'file' && m.status === 'pending') m.status = 'sending';
  }
  setSendingUI(true);
  renderChat();

  for (const m of cp.messages) {
    if (m.status !== 'sending') continue;
    try {
      if (m.kind === 'text') {
        const body = { text: m.text };
        if (cp.code) body.code = cp.code;
        else {
          const ex = readExpire();
          body.expire_value = ex.value;
          body.expire_style = ex.style;
        }
        const r = await apiFetch('api/send/text', { json: body });
        cp.code = r.code;
        m.status = 'sent';
      } else {
        const r = await uploadFile(m, readExpire(), cp.code);
        cp.code = r.code;
        m.status = 'sent';
      }
    } catch (e) {
      m.status = 'failed';
      m.err = e.message;
    }
    renderChat();
  }
  setSendingUI(false);
}

$('sendBtn').addEventListener('click', doSend);
$('sendText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    doSend();
  }
});

// 新开分享：清空聊天流与当前取件码
$('newShareBtn').addEventListener('click', () => {
  state.composer.code = null;
  state.composer.messages = [];
  hideError('sendError');
  renderChat();
  $('sendText').focus();
});

$('copyCodeBtn').addEventListener('click', async () => {
  (await copyText(state.composer.code || '')) && flashButton($('copyCodeBtn'), '✓');
});
$('copyLinkBtn').addEventListener('click', async () => {
  const code = state.composer.code;
  if (!code) return;
  const link = location.origin + location.pathname.replace(/index\.html$/, '') + '#/c/' + code;
  (await copyText(link)) && flashButton($('copyLinkBtn'), '✓');
});

/* ---------------- 取件：渲染内容条目 ---------------- */

function renderPick(data) {
  $('getResult').hidden = false;
  const items = data.items || [];
  $('pickMeta').textContent = `共 ${items.length} 项 · ${expireText(data)}`;

  const wrap = $('pickItems');
  wrap.textContent = '';
  for (const it of items) {
    if (it.type === 'text') {
      const line = document.createElement('div');
      line.className = 'bubble-wrap';

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
      line.appendChild(bubble);
      wrap.appendChild(line);
    } else {
      const line = document.createElement('div');
      line.className = 'bubble-wrap';

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

      line.appendChild(card);
      wrap.appendChild(line);
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
}

(async function boot() {
  applyTheme(localStorage.getItem('fs_theme') === 'dark', false);
  await loadPublicConfig();
  route();
})();
