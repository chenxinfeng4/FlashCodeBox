/* ============================================================
 * FileSender 前端 —— 聊天室模式
 * 设计约束：
 *  1) 所有请求一律使用相对路径（"api/..."），部署在任意反代子路径下都成立
 *  2) 主界面即聊天窗口；会议号（原取件码）分享后他人可加入
 *  3) 楼主/访客双向气泡：自己右侧绿气泡，他人左侧白气泡 + 名字
 *  4) 大文件分片上传（XHR 实时进度 + 网速），图片缩略图 + 灯箱
 * ============================================================ */
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  chat: {
    code: null,
    role: null,       // 'owner' | 'guest'
    token: null,
    memberId: null,
    sender: null,     // 楼主 / 访客N
    allowReply: true,
    expireAt: 0,
    lastId: 0,
    pollTimer: null,
    joined: false,
  },
  outbox: [],         // 发送队列（文字/文件）
  sending: false,
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

function expireText(expireAt) {
  if (!expireAt) return '永久有效';
  return `${fmtTime(expireAt)} 前有效`;
}

/**
 * 统一 API 封装：path 必须是相对路径。
 * 自动携带房间令牌（X-Room-Token）与管理端 Bearer Token。
 */
async function apiFetch(path, options = {}) {
  const opts = { headers: {}, ...options };
  if (state.chat.code && state.chat.token) {
    opts.headers['X-Room-Token'] = state.chat.token;
  }
  const adminToken = localStorage.getItem('fs_admin_token');
  if (adminToken) opts.headers['Authorization'] = 'Bearer ' + adminToken;
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

const IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif'];

function isImageName(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 && IMG_EXT.includes(name.slice(i + 1).toLowerCase());
}

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

/* ---------------- 消息流渲染（增量） ---------------- */

const renderedIds = new Set();

function msgDomId(id) { return `msg-${id}`; }

function isMine(m) { return m.member_id === state.chat.memberId; }

// 浏览器的 <img>/<a> 请求无法带自定义 header，文件 URL 统一附带房间令牌
function fileUrl(m, inline) {
  const base = m.download_url || `api/room/${encodeURIComponent(state.chat.code)}/messages/${m.id}/file`;
  const sep = base.includes('?') ? '&' : '?';
  return base + sep + 'token=' + encodeURIComponent(state.chat.token || '') + (inline ? '&inline=1' : '');
}

function appendMessageEl(m, scrollTo) {
  if (renderedIds.has(m.id)) return;
  renderedIds.add(m.id);
  if (m.id > state.chat.lastId) state.chat.lastId = m.id;

  const flow = $('chatFlow');
  const mine = isMine(m);
  const row = document.createElement('div');
  row.className = `chatrow ${mine ? 'mine' : 'theirs'}`;
  row.id = msgDomId(m.id);

  const col = document.createElement('div');
  col.className = 'msgcol';

  if (!mine) {
    const name = document.createElement('div');
    name.className = 'sender-name';
    name.textContent = m.sender || '';
    col.appendChild(name);
  }

  if (m.type === 'text') {
    const bubble = document.createElement('div');
    bubble.className = mine ? 'chatbubble me' : 'chatbubble other';
    bubble.textContent = m.text || '';
    col.appendChild(bubble);
  } else if (isImageName(m.filename || '')) {
    const card = document.createElement('div');
    card.className = mine ? 'imgcard me-card' : 'imgcard';
    const img = document.createElement('img');
    img.className = 'thumb';
    img.loading = 'lazy';
    img.src = fileUrl(m, true);
    img.alt = m.filename || '';
    img.title = `${m.filename || ''}（${humanBytes(m.size)}）· 点击放大`;
    img.addEventListener('click', () => openLightbox(fileUrl(m), m));
    card.appendChild(img);
    col.appendChild(card);
  } else {
    const card = document.createElement('div');
    card.className = mine ? 'filecard me-card' : 'filecard';

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
    nm.textContent = m.filename || '未命名文件';
    nm.title = m.filename || '';
    const sz = document.createElement('div');
    sz.className = 'hint';
    sz.textContent = humanBytes(m.size);
    info.append(nm, sz);
    card.appendChild(info);

    const a = document.createElement('a');
    a.className = 'btn';
    a.textContent = '下载';
    a.setAttribute('download', m.filename || '');
    a.href = fileUrl(m);
    card.appendChild(a);
    col.appendChild(card);
  }

  row.appendChild(col);
  flow.appendChild(row);
  if (scrollTo !== false) flow.scrollTop = flow.scrollHeight;
}

function clearChat() {
  renderedIds.clear();
  state.chat.lastId = 0;
  $('chatFlow').textContent = '';
}

/* ---------------- 加入 / 退出 ---------------- */

function saveRoomLocal() {
  const c = state.chat;
  if (c.code && c.token) {
    localStorage.setItem('fs_room', JSON.stringify({
      code: c.code, role: c.role, token: c.token,
    }));
  } else {
    localStorage.removeItem('fs_room');
  }
}

function stopPolling() {
  if (state.chat.pollTimer) {
    clearInterval(state.chat.pollTimer);
    state.chat.pollTimer = null;
  }
}

function updateHead() {
  const c = state.chat;
  const joined = c.joined;
  $('codeArea').hidden = !joined;
  $('settingsBtn').hidden = !(joined && c.role === 'owner');
  $('leaveBtn').hidden = !joined;
  $('joinBtn').hidden = joined;
  $('expireCtrl').hidden = joined || !!(c.code === null && c.role === null && false);
  $('memberHint').hidden = !joined;
  if (joined) {
    $('roomCode').textContent = c.code;
    const roleText = c.role === 'owner' ? '楼主' : (c.sender || '访客');
    $('memberHint').textContent = `我：${roleText}`;
    $('roomState').textContent = '';
  } else {
    $('roomState').textContent = '发送第一条消息自动创建会议';
  }
  // 输入区可用性
  const locked = joined && c.role === 'guest' && !c.allowReply;
  $('sendText').disabled = locked;
  $('sendText').placeholder = locked ? '楼主已关闭访客回消息' : '输入消息…';
  $('sendBtn').disabled = locked;
  $('attachBtn').disabled = locked;
}

function applyRoomState(room, member) {
  const c = state.chat;
  if (room) {
    c.code = room.code;
    c.allowReply = !!room.allow_reply;
    c.expireAt = room.expire_at;
  }
  if (member) {
    c.memberId = member.member_id;
    c.role = member.role;
    c.sender = member.sender;
  }
}

async function joinRoom(code, token) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return;
  hideError('sendError');
  try {
    const opts = token ? { headers: { 'X-Room-Token': token } } : {};
    const data = await fetch(`api/room/join/${encodeURIComponent(code)}`, {
      method: 'POST',
      headers: { 'X-Room-Token': token || '' },
    }).then(async (res) => {
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error((j && j.message) || `加入失败（${res.status}）`);
      return j.data;
    });
    void opts;
    state.chat.code = code;
    state.chat.token = data.token;
    applyRoomState(data.room, data.member);
    state.chat.joined = true;
    saveRoomLocal();
    clearChat();
    // 全量拉取
    const full = await apiFetch(`api/room/${encodeURIComponent(code)}/messages?after=0`);
    for (const m of full.messages || []) appendMessageEl(m, false);
    const flow = $('chatFlow');
    flow.scrollTop = flow.scrollHeight;
    updateHead();
    startPolling();
  } catch (e) {
    showError('sendError', e.message);
  }
}

