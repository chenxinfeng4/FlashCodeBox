/* ============================================================
 * FileSender 前端
 * 设计约束：
 *  1) 所有请求一律使用相对路径（"api/..."），部署在任意反代子路径下都成立
 *  2) 发送与取件同页，hash 路由：#/c/取件码、#/admin
 *  3) 大文件默认走分片上传（并发 3、失败退避重试、断点续传）
 * ============================================================ */
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  file: null,
  sending: false,
  tab: 'text',
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

/* ---------------- 发送：文本 ---------------- */

$('sendText').addEventListener('input', () => {
  $('textCount').textContent = humanBytes(new Blob([$('sendText').value]).size);
});

/* ---------------- 发送：文件 ---------------- */

function setFile(file) {
  if (!file) return;
  if (state.config && file.size > state.config.max_upload_size) {
    showError('sendError', `文件超过大小限制（最大 ${humanBytes(state.config.max_upload_size)}）`);
    return;
  }
  hideError('sendError');
  state.file = file;
  $('fileChipName').textContent = file.name;
  $('fileChipSize').textContent = humanBytes(file.size);
  $('fileChip').hidden = false;
  $('dropzone').hidden = true;
  if (state.tab !== 'file') document.querySelector('.tab[data-tab="file"]').click();
}

function clearFile() {
  state.file = null;
  $('fileChip').hidden = true;
  $('dropzone').hidden = false;
  $('fileInput').value = '';
}

$('fileClear').addEventListener('click', clearFile);

$('fileInput').addEventListener('change', () => {
  const file = $('fileInput').files && $('fileInput').files[0];
  if (file) setFile(file);
});

$('dropzone').addEventListener('click', () => $('fileInput').click());
$('dropzone').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') $('fileInput').click();
});
['dragover', 'dragenter'].forEach((ev) =>
  $('dropzone').addEventListener(ev, (e) => { e.preventDefault(); $('dropzone').classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) =>
  $('dropzone').addEventListener(ev, (e) => { e.preventDefault(); $('dropzone').classList.remove('dragover'); }));
$('dropzone').addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) setFile(file);
});

// 拖到页面其他位置也别让浏览器直接打开文件
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// 粘贴文件（文件页签下）
document.addEventListener('paste', (e) => {
  if (state.tab !== 'file') return;
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) {
    e.preventDefault();
    setFile(files[0]);
  }
});

/* ---------------- 选项卡 ---------------- */

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    state.tab = btn.dataset.tab;
    $('paneText').hidden = state.tab !== 'text';
    $('paneFile').hidden = state.tab !== 'file';
    hideError('sendError');
  });
});

/* ---------------- 有效期控件 ---------------- */

$('expireStyle').addEventListener('change', () => {
  const forever = $('expireStyle').value === 'forever';
  $('expireValue').hidden = forever;
  $('expireValue').parentElement.title = forever ? '' : '数量（天 / 小时 / 分钟 / 次数）';
});

/* ---------------- 分片上传 ---------------- */

function fileKey(file) { return `${file.name}:${file.size}:${file.lastModified}`; }

function updateProgress(done, total, startTime) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('progressBar').style.width = pct + '%';
  $('progressText').textContent = `${humanBytes(done)} / ${humanBytes(total)}（${pct}%）`;
  const sec = (Date.now() - startTime) / 1000;
  if (sec > 0.5) $('progressSpeed').textContent = humanBytes(done / sec) + '/s';
}

async function uploadFile(file, expire) {
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
  updateProgress(completedBytes, file.size, startTime);

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
      updateProgress(completedBytes, file.size, startTime);
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
  if (failure) throw failure;

  // 3) 合并并创建分享
  const result = await apiFetch(`api/upload/${encodeURIComponent(upload_id)}/complete`, {
    json: { expire_value: expire.value, expire_style: expire.style },
  });
  localStorage.removeItem('fs_up_' + fileKey(file));
  return result;
}

/* ---------------- 发送主流程 ---------------- */

function setSending(on) {
  state.sending = on;
  $('sendBtn').disabled = on;
  $('sendBtn').textContent = on ? '处理中…' : '生成取件码';
}

