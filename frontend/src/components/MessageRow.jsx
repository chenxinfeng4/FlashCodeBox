import React from 'react';
import { humanBytes, isImageName } from '../lib/api.js';

// 浏览器的 <img>/<a> 请求无法带自定义 header，文件 URL 统一附带房间令牌
export function fileUrl(m, token, inline) {
  const base = m.download_url || `api/room/${encodeURIComponent(m.room_code)}/messages/${m.id}/file`;
  const sep = base.includes('?') ? '&' : '?';
  return base + sep + 'token=' + encodeURIComponent(token || '') + (inline ? '&inline=1' : '');
}

/**
 * 单条消息：自己右侧绿气泡，他人左侧白气泡 + 群名片；
 * 图片消息为缩略图（点击灯箱），文件消息为文件卡。
 */
export default function MessageRow({ m, mine, token, onImageClick }) {
  return (
    <div className={`chatrow ${mine ? 'mine' : 'theirs'}`} id={`msg-${m.id}`}>
      <div className="msgcol">
        {!mine && <div className="sender-name">{m.sender || ''}</div>}
        {m.type === 'text' ? (
          <div className={mine ? 'chatbubble me' : 'chatbubble other'}>{m.text || ''}</div>
        ) : isImageName(m.filename || '') ? (
          <div className={mine ? 'imgcard me-card' : 'imgcard'}>
            <img
              className="thumb"
              loading="lazy"
              src={fileUrl(m, token, true)}
              alt={m.filename || ''}
              title={`${m.filename || ''}（${humanBytes(m.size)}）· 点击放大`}
              onClick={() => onImageClick(m)}
            />
          </div>
        ) : (
          <div className={mine ? 'filecard me-card' : 'filecard'}>
            <svg viewBox="0 0 24 24" width="24" height="24">
              <path
                d="M14 3v5h5M6 3h9l5 5v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z"
                stroke="currentColor" strokeWidth="1.8" fill="none"
              />
            </svg>
            <div className="filecard-info">
              <div className="filecard-name" title={m.filename || ''}>{m.filename || '未命名文件'}</div>
              <div className="hint">{humanBytes(m.size)}</div>
            </div>
            <a className="btn" download={m.filename || ''} href={fileUrl(m, token)}>
              下载
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