function leaveRoom() {
  stopPolling();
  const c = state.chat;
  c.code = null; c.role = null; c.token = null; c.memberId = null;
  c.sender = null; c.allowReply = true; c.expireAt = 0; c.joined = false;
  saveRoomLocal();
  clearChat();
  updateHead();
  hideError('sendError');
  if (location.hash.startsWith('#/c/')) location.hash = '';
  $('sendText').focus();
}

$('leaveBtn').addEventListener('click', leaveRoom);
$('joinBtn').addEventListener('click', () => {
  const code = prompt('输入会议号加入聊天室：');
  if (code) joinRoom(code);
});

/* ---------------- 轮询 ---------------- */

async function pollOnce() {
  const c = state.chat;
  if (!c.code || !c.token || document.hidden) return;
  try {
    const data = await apiFetch(
      `api/room/${encodeURIComponent(c.code)}/messages?after=${c.lastId}`);
    applyRoomState(data.room, null);
    for (const m of data.messages || []) appendMessageEl(m, true);
    updateHead();
  } catch (e) {
    if (e.status === 404 || e.status === 410 || e.status === 403) {
      leaveRoom();
      showError('sendError', '聊天室已失效：' + e.message);
    }
    // 其他错误静默，下轮重试
  }
}

function startPolling() {
  stopPolling();
  state.chat.pollTimer = setInterval(pollOnce, 2500);
}