function showSendResult(data) {
  $('resultCode').textContent = data.code;
  const lines = [expireText(data)];
  if (data.type === 'file') lines.unshift(`${data.filename} · ${humanBytes(data.size)}`);
  else lines.unshift('文本分享');
  $('resultMeta').textContent = lines.join(' · ');
  $('sendResult').hidden = false;
  $('progress').hidden = true;
  $('copyCodeBtn').onclick = async () => {
    (await copyText(data.code)) && flashButton($('copyCodeBtn'), '已复制 ✓');
  };
  $('copyLinkBtn').onclick = async () => {
    const link = location.origin + location.pathname.replace(/index\.html$/, '') + '#/c/' + data.code;
    (await copyText(link)) && flashButton($('copyLinkBtn'), '已复制 ✓');
  };
}

async function doSend() {
  if (state.sending) return;
  hideError('sendError');
  $('sendResult').hidden = true;

  const style = $('expireStyle').value;
  let value = parseInt($('expireValue').value, 10);
  if (!Number.isFinite(value) || value < 1) value = 1;
  if (value > 9999) value = 9999;
  const expire = { value, style };

  if (state.tab === 'text') {
    const text = $('sendText').value;
    if (!text.trim()) { showError('sendError', '请输入要分享的内容'); return; }
    setSending(true);
    try {
      const data = await apiFetch('api/send/text', {
        json: { text, expire_value: value, expire_style: style },
      });
      showSendResult(data);
    } catch (e) {
      showError('sendError', e.message);
    }
    setSending(false);
    return;
  }

  if (!state.file) { showError('sendError', '请选择要发送的文件'); return; }
  setSending(true);
  $('progress').hidden = false;
  updateProgress(0, state.file.size, Date.now());
  try {
    const data = await uploadFile(state.file, expire);
    showSendResult(data);
  } catch (e) {
    $('progress').hidden = true;
    showError('sendError', e.message);
  }
  setSending(false);
}

$('sendBtn').addEventListener('click', doSend);
$('againBtn').addEventListener('click', () => {
  $('sendResult').hidden = true;
  if (state.tab === 'text') { $('sendText').value = ''; $('textCount').textContent = '0 B'; }
  else clearFile();
  $('sendText') && $('sendText').focus();
});

/* ---------------- 取件 ---------------- */

function renderPick(data) {
  $('getResult').hidden = false;
  $('pickMeta').textContent =
    (data.type === 'text' ? '文本分享' : '文件分享') + ' · ' + expireText(data);

  const isText = data.type === 'text';
  $('pickTextWrap').hidden = !isText;
  $('pickFileWrap').hidden = isText;

  if (isText) {
    $('pickText').textContent = data.text || '';
    $('copyTextBtn').onclick = async () => {
      (await copyText(data.text || '')) && flashButton($('copyTextBtn'), '已复制 ✓');
    };
    // 相对路径下载（服务端也返回了相对 download_url，这里保持一致）
    $('pickTextDownload').href = `api/download/${encodeURIComponent(data.code)}`;
  } else {
    $('pickFileName').textContent = data.filename || '未命名文件';
    $('pickFileSize').textContent = humanBytes(data.size);
    // 服务端返回的 download_url 就是相对路径，直接可用
    $('pickDownload').href = data.download_url || `api/download/${encodeURIComponent(data.code)}`;
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
      tdType.textContent = it.type === 'text' ? '文本' : '文件';

      const tdContent = document.createElement('td');
      tdContent.className = 'cell-dim';
      tdContent.textContent = it.type === 'text'
        ? (it.text || '').slice(0, 60) || '(空)'
        : it.filename || '-';
      tdContent.title = it.type === 'text' ? it.text : it.filename;

      const tdSize = document.createElement('td');
      tdSize.textContent = it.type === 'file' ? humanBytes(it.size) : humanBytes((it.text || '').length);

      const tdUsed = document.createElement('td');
      tdUsed.textContent = `已取 ${it.used_count} · ${it.expired ? '已过期' : (it.expire_count < 0 ? '不限次' : `剩 ${it.expire_count}`)}`;

      const tdExpire = document.createElement('td');
      tdExpire.textContent = it.expire_at ? fmtTime(it.expire_at) : '永久';

      const tdOp = document.createElement('td');
      const delBtn = document.createElement('button');
      delBtn.className = 'iconbtn';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`确定删除取件码 ${it.code} 吗？对应文件也会被删除。`)) return;
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
  $('textLimit').textContent = `上限 ${humanBytes(cfg.max_text_size)}`;
  $('sizeLimit').textContent = `单文件上限 ${humanBytes(cfg.max_upload_size)}`;
}

(async function boot() {
  await loadPublicConfig();
  route();
})();
