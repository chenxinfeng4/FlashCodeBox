import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, roomFetch, humanBytes, isImageName, fileKey, validateFile, copyText, expireCountdown, errMsg } from '../lib/api';
import { saveRoomSession, getRoomSession } from '../lib/storage';
import { uploadFile } from '../lib/uploader';
import MessageRow, { fileUrl } from './MessageRow';
import FileIcon from './FileIcon';
import SettingsModal from './SettingsModal';
import Lightbox from './Lightbox';
import type { ChatState, MessageView, OutboxItem, SendResult, MessagesResult, SettingsBody, SiteConfig } from '../types';

let outboxSeq = 0;

// 每 intervalMs 跳动一次的当前秒级时间戳（驱动解散倒计时刷新）
function useNow(active: boolean, intervalMs: number): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
}

const EMPTY_CHAT: ChatState = {
  code: null, role: null, token: null, memberId: null,
  sender: null, allowReply: true, expireAt: 0, joined: false,
};

export default function ChatPage({ config }: { config: SiteConfig | null }) {
  const [chat, setChat] = useState<ChatState>(EMPTY_CHAT);
  const [messages, setMessages] = useState<MessageView[]>([]);
  // 发送队列：outboxRef 是唯一真源（避免 setState 异步导致队列读旧值），
  // outboxView 仅用于渲染。
  const outboxRef = useRef<OutboxItem[]>([]);
  const [outbox, setOutboxView] = useState<OutboxItem[]>([]);
  const syncOutbox = () => setOutboxView([...outboxRef.current]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lightbox, setLightbox] = useState<MessageView | null>(null);

  const chatRef = useRef<ChatState>(chat);
  chatRef.current = chat;
  const lastIdRef = useRef(0);
  const flowRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const connRef = useRef<(() => void) | null>(null);

  const showError = (msg: string) => setError(msg);
  const hideError = () => setError('');

  function scrollToBottom() {
    const el = flowRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  function mergeMessages(list: MessageView[] | null | undefined) {
    if (!list || !list.length) return;
    setMessages((prev) => {
      const map = new Map(prev.map((m) => [m.id, m]));
      for (const m of list) {
        map.set(m.id, m);
        if (m.id > lastIdRef.current) lastIdRef.current = m.id;
      }
      return [...map.values()].sort((a, b) => a.id - b.id);
    });
  }

  function applyRoom(room: { code: string; allow_reply: boolean; expire_at: number } | null,
    member: { member_id: number; role: 'owner' | 'guest'; sender: string } | null) {
    setChat((c) => ({
      ...c,
      code: room ? room.code : c.code,
      allowReply: room ? !!room.allow_reply : c.allowReply,
      expireAt: room ? room.expire_at : c.expireAt,
      ...(member ? { memberId: member.member_id, role: member.role, sender: member.sender } : {}),
    }));
  }

  // ---------------- 加入 / 退出 ----------------

  const joinRoom = useCallback(async (code: string | null | undefined, token?: string | null) => {
    code = String(code || '').trim().toUpperCase();
    if (!code) return;
    // 断开旧群的实时连接，避免旧群事件串进新群
    if (connRef.current) { connRef.current(); connRef.current = null; }
    hideError();
    try {
      const data = await roomFetch<SendResult>(`api/room/join/${encodeURIComponent(code)}`, token || '', { method: 'POST' });
      lastIdRef.current = 0;
      setMessages([]);
      const member = data.member;
      setChat((prev) => ({
        ...prev,
        code, token: data.token || null, joined: true,
        ...(member ? { memberId: member.member_id, role: member.role, sender: member.sender } : {}),
      }));
      applyRoom(data.room, member || null);
      if (member) saveRoomSession({ code, role: member.role, token: data.token || '' });
      const full = await roomFetch<MessagesResult>(`api/room/${encodeURIComponent(code)}/messages?after=0`, data.token);
      applyRoom(full.room, full.you);
      mergeMessages(full.messages || []);
      setChat((prev) => ({ ...prev, joined: true }));
    } catch (e) {
      showError(errMsg(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const leaveRoom = useCallback(() => {
    if (connRef.current) { connRef.current(); connRef.current = null; }
    lastIdRef.current = 0;
    setMessages([]);
    outboxRef.current = [];
    syncOutbox();
    setChat(EMPTY_CHAT);
    saveRoomSession(null);
    hideError();
    if (location.hash.startsWith('#/c/')) location.hash = '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 群主解散群：删除全部消息与文件，所有成员（含自己）被移出
  const dissolveRoom = useCallback(async () => {
    const c = chatRef.current;
    if (!c.code || !c.token || c.role !== 'owner') return;
    if (!confirm(`确定解散群 ${c.code} 吗？\n全部消息与文件将被删除，所有成员将被移出。`)) return;
    try {
      await roomFetch(`api/room/${encodeURIComponent(c.code)}`, c.token, { method: 'DELETE' });
      leaveRoom();
    } catch (e) {
      showError('解散失败：' + errMsg(e));
    }
  }, [leaveRoom, showError]);

  // ---------------- 实时（SSE）+ 轮询兜底 ----------------

  useEffect(() => {
    if (!chat.joined || !chat.code || !chat.token) return undefined;
    let torn = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    async function pollOnce() {
      const c = chatRef.current;
      if (!c.code || !c.token || document.hidden) return;
      try {
        const data = await roomFetch<MessagesResult>(
          `api/room/${encodeURIComponent(c.code)}/messages?after=${lastIdRef.current}`,
          c.token,
        );
        applyRoom(data.room, null);
        mergeMessages(data.messages || []);
      } catch (e) {
        const status = (e as { status?: number }).status;
        if ([403, 404, 410].includes(status as number)) {
          teardown();
          leaveRoom();
          showError('群聊已失效：' + errMsg(e));
        }
        // 其他错误静默，下轮重试
      }
    }

    function startPolling() {
      if (pollTimer || torn) return;
      pollTimer = setInterval(pollOnce, 2500);
      pollOnce();
    }

    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function onVisible() {
      if (!document.hidden) pollOnce(); // 后台期间可能错过事件，回前台补拉
    }

    function teardown() {
      torn = true;
      if (es) { es.close(); es = null; }
      stopPolling();
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      document.removeEventListener('visibilitychange', onVisible);
    }

    function startSSE() {
      if (torn) return;
      const c = chatRef.current;
      if (!c.code || !c.token) return;
      const source = new EventSource(
        `api/room/${encodeURIComponent(c.code)}/events?token=${encodeURIComponent(c.token)}`,
      );
      es = source;
      source.addEventListener('message', (e) => {
        try { mergeMessages([JSON.parse((e as MessageEvent).data) as MessageView]); } catch (_) { /* ignore */ }
      });
      source.addEventListener('room', (e) => {
        try {
          applyRoom(JSON.parse((e as MessageEvent).data) as Parameters<typeof applyRoom>[0], null);
        } catch (_) { /* ignore */ }
      });
      source.addEventListener('members', (e) => {
        try {
          const d = JSON.parse((e as MessageEvent).data) as { count: number };
          setChat((prev) => ({ ...prev, members: d.count }));
        } catch (_) { /* ignore */ }
      });
      source.addEventListener('gone', () => {
        teardown();
        leaveRoom();
        showError('群聊已解散');
      });
      source.onerror = () => {
        // SSE 不可用（旧后端/严格反代/网络抖动）：降级轮询，稍后重试 SSE
        if (es) { es.close(); es = null; }
        if (torn) return;
        startPolling();
        if (!retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            stopPolling();
            startSSE();
          }, 30000);
        }
      };
    }

    document.addEventListener('visibilitychange', onVisible);
    startSSE();
    connRef.current = teardown;
    return () => {
      teardown();
      if (connRef.current === teardown) connRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.joined, chat.code, chat.token]);

  // ---------------- 路由 / 会话恢复 ----------------

  useEffect(() => {
    async function route() {
      const m = location.hash.match(/^#\/c\/([0-9A-Za-z]{1,16})/);
      if (m) {
        const code = m[1].toUpperCase();
        if (chatRef.current.code !== code) {
          if (connRef.current) { connRef.current(); connRef.current = null; }
          await joinRoom(code);
        }
        return;
      }
      const saved = getRoomSession();
      if (saved && saved.code && saved.token) {
        await joinRoom(saved.code, saved.token);
      }
    }
    route();
    window.addEventListener('hashchange', route);
    return () => window.removeEventListener('hashchange', route);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------- 发送 ----------------

  // 建群有效期：控件已移除，固定默认 1 天（群主可在设置弹层修改）
  function readExpire(): { value: number; style: 'hour' | 'day' | 'forever' } {
    return { value: 1, style: 'day' };
  }

  const processOutbox = useCallback(async () => {
    const c = chatRef.current;
    if (c.joined && c.role === 'guest' && !c.allowReply) return;
    setSending(true);
    try {
      // 1) 文字
      const t = text.trim();
      if (t) {
        if (!c.code) {
          const ex = readExpire();
          const r = await apiFetch<SendResult>('api/room/create', {
            json: { text: t, expire_value: ex.value, expire_style: ex.style },
          });
          const member = r.member;
          setChat((prev) => ({
            ...prev,
            code: r.room.code, token: r.token || null, joined: true,
            memberId: member ? member.member_id : null,
            role: member ? member.role : 'owner',
            sender: member ? member.sender : null,
          }));
          applyRoom(r.room, null);
          if (member) saveRoomSession({ code: r.room.code, role: member.role, token: r.token || '' });
          mergeMessages([r.message]);
        } else {
          const r = await roomFetch<SendResult>(`api/room/${encodeURIComponent(c.code)}/send/text`, c.token, {
            json: { token: c.token, text: t },
          });
          mergeMessages([r.message]);
        }
        setText('');
        if (textRef.current) textRef.current.style.height = 'auto';
      }

      // 2) 文件（串行，逐个分片上传；outboxRef 为真源）
      for (;;) {
        const item = outboxRef.current.find((o) => o.status === 'sending');
        if (!item) break;
        try {
          const cc = chatRef.current;
          const r = await uploadFile(item.file, {
            expire: readExpire(),
            code: cc.code,
            token: cc.token,
            onProgress: (pct, speed) => {
              item.pct = pct;
              item.speed = speed;
              syncOutbox();
            },
          });
          if (!cc.code) {
            const member = r.member;
            setChat((prev) => ({
              ...prev,
              code: r.room.code, token: r.token || null, joined: true,
              memberId: member ? member.member_id : null,
              role: member ? member.role : 'owner',
              sender: member ? member.sender : null,
            }));
            applyRoom(r.room, null);
            if (member) saveRoomSession({ code: r.room.code, role: member.role, token: r.token || '' });
          }
          outboxRef.current = outboxRef.current.filter((o) => o.uid !== item.uid);
          syncOutbox();
          mergeMessages([r.message]);
        } catch (e) {
          item.status = 'failed';
          item.err = errMsg(e);
          syncOutbox();
          showError(errMsg(e) + '（点击气泡上的 ⚠ 可重试）');
          break; // 失败即停，保留队列
        }
      }
    } catch (e) {
      showError(errMsg(e));
    }
    setSending(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  function doSend() {
    if (!text.trim()) return;
    processOutbox();
  }

  function addFiles(files: File[]) {
    hideError();
    let added = false;
    for (const f of files) {
      if (f.size === 0) {
        showError(`「${f.name}」是空文件，已跳过`);
        continue;
      }
      const err = validateFile(f, config);
      if (err) {
        showError(`「${f.name}」${err}，已跳过`);
        continue;
      }
      if (outboxRef.current.some((o) => fileKey(o.file) === fileKey(f))) continue;
      if (outboxRef.current.length + 1 > 100) {
        showError('发送队列最多 100 项');
        break;
      }
      const item: OutboxItem = { uid: ++outboxSeq, file: f, status: 'sending', pct: 0, speed: 0 };
      if (isImageName(f.name)) {
        try {
          item.thumbUrl = URL.createObjectURL(f);
        } catch (_) {
          /* ignore */
        }
      }
      outboxRef.current = [...outboxRef.current, item];
      added = true;
    }
    if (added) {
      syncOutbox();
      processOutbox();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }

  // 全局粘贴文件
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length) {
        e.preventDefault();
        addFiles(Array.from(files));
      }
    }
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, outbox]);

  // 消息变化 → 滚动到底
  useEffect(() => {
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, outbox]);

  // ---------------- 渲染 ----------------

  const { code, role, token, sender, allowReply, expireAt, joined } = chat;
  const locked = joined && role === 'guest' && !allowReply;
  const nowSec = useNow(joined && expireAt > 0, 30000);

  return (
    <section className="card chat" id="chatPanel" aria-label="群聊">
      <div className="chat-head">
        {joined && expireAt > 0 && (
          <span className="expire-badge" title="到期自动解散">
            剩余{expireCountdown(expireAt, nowSec)}
          </span>
        )}
        <div className="chat-head-spacer" />
        <div className="chat-code-area" id="codeArea" hidden={!joined}>
          <span className="chat-code-label">群号</span>
          <span className="chat-code" id="roomCode">{code || '—'}</span>
          <button
            className="iconbtn" id="copyCodeBtn" type="button" title="复制群号" aria-label="复制群号"
            onClick={async (e) => {
              // 注意：navigator.clipboard 仅在 https/localhost 存在，
              // 局域网 http 场景必须走 copyText 的 execCommand 降级
              const okC = await copyText(code || '');
              (e.currentTarget as HTMLElement).textContent = okC ? '✓' : '✕';
              setTimeout(() => { (e.currentTarget as HTMLElement).textContent = ''; }, 1200);
            }}
          >
            <svg viewBox="0 0 24 24" width="15" height="15"><rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" fill="none" /><path d="M5 15V5a2 2 0 012-2h10" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" /></svg>
          </button>
          <button
            className="iconbtn" id="copyLinkBtn" type="button" title="复制邀请链接" aria-label="复制邀请链接"
            onClick={async (e) => {
              const link = location.origin + location.pathname.replace(/index\.html$/, '') + '#/c/' + code;
              const okC = await copyText(link);
              (e.currentTarget as HTMLElement).textContent = okC ? '✓' : '✕';
              setTimeout(() => { (e.currentTarget as HTMLElement).textContent = ''; }, 1200);
            }}
          >
            <svg viewBox="0 0 24 24" width="15" height="15"><path d="M10 14a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" /><path d="M14 10a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" /></svg>
          </button>
        </div>
        <span className="hint" id="memberHint" hidden={!joined}>
          我：{role === 'owner' ? '群主' : (sender || '访客')}
        </span>
        <button
          className="iconbtn" id="settingsBtn" type="button" title="群设置" aria-label="群设置"
          hidden={!(joined && role === 'owner')}
          onClick={() => setSettingsOpen(true)}
        >
          <svg viewBox="0 0 24 24" width="17" height="17"><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" fill="none" /><path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1 1.55V21a2 2 0 11-4 0v-.09a1.7 1.7 0 00-1-1.55 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.7 1.7 0 00.34-1.87 1.7 1.7 0 00-1.55-1H3a2 2 0 110-4h.09a1.7 1.7 0 001.55-1 1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06a1.7 1.7 0 001.87.34h0a1.7 1.7 0 001-1.55V3a2 2 0 114 0v.09a1.7 1.7 0 001 1.55h0a1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06a1.7 1.7 0 00-.34 1.87v0a1.7 1.7 0 001.55 1H21a2 2 0 110 4h-.09a1.7 1.7 0 00-1.55 1z" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button
          className="iconbtn danger" id="dissolveBtn" type="button"
          title="解散群聊（删除全部消息与文件）" aria-label="解散群聊"
          hidden={!(joined && role === 'owner')}
          onClick={dissolveRoom}
        >
          <svg viewBox="0 0 24 24" width="17" height="17"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M10 11v6M14 11v6" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button className="iconbtn" id="leaveBtn" type="button" title="退出群聊" aria-label="退出群聊" hidden={!joined} onClick={leaveRoom}>
          <svg viewBox="0 0 24 24" width="17" height="17"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>

      <div className="join-panel" id="joinPanel" hidden={joined}>
        <div className="join-title">加入群聊</div>
        <div className="join-form">
          <input
            id="joinCode"
            className="code-input"
            placeholder="群号"
            maxLength={5}
            autoComplete="off"
            spellCheck={false}
            inputMode="numeric"
          />
          <button
            className="btn primary" id="joinSubmitBtn" type="button"
            onClick={() => joinRoom((document.getElementById('joinCode') as HTMLInputElement).value)}
          >
            加 入
          </button>
        </div>
        <div className="hint">没有群号？在下方输入框发送第一条消息即可建群</div>
      </div>

      <div className="chat-flow" id="chatFlow" ref={flowRef}>
        {messages.map((m) => (
          <MessageRow
            key={m.id}
            m={m}
            mine={m.member_id === chat.memberId}
            token={token}
            onImageClick={(item) => setLightbox(item)}
          />
        ))}
        {outbox.map((o) => (
          <div className="chatrow mine outbox" key={o.uid} id={`out-${o.uid}`} data-uid={o.uid}>
            <div className="msgcol">
              {isImageName(o.file.name) && o.thumbUrl ? (
                <div className="imgcard me-card imgbubble">
                  <img className="thumb" src={o.thumbUrl} alt={o.file.name} />
                  <div className="img-overlay">
                    <span className="progress-txt">
                      {[o.pct != null ? o.pct + '%' : '', o.speed ? humanBytes(o.speed) + '/s' : ''].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  <div className="msg-progress"><div className="bar" style={{ width: (o.pct || 0) + '%' }} /></div>
                </div>
              ) : (
                <div className="filecard me-card filebubble-sending">
                  <div className="filecard-body">
                    <div className="filecard-info">
                      <div className="filecard-name" title={o.file.name}>{o.file.name}</div>
                      <div className="filecard-size">{humanBytes(o.file.size)}</div>
                      <div className="msg-progress"><div className="bar" style={{ width: (o.pct || 0) + '%' }} /></div>
                      <div className="progress-txt">
                        {[o.pct != null ? o.pct + '%' : '', o.speed ? humanBytes(o.speed) + '/s' : ''].filter(Boolean).join(' · ')}
                        {o.status === 'failed' ? ' · 失败' : ''}
                      </div>
                    </div>
                    <FileIcon name={o.file.name} />
                  </div>
                  {o.status === 'failed' && (
                    <button
                      className="iconbtn" title={(o.err || '发送失败') + '，点击重试'}
                      onClick={() => {
                        o.status = 'sending';
                        syncOutbox();
                        processOutbox();
                      }}
                    >⚠</button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div
        className="composer"
        id="composer"
        onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('dragover'); }}
        onDragLeave={(e) => { e.preventDefault(); e.currentTarget.classList.remove('dragover'); }}
        onDrop={(e) => {
          e.preventDefault();
          e.currentTarget.classList.remove('dragover');
          const files = e.dataTransfer && e.dataTransfer.files;
          if (files && files.length) addFiles(Array.from(files));
        }}
      >
        <textarea
          id="sendText"
          ref={textRef}
          rows={1}
          placeholder={locked ? '群主已关闭访客回消息' : '输入消息…'}
          disabled={locked}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const el = e.target;
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 160) + 'px';
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              doSend();
            }
          }}
        />
        <div className="composer-bar">
          <button
            className="attachbtn" id="attachBtn" type="button" title="添加文件（可多选）" aria-label="添加文件"
            disabled={locked}
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
          >
            <svg viewBox="0 0 24 24" width="20" height="20"><path d="M21 12.5l-8.5 8.5a5.5 5.5 0 01-7.8-7.8l8.9-8.9a3.7 3.7 0 015.2 5.2l-8.9 8.9a1.8 1.8 0 01-2.6-2.6l8.2-8.2" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <input
            type="file" id="fileInput" multiple hidden ref={fileInputRef}
            onChange={(e) => {
              addFiles(Array.from(e.target.files || []));
              e.target.value = '';
            }}
          />
          <div className="spacer" />
          <button className="sendbtn" id="sendBtn" type="button" title="发送" aria-label="发送" disabled={locked || sending} onClick={doSend}>
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </div>

      <div className="alert err" id="sendError" hidden={!error}>{error}</div>

      <SettingsModal
        open={settingsOpen}
        room={{ allow_reply: allowReply, expire_at: expireAt }}
        onClose={() => setSettingsOpen(false)}
        onSave={async (body: SettingsBody) => {
          try {
            const room = await roomFetch(`api/room/${encodeURIComponent(code || '')}/settings`, token, {
              method: 'PUT', json: body,
            });
            applyRoom(room as Parameters<typeof applyRoom>[0], null);
            setSettingsOpen(false);
          } catch (e) {
            showError(errMsg(e));
            setSettingsOpen(false);
          }
        }}
      />

      {lightbox && (
        <Lightbox src={fileUrl(lightbox, token)} item={lightbox} onClose={() => setLightbox(null)} />
      )}
    </section>
  );
}
