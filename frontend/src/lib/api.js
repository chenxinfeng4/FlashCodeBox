import { getAdminToken } from './storage.js';

/**
 * 统一 API 封装：path 必须是相对路径（"api/..."）。
 * 自动携带房间令牌（X-Room-Token）与管理端 Bearer Token。
 */
export async function apiFetch(path, options = {}) {
  const opts = { headers: {}, ...options };
  const adminToken = getAdminToken();
  if (adminToken) opts.headers['Authorization'] = 'Bearer ' + adminToken;
  if (opts.json !== undefined) {
    opts.method = opts.method || 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.json);
    delete opts.json;
  }
  const res = await fetch(path, opts);
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    /* 非 JSON */
  }
  if (!res.ok) {
    const err = new Error((body && body.message) || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return body ? body.data : null;
}

/** 房间令牌版 fetch（房间端点优先用 X-Room-Token；管理端点则用 Bearer） */
export async function roomFetch(path, roomToken, options = {}) {
  const opts = { headers: { ...(roomToken ? { 'X-Room-Token': roomToken } : {}) }, ...options };
  if (opts.json !== undefined) {
    opts.method = opts.method || 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.json);
    delete opts.json;
  }
  const res = await fetch(path, opts);
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    /* ignore */
  }
  if (!res.ok) {
    const err = new Error((body && body.message) || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return body ? body.data : null;
}

export function humanBytes(n) {
  if (n == null || isNaN(n)) return '-';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
}

export function fmtTime(unix) {
  if (!unix) return '';
  return new Date(unix * 1000).toLocaleString('zh-CN', { hour12: false });
}

export function expireText(expireAt) {
  if (!expireAt) return '永久有效';
  return `${fmtTime(expireAt)} 前有效`;
}

export async function copyText(text) {
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
    try {
      ok = document.execCommand('copy');
    } catch (_) {
      /* ignore */
    }
    ta.remove();
    return ok;
  }
}

export async function sha256Hex(blob) {
  if (!(window.crypto && crypto.subtle)) return null; // http 部署时不可用，自动降级
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif'];

export function isImageName(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 && IMG_EXT.includes(name.slice(i + 1).toLowerCase());
}

export function fileKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function typesAllowed(name, config) {
  const list = (config && config.allowed_types) || ['*'];
  if (list.includes('*')) return true;
  const i = name.lastIndexOf('.');
  if (i < 0) return false;
  return list.includes(name.slice(i + 1).toLowerCase());
}

export function validateFile(file, config) {
  if (config && file.size > config.max_upload_size) {
    return `超过大小限制（最大 ${humanBytes(config.max_upload_size)}）`;
  }
  if (config && !typesAllowed(file.name, config)) return '类型不被允许';
  return null;
}