/* ---------------- 分片上传（XHR 实时进度） ---------------- */

function fileKey(file) { return `${file.name}:${file.size}:${file.lastModified}`; }

function progressText(msg) {
  const parts = [];
  if (msg.pct != null) parts.push(msg.pct + '%');
  if (msg.speed) parts.push(humanBytes(msg.speed) + '/s');
  return parts.join(' · ');
}

function updateMsgProgress(msg) {
  const row = document.querySelector(`[data-uid="${msg.uid}"]`);
  if (!row) return;
  const bar = row.querySelector('.msg-progress .bar');
  if (bar) bar.style.width = (msg.pct || 0) + '%';
  const txt = row.querySelector('.progress-txt');
  if (txt) txt.textContent = progressText(msg);
}

async function uploadFile(msg, expire, code, token) {
  const file = msg.file;
  let session = null;
  const savedId = localStorage.getItem('fs_up_' + fileKey(file));
  if (savedId) {
    try { session = await apiFetch(`api/upload/${encodeURIComponent(savedId)}/status`); }
    catch (_) { session = null; }
  }
  if (!session) {
    let fileHash = '';
    if (file.size <= 64 * 1024 * 1024) {
      try { fileHash = (await sha256Hex(file)) || ''; } catch (_) { /* ignore */ }
    }
    session = await apiFetch('api/upload/init', {
      json: { file_name: file.name, file_size: file.size, file_hash: fileHash },
    });
  }
  const { upload_id, chunk_size, total_chunks } = session;
  localStorage.setItem('fs_up_' + fileKey(file), upload_id);

  const uploaded = new Set(session.uploaded || []);
  const chunkLen = (i) => Math.min(chunk_size, file.size - i * chunk_size);
  const partBytes = new Array(total_chunks).fill(0);

  function completedBytes() {
    let done = 0;
    for (let i = 0; i < total_chunks; i++) {
      done += uploaded.has(i) ? chunkLen(i) : partBytes[i];
    }
    return done;
  }

  let lastT = Date.now();
  let lastB = completedBytes();
  function sampleSpeed() {
    const now = Date.now();
    const dt = (now - lastT) / 1000;
    const b = completedBytes();
    if (dt >= 0.25) {
      const inst = Math.max(0, (b - lastB) / dt);
      msg.speed = msg.speed ? msg.speed * 0.6 + inst * 0.4 : inst;
      lastT = now;
      lastB = b;
    }
    return b;
  }
  let lastDom = 0;
  function refresh() {
    const b = sampleSpeed();
    const now = performance.now();
    if (now - lastDom < 100) return;
    lastDom = now;
    msg.pct = file.size ? Math.round((b / file.size) * 100) : 100;
    updateMsgProgress(msg);
  }

  function putChunk(i, blob, hash) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `api/upload/${encodeURIComponent(upload_id)}/${i}`);
      if (hash) xhr.setRequestHeader('X-Chunk-Hash', hash);
      xhr.upload.onprogress = (e) => {
        partBytes[i] = e.loaded;
        refresh();
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else {
          let m = `分片上传失败（HTTP ${xhr.status}）`;
          try {
            const j = JSON.parse(xhr.responseText);
            if (j && j.message) m = j.message;
          } catch (_) { /* ignore */ }
          reject(new Error(m));
        }
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.send(blob);
    });
  }

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
          await putChunk(i, blob, hash);
          break;
        } catch (err) {
          attempt++;
          partBytes[i] = 0;
          if (attempt >= 3) { failure = err; return; }
          await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }
      partBytes[i] = 0;
      uploaded.add(i);
      refresh();
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
  if (failure) throw failure;
  msg.pct = 100;
  updateMsgProgress(msg);

  // 3) 合并进聊天室
  const body = {};
  if (code) { body.code = code; body.token = token || ''; }
  else { body.expire_value = expire.value; body.expire_style = expire.style; }
  return apiFetch(`api/upload/${encodeURIComponent(upload_id)}/complete`, { json: body });
}

