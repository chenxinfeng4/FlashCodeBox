import { apiFetch, roomFetch, sha256Hex, fileKey, errMsg } from './api.js';
import { getUploadId, setUploadId, clearUploadId } from './storage.js';
import type { ChunkSessionInfo, SendResult, UploadOptions } from '../types.js';

/**
 * 分片上传一个文件：
 *   - init/resume（sessionStorage 断点）
 *   - 并发 3 个 XHR 分片（upload.onprogress 字节级进度）
 *   - 失败退避重试，EMA 平滑网速
 *   - complete({code?, token?, expire_*}) → 落入群（或建群）
 */
export async function uploadFile(file: File, opts: UploadOptions): Promise<SendResult> {
  const { expire, code, token, onProgress } = opts;

  // 1) 初始化或续传
  let session: ChunkSessionInfo | null = null;
  const savedId = getUploadId(fileKey(file));
  if (savedId) {
    try {
      session = await roomFetch<ChunkSessionInfo>(`api/upload/${encodeURIComponent(savedId)}/status`, token || '');
    } catch (_) {
      session = null;
    }
  }
  if (!session) {
    let fileHash = '';
    if (file.size <= 64 * 1024 * 1024) {
      try {
        fileHash = (await sha256Hex(file)) || '';
      } catch (_) {
        /* ignore */
      }
    }
    session = await apiFetch<ChunkSessionInfo>('api/upload/init', {
      json: { file_name: file.name, file_size: file.size, file_hash: fileHash },
    });
  }
  const { upload_id, chunk_size, total_chunks } = session;
  setUploadId(fileKey(file), upload_id);

  // 2) 并发上传分片
  const uploaded = new Set<number>(session.uploaded || []);
  const chunkLen = (i: number) => Math.min(chunk_size, file.size - i * chunk_size);
  const partBytes = new Array<number>(total_chunks).fill(0);

  function completedBytes(): number {
    let done = 0;
    for (let i = 0; i < total_chunks; i++) {
      done += uploaded.has(i) ? chunkLen(i) : partBytes[i];
    }
    return done;
  }

  let lastT = Date.now();
  let lastB = completedBytes();
  let speed = 0;
  function sampleSpeed(): number {
    const now = Date.now();
    const dt = (now - lastT) / 1000;
    const b = completedBytes();
    if (dt >= 0.25) {
      const inst = Math.max(0, (b - lastB) / dt);
      speed = speed ? speed * 0.6 + inst * 0.4 : inst;
      lastT = now;
      lastB = b;
    }
    return b;
  }

  let lastDom = 0;
  function refresh(): void {
    const b = sampleSpeed();
    const now = performance.now();
    if (now - lastDom < 100) return;
    lastDom = now;
    const pct = file.size ? Math.round((b / file.size) * 100) : 100;
    if (onProgress) onProgress(pct, speed);
  }

  function putChunk(i: number, blob: Blob, hash: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `api/upload/${encodeURIComponent(upload_id)}/${i}`);
      if (hash) xhr.setRequestHeader('X-Chunk-Hash', hash);
      xhr.upload.onprogress = (e) => {
        partBytes[i] = e.loaded;
        refresh();
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          let m = `分片上传失败（HTTP ${xhr.status}）`;
          try {
            const j = JSON.parse(xhr.responseText) as { message?: string };
            if (j && j.message) m = j.message;
          } catch (_) {
            /* ignore */
          }
          reject(new Error(m));
        }
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.send(blob);
    });
  }

  let next = 0;
  let failure: Error | null = null;
  const WORKERS = 3;

  async function worker(): Promise<void> {
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
          await putChunk(i, blob, hash || '');
          break;
        } catch (err) {
          attempt++;
          partBytes[i] = 0;
          if (attempt >= 3) {
            failure = err instanceof Error ? err : new Error(errMsg(err));
            return;
          }
          await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }
      partBytes[i] = 0;
      uploaded.add(i);
      refresh();
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, () => worker()));
  if (failure) throw failure;
  if (onProgress) onProgress(100, speed);

  // 3) 合并进群
  const body: Record<string, unknown> = {};
  if (code) {
    body.code = code;
    body.token = token || '';
  } else {
    body.expire_value = expire.value;
    body.expire_style = expire.style;
  }
  const result = await apiFetch<SendResult>(`api/upload/${encodeURIComponent(upload_id)}/complete`, {
    json: body,
  });
  clearUploadId(fileKey(file));
  return result;
}
