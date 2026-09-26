// Web Worker：在后台线程计算 sha256，避免大文件/分片哈希阻塞 UI。
// 注意：非安全上下文（http 局域网）没有 crypto.subtle，返回 null，
// 与主线程的降级行为保持一致（调用方自动跳过哈希头）。

interface HashWorkerCtx {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: { id: number; hex?: string | null; error?: string }): void;
}

const ctx = self as unknown as HashWorkerCtx;

ctx.onmessage = async (e: MessageEvent) => {
  const { id, blob } = (e.data || {}) as { id: number; blob: Blob };
  try {
    if (!(self.crypto && crypto.subtle)) {
      ctx.postMessage({ id, hex: null });
      return;
    }
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    ctx.postMessage({ id, hex });
  } catch (err) {
    ctx.postMessage({ id, error: String((err instanceof Error && err.message) || err) });
  }
};