/* ---------------- 发送 ---------------- */

function autogrow() {
  const el = $('sendText');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}
$('sendText').addEventListener('input', autogrow);

function readExpire() {
  let value = parseInt($('expireValue').value, 10);
  if (!Number.isFinite(value) || value < 1) value = 1;
  if (value > 9999) value = 9999;
  return { value, style: $('expireStyle').value };
}

function setSendingUI(on) {
  state.sending = on;
  $('sendBtn').disabled = on;
  if (on) $('sendBtn').classList.add('busy');
  else $('sendBtn').classList.remove('busy');
}

function addFiles(files) {
  hideError('sendError');
  let added = false;
  for (const f of files) {
    if (f.size === 0) { showError('sendError', `「${f.name}」是空文件，已跳过`); continue; }
    const err = validateFile(f);
    if (err) { showError('sendError', `「${f.name}」${err}，已跳过`); continue; }
    if (state.outbox.some((m) => m.kind === 'file' && fileKey(m.file) === fileKey(f))) continue;
    if (state.outbox.length >= 100) { showError('sendError', '发送队列最多 100 项'); break; }
    const msg = { uid: ++msgSeq, kind: 'file', file: f, status: 'sending' };
    if (isImageName(f.name)) {
      try { msg.thumbUrl = URL.createObjectURL(f); } catch (_) { /* ignore */ }
    }
    state.outbox.push(msg);
    added = true;
  }
  if (added) {
    renderOutbox();
    processOutbox();
  }
}

function renderOutbox() {
  // 发送中的文件显示在消息流底部（本地气泡，服务端确认后由轮询替换为正式消息）
  for (const m of state.outbox) {
    if (document.getElementById('out-' + m.uid)) continue;
    const flow = $('chatFlow');
    const row = document.createElement('div');
    row.className = 'chatrow mine outbox';
    row.id = 'out-' + m.uid;
    row.dataset.uid = m.uid;

    const col = document.createElement('div');
    col.className = 'msgcol';
    let bubble;
    if (isImageName(m.file.name) && m.thumbUrl) {
      bubble = document.createElement('div');
      bubble.className = 'imgcard me-card imgbubble';
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = m.thumbUrl;
      img.alt = m.file.name;
      bubble.appendChild(img);
      const ov = document.createElement('div');
      ov.className = 'img-overlay';
      const txt = document.createElement('span');
      txt.className = 'progress-txt';
      ov.appendChild(txt);
      bubble.appendChild(ov);
      const prog = document.createElement('div');
      prog.className = 'msg-progress';
      const bar = document.createElement('div');
      bar.className = 'bar';
      prog.appendChild(bar);
      bubble.appendChild(prog);
    } else {
      bubble = document.createElement('div');
      bubble.className = 'filecard me-card filebubble-sending';
      const info = document.createElement('div');
      info.className = 'filecard-info';
      const nm = document.createElement('div');
      nm.className = 'filecard-name';
      nm.textContent = m.file.name;
      const sz = document.createElement('div');
      sz.className = 'filebubble-size';
      sz.textContent = humanBytes(m.file.size);
      info.append(nm, sz);
      const prog = document.createElement('div');
      prog.className = 'msg-progress';
      const bar = document.createElement('div');
      bar.className = 'bar';
      prog.appendChild(bar);
      const txt = document.createElement('div');
      txt.className = 'progress-txt';
      info.append(prog, txt);
      bubble.appendChild(info);
    }
    col.appendChild(bubble);
    row.appendChild(col);
    flow.appendChild(row);
    flow.scrollTop = flow.scrollHeight;
  }
}

function removeOutboxEl(uid) {
  const el = document.getElementById('out-' + uid);
  if (el) el.remove();
}

