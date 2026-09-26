import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, roomFetch, humanBytes, isImageName, fileKey, validateFile } from '../lib/api.js';
import { saveRoomSession, getRoomSession } from '../lib/storage.js';
import { uploadFile } from '../lib/uploader.js';
import MessageRow, { fileUrl } from './MessageRow.jsx';
import FileIcon from './FileIcon.jsx';
import SettingsModal from './SettingsModal.jsx';
import Lightbox from './Lightbox.jsx';

let outboxSeq = 0;

export default function ChatPage({ config }) {
  const [chat, setChat] = useState({
    code: null, role: null, token: null, memberId: null,
    sender: null, allowReply: true, expireAt: 0, joined: false,
  });
  const [messages, setMessages] = useState([]);
  // 发送队列：outboxRef 是唯一真源（避免 setState 异步导致队列读旧值），
  // outboxView 仅用于渲染。
  const outboxRef = useRef([]);
  const [outbox, setOutboxView] = useState([]);
  const syncOutbox = () => setOutboxView([...outboxRef.current]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lightbox, setLightbox] = useState(null);

  const chatRef = useRef(chat);
  chatRef.current = chat;
  const lastIdRef = useRef(0);
  const flowRef = useRef(null);
  const textRef = useRef(null);
  const fileInputRef = useRef(null);
  const pollRef = useRef(null);

  const showError = (msg) => setError(msg);
  const hideError = () => setError('');

  function scrollToBottom() {
    const el = flowRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  function mergeMessages(list) {
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

  function applyRoom(room, member) {
    setChat((c) => ({
      ...c,
      code: room ? room.code : c.code,
      allowReply: room ? !!room.allow_reply : c.allowReply,
      expireAt: room ? room.expire_at : c.expireAt,
      ...(member ? { memberId: member.member_id, role: member.role, sender: member.sender } : {}),
    }));
  }

  // ---------------- 加入 / 退出 ----------------

  const joinRoom = useCallback(async (code, token) => {
    code = String(code || '').trim().toUpperCase();
    if (!code) return;
    hideError();
    try {
      const data = await roomFetch(`api/room/join/${encodeURIComponent(code)}`, token || '', { method: 'POST' });
      lastIdRef.current = 0;
      setMessages([]);
      const c = {
        code, token: data.token, joined: true,
        ...(data.member ? { memberId: data.member.member_id, role: data.member.role, sender: data.member.sender } : {}),
      };
      setChat((prev) => ({ ...prev, ...c }));
      applyRoom(data.room, data.member);
      saveRoomSession({ code, role: data.member.role, token: data.token });
      const full = await roomFetch(`api/room/${encodeURIComponent(code)}/messages?after=0`, data.token);
      applyRoom(full.room, full.you);
      mergeMessages(full.messages || []);
      setChat((prev) => ({ ...prev, joined: true }));
    } catch (e) {
      showError(e.message);
    }
  }, []);

  const leaveRoom = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    lastIdRef.current = 0;
    setMessages([]);
    outboxRef.current = [];
    syncOutbox();
    setChat({
      code: null, role: null, token: null, memberId: null,
      sender: null, allowReply: true, expireAt: 0, joined: false,
    });
    saveRoomSession(null);
    hideError();
    if (location.hash.startsWith('#/c/')) location.hash = '';
  }, []);

  // ---------------- 轮询 ----------------

  useEffect(() => {
    if (!chat.joined || !chat.code || !chat.token) return undefined;
    async function pollOnce() {
      const c = chatRef.current;
      if (!c.code || !c.token || document.hidden) return;
      try {
        const data = await roomFetch(
          `api/room/${encodeURIComponent(c.code)}/messages?after=${lastIdRef.current}`,
          c.token,
        );
        applyRoom(data.room, null);
        mergeMessages(data.messages || []);
      } catch (e) {
        if ([403, 404, 410].includes(e.status)) {
          leaveRoom();
          showError('群聊已失效：' + e.message);
        }
        // 其他错误静默，下轮重试
      }
    }
    pollOnce();
    pollRef.current = setInterval(pollOnce, 2500);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
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
          if (pollRef.current) clearInterval(pollRef.current);
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
          const r = await apiFetch('api/room/create', {
            json: { text: t, expire_value: ex.value, expire_style: ex.style },
          });
          setChat((prev) => ({
            ...prev,
            code: r.room.code, token: r.token, joined: true,
            memberId: r.member.member_id, role: r.member.role, sender: r.member.sender,
          }));
          applyRoom(r.room, null);
          saveRoomSession({ code: r.room.code, role: r.member.role, token: r.token });
          mergeMessages([r.message]);
        } else {
          const r = await roomFetch(`api/room/${encodeURIComponent(c.code)}/send/text`, c.token, {
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
            setChat((prev) => ({
              ...prev,
              code: r.room.code, token: r.token, joined: true,
              memberId: r.member.member_id, role: r.member.role, sender: r.member.sender,
            }));
            applyRoom(r.room, null);
            saveRoomSession({ code: r.room.code, role: r.member.role, token: r.token });
          }
          outboxRef.current = outboxRef.current.filter((o) => o.uid !== item.uid);
          syncOutbox();
          mergeMessages([r.message]);
        } catch (e) {
          item.status = 'failed';
          item.err = e.message;
          syncOutbox();
          showError(e.message + '（点击气泡上的 ⚠ 可重试）');
          break; // 失败即停，保留队列
        }
      }
    } catch (e) {
      showError(e.message);
    }
    setSending(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // 建群有效期：控件已移除，固定默认 1 天（群主可在设置弹层修改）
  function readExpire() {
    return { value: 1, style: 'day' };
  }

  function doSend() {
    if (!text.trim()) return;
    processOutbox();
  }

  function addFiles(files) {
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
      const item = { uid: ++outboxSeq, file: f, status: 'sending', pct: 0, speed: 0 };
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
  }

  // 全局粘贴文件
  useEffect(() => {
    function onPaste(e) {
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
  }, [messages, outbox]);

  // ---------------- 渲染 ----------------

  const { code, role, token, sender, allowReply, expireAt, joined } = chat;
  const locked = joined && role === 'guest' && !allowReply;

  return (
    <section className="card chat" id="chatPanel" aria-label="群聊">
      <div className="chat-head">
        <div className="chat-head-spacer" />
        <div className="chat-code-area" id="codeArea" hidden={!joined}>
          <span className="chat-code-label">群号</span>
          <span className="chat-code" id="roomCode">{code || '—'}</span>
          <button
            className="iconbtn" id="copyCodeBtn" type="button" title="复制群号" aria-label="复制群号"
            onClick={async (e) => {
              await navigator.clipboard.writeText(code || '').catch(() => {});
              e.currentTarget.textContent = '✓';
              setTimeout(() => { e.currentTarget.textContent = ''; }, 1200);
            }}
          >
            <svg viewBox="0 0 24 24" width="15" height="15"><rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" fill="none" /><path d="M5 15V5a2 2 0 012-2h10" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" /></svg>
          </button>
          <button
            className="iconbtn" id="copyLinkBtn" type="button" title="复制邀请链接" aria-label="复制邀请链接"
            onClick={async (e) => {
              const link = location.origin + location.pathname.replace(/index\.html$/, '') + '#/c/' + code;
              await navigator.clipboard.writeText(link).catch(() => {});
              e.currentTarget.textContent = '✓';
              setTimeout(() => { e.currentTarget.textContent = ''; }, 1200);
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
            maxLength="5"
            autoComplete="off"
            spellCheck="false"
            inputMode="numeric"
          />
          <button
            className="btn primary" id="joinSubmitBtn" type="button"
            onClick={() => joinRoom(document.getElementById('joinCode').value)}
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
          rows="1"
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
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
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
        onSave={async (body) => {
          try {
            const room = await roomFetch(`api/room/${encodeURIComponent(code)}/settings`, token, {
              method: 'PUT', json: body,
            });
            applyRoom(room, null);
            setSettingsOpen(false);
          } catch (e) {
            showError(e.message);
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
