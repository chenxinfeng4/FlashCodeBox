import { getAdminToken } from './storage.js';

/**
 * 统一 API 封装：path 必须是相对路径（"api/..."）。
 * 自动携带房间令牌（X-Room-Token）与管理端 Bearer Token。
 * 响应统一 {code, message, data}；非 2xx 抛出带 status 的 Error。
 */

export type HttpError = Error & { status: number };

export function httpError(message: string, status: number): HttpError {
  const err = new Error(message) as HttpError;
  err.status = status;
  return err;
}

/** 从 unknown catch 里安全取错误文案 */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface FetchOptions {
  method?: string;
  json?: unknown;
  headers?: Record<string, string>;
}

export async function apiFetch<T = unknown>(path: string, options: FetchOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers || {}) };
  const adminToken = getAdminToken();
  if (adminToken) headers['Authorization'] = 'Bearer ' + adminToken;
  let body: string | undefined;
  let method = options.method;
  if (options.json !== undefined) {
    method = method || 'POST';
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  }
  const res = await fetch(path, { method, headers, body });
  let parsed: { code?: number; message?: string; data?: T } | null = null;
  try {
    parsed = await res.json();
  } catch (_) {
    /* 非 JSON */
  }
  if (!res.ok) {
    throw httpError((parsed && parsed.message) || `请求失败（HTTP ${res.status}）`, res.status);
  }
  return (parsed ? parsed.data : null) as T;
}

/** 房间令牌版 fetch（房间端点优先用 X-Room-Token；管理端点则用 Bearer） */
export async function roomFetch<T = unknown>(
  path: string,
  roomToken: string | null | undefined,
  options: FetchOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...(roomToken ? { 'X-Room-Token': roomToken } : {}),
    ...(options.headers || {}),
  };
  let body: string | undefined;
  let method = options.method;
  if (options.json !== undefined) {
    method = method || 'POST';
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  }
  const res = await fetch(path, { method, headers, body });
  let parsed: { code?: number; message?: string; data?: T } | null = null;
  try {
    parsed = await res.json();
  } catch (_) {
    /* ignore */
  }
  if (!res.ok) {
    throw httpError((parsed && parsed.message) || `请求失败（HTTP ${res.status}）`, res.status);
  }
  return (parsed ? parsed.data : null) as T;
}

export function humanBytes(n: number | null | undefined): string {
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

export function fmtTime(unix: number | null | undefined): string {
  if (!unix) return '';
  return new Date(unix * 1000).toLocaleString('zh-CN', { hour12: false });
}

export function expireText(expireAt: number | null | undefined): string {
  if (!expireAt) return '永久有效';
  return `${fmtTime(expireAt)} 前有效`;
}

/** 距解散的精简倒计时：>12h 显示 x天，≥1h 显示 x小时，<1h 显示 x分钟 */
export function expireCountdown(expireAt: number, nowSec: number): string {
  const s = (expireAt || 0) - nowSec;
  if (s <= 0) return '0分钟';
  if (s > 12 * 3600) return `${Math.ceil(s / 86400)}天`;
  if (s >= 3600) return `${Math.ceil(s / 3600)}小时`;
  return `${Math.max(1, Math.ceil(s / 60))}分钟`;
}

export async function copyText(text: string): Promise<boolean> {
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

// sha256 走 Web Worker（后台线程），避免大 blob 哈希阻塞 UI；
// Worker 不可用时回退主线程，http 局域网（无 crypto.subtle）返回 null。
let hashWorker: Worker | null = null;
let hashSeq = 0;
const hashPending = new Map<number, { resolve: (hex: string | null) => void; reject: (e: Error) => void }>();

function getHashWorker(): Worker | null {
  if (hashWorker !== null) return hashWorker;
  if (typeof Worker === 'undefined') return null;
  try {
    const w = new Worker(new URL('./hashWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent) => {
      const { id, hex, error } = (e.data || {}) as { id?: number; hex?: string | null; error?: string };
      if (id == null) return;
      const p = hashPending.get(id);
      if (!p) return;
      hashPending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(hex ?? null);
    };
    w.onerror = () => {
      // worker 崩溃：丢弃未决请求（调用方按哈希失败处理），后续回退主线程
      for (const [, p] of hashPending) p.reject(new Error('hash worker crashed'));
      hashPending.clear();
      try { w.terminate(); } catch (_) { /* ignore */ }
      hashWorker = null;
    };
    hashWorker = w;
  } catch (_) {
    hashWorker = null;
  }
  return hashWorker;
}

export async function sha256Hex(blob: Blob): Promise<string | null> {
  if (!(window.crypto && crypto.subtle)) return null; // http 部署时不可用，自动降级
  const worker = getHashWorker();
  if (worker) {
    const id = ++hashSeq;
    return new Promise<string | null>((resolve, reject) => {
      hashPending.set(id, { resolve, reject });
      worker.postMessage({ id, blob });
    });
  }
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif'];

export function isImageName(name: string): boolean {
  const i = name.lastIndexOf('.');
  return i >= 0 && IMG_EXT.includes(name.slice(i + 1).toLowerCase());
}

export function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function typesAllowed(name: string, config: { allowed_types?: string[] } | null | undefined): boolean {
  const list = (config && config.allowed_types) || ['*'];
  if (list.includes('*')) return true;
  const i = name.lastIndexOf('.');
  if (i < 0) return false;
  return list.includes(name.slice(i + 1).toLowerCase());
}

export function validateFile(
  file: File,
  config: { max_upload_size?: number; allowed_types?: string[] } | null | undefined,
): string | null {
  if (config && config.max_upload_size != null && file.size > config.max_upload_size) {
    return `超过大小限制（最大 ${humanBytes(config.max_upload_size)}）`;
  }
  if (config && !typesAllowed(file.name, config)) return '类型不被允许';
  return null;
}