async function processOutbox() {
  if (state.sending) return;
  const c = state.chat;
  setSendingUI(true);
  try {
    // 1) 文字
    const text = $('sendText').value.trim();
    if (text) {
      if (!c.code) {
        const ex = readExpire();
        const r = await apiFetch('api/room/create', {
          json: { text, expire_value: ex.value, expire_style: ex.style },
        });
        c.code = r.room.code;
        c.token = r.token;
        applyRoomState(r.room, r.member);
        c.joined = true;
        saveRoomLocal();
        // 本地立即渲染这条消息
        appendMessageEl(r.message, true);
        updateHead();
        startPolling();
      } else {
        const r = await apiFetch(`api/room/${encodeURIComponent(c.code)}/send/text`, {
          json: { token: c.token, text },
        });
        appendMessageEl(r.message, true);
      }
      $('sendText').value = '';
      autogrow();
    }
    // 2) 文件
    while (state.outbox.length) {
      const m = state.outbox[0];
      const r = await uploadFile(m, readExpire(), c.code, c.token);
      if (!c.code) {
        c.code = r.room.code;
        c.token = r.token;
        applyRoomState(r.room, r.member);
        c.joined = true;
        saveRoomLocal();
        updateHead();
        startPolling();
      }
      removeOutboxEl(m.uid);
      state.outbox.shift();
      // 正式消息由轮询/响应补上
      if (r.message) appendMessageEl(r.message, true);
    }
  } catch (e) {
    showError('sendError', e.message);
    // 失败的文件留在队列，可重试
  }
  setSendingUI(false);
}

$('sendBtn').addEventListener('click', () => processOutbox());
$('sendText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    processOutbox();
  }
});

$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', () => {
  addFiles(Array.from($('fileInput').files || []));
  $('fileInput').value = '';
});

// 拖拽 / 粘贴
const composer = $('composer');
['dragover', 'dragenter'].forEach((ev) =>
  composer.addEventListener(ev, (e) => { e.preventDefault(); composer.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) =>
  composer.addEventListener(ev, (e) => { e.preventDefault(); composer.classList.remove('dragover'); }));
composer.addEventListener('drop', (e) => {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) addFiles(Array.from(files));
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());
document.addEventListener('paste', (e) => {
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) {
    e.preventDefault();
    addFiles(Array.from(files));
  }
});

/* ---------------- 复制 ---------------- */

$('copyCodeBtn').addEventListener('click', async () => {
  (await copyText(state.chat.code || '')) && flashButton($('copyCodeBtn'), '✓');
});
$('copyLinkBtn').addEventListener('click', async () => {
  const code = state.chat.code;
  if (!code) return;
  const link = location.origin + location.pathname.replace(/index\.html$/, '') + '#/c/' + code;
  (await copyText(link)) && flashButton($('copyLinkBtn'), '✓');
});

/* ---------------- 灯箱 ---------------- */

function openLightbox(src, item) {
  let lb = $('lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'lightbox';
    lb.className = 'lightbox';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'lightbox-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => { lb.hidden = true; });
    const img = document.createElement('img');
    img.className = 'lightbox-img';
    const bar = document.createElement('div');
    bar.className = 'lightbox-bar';
    const dl = document.createElement('a');
    dl.className = 'btn';
    dl.textContent = '下载原图';
    dl.setAttribute('download', '');
    bar.appendChild(dl);
    lb.append(closeBtn, img, bar);
    lb.addEventListener('click', (e) => {
      if (e.target === lb) lb.hidden = true;
    });
    document.body.appendChild(lb);
  }
  const img = lb.querySelector('.lightbox-img');
  const dl = lb.querySelector('.lightbox-bar a');
  const view = src.includes('?') ? src + '&inline=1' : src + '?inline=1';
  img.src = view;
  img.alt = (item && item.filename) || '';
  dl.href = src;
  dl.setAttribute('download', (item && item.filename) || '');
  lb.hidden = false;
}

/* ---------------- 楼主设置 ---------------- */

$('settingsBtn').addEventListener('click', () => {
  const c = state.chat;
  $('setAllowReply').checked = c.allowReply;
  // 由 expire_at 反推剩余档位
  if (!c.expireAt) {
    $('setExpireStyle').value = 'forever';
    $('setExpireValue').value = 1;
  } else {
    const remain = c.expireAt - Date.now() / 1000;
    if (remain > 2 * 86400) {
      $('setExpireStyle').value = 'day';
      $('setExpireValue').value = Math.max(1, Math.round(remain / 86400));
    } else {
      $('setExpireStyle').value = 'hour';
      $('setExpireValue').value = Math.max(1, Math.round(remain / 3600));
    }
  }
  updateSetHint();
  $('settingsModal').hidden = false;
});

function updateSetHint() {
  const style = $('setExpireStyle').value;
  $('setExpireValue').hidden = style === 'forever';
  $('setExpireHint').textContent = style === 'forever'
    ? '消息将永久保留（可再修改）'
    : '保存后，聊天室及其全部消息将在该时长后自动删除';
}
$('setExpireStyle').addEventListener('change', updateSetHint);

$('setCloseBtn').addEventListener('click', () => { $('settingsModal').hidden = true; });
$('settingsModal').addEventListener('click', (e) => {
  if (e.target === $('settingsModal')) $('settingsModal').hidden = true;
});

$('setSaveBtn').addEventListener('click', async () => {
  const c = state.chat;
  try {
    const body = {
      allow_reply: $('setAllowReply').checked,
      expire_style: $('setExpireStyle').value,
      expire_value: parseInt($('setExpireValue').value, 10) || 1,
    };
    const room = await apiFetch(`api/room/${encodeURIComponent(c.code)}/settings`, {
      method: 'PUT', json: body,
    });
    applyRoomState(room, null);
    updateHead();
    $('settingsModal').hidden = true;
  } catch (e) {
    showError('sendError', e.message);
    $('settingsModal').hidden = true;
  }
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

async function route() {
  const h = location.hash;
  if (h.startsWith('#/admin')) { showAdmin(); return; }
  showMain();

  const m = h.match(/^#\/c\/([0-9A-Za-z]{1,16})/);
  if (m) {
    const code = m[1].toUpperCase();
    if (state.chat.code !== code) {
      stopPolling();
      state.chat.code = null;
      state.chat.token = null;
      state.chat.joined = false;
      clearChat();
      await joinRoom(code);
    }
    return;
  }
  // 无 hash：恢复上次会话
  if (!state.chat.joined) {
    try {
      const saved = JSON.parse(localStorage.getItem('fs_room') || 'null');
      if (saved && saved.code && saved.token) {
        await joinRoom(saved.code, saved.token);
      }
    } catch (_) { /* ignore */ }
  }
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
      tdType.textContent = `${it.msg_count} 条（文${it.text_count}/件${it.file_count}）`;

      const tdContent = document.createElement('td');
      tdContent.className = 'cell-dim';
      tdContent.textContent = it.preview || '-';
      tdContent.title = it.preview || '';

      const tdSize = document.createElement('td');
      tdSize.textContent = humanBytes(it.total_size);

      const tdMembers = document.createElement('td');
      tdMembers.textContent = `${it.members} 人${it.allow_reply ? '' : ' · 已禁回复'}`;

      const tdExpire = document.createElement('td');
      tdExpire.textContent = it.expire_at ? fmtTime(it.expire_at) : '永久';

      const tdOp = document.createElement('td');
      const delBtn = document.createElement('button');
      delBtn.className = 'iconbtn';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`确定删除会议 ${it.code} 吗？全部消息与文件也会被删除。`)) return;
        try {
          await apiFetch(`api/admin/room/${encodeURIComponent(it.code)}`, { method: 'DELETE' });
          loadList(state.adminPage);
        } catch (e) { alert('删除失败：' + e.message); }
      });
      tdOp.appendChild(delBtn);

      tr.append(tdCode, tdType, tdContent, tdSize, tdMembers, tdExpire, tdOp);
      tbody.appendChild(tr);
    }
    const pages = Math.max(1, Math.ceil(data.total / (data.page_size || 20)));
    $('pageInfo').textContent = `第 ${data.page} / ${pages} 页 · 共 ${data.total} 间`;
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
