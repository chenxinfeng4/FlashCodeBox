import React from 'react';
import { humanBytes, isImageName } from '../lib/api';
import FileIcon from './FileIcon';
import type { MessageView } from '../types';

// 浏览器的 <img>/<a> 请求无法带自定义 header，文件 URL 统一附带房间令牌
export function fileUrl(m: MessageView, token: string | null | undefined, inline?: boolean): string {
  const base = m.download_url || `api/room/${encodeURIComponent(m.room_code || '')}/messages/${m.id}/file`;
  const sep = base.includes('?') ? '&' : '?';
  return base + sep + 'token=' + encodeURIComponent(token || '') + (inline ? '&inline=1' : '');
}

interface MessageRowProps {
  m: MessageView;
  mine: boolean;
  token: string | null | undefined;
  onImageClick: (m: MessageView) => void;
}

/**
 * 单条消息：自己右侧绿气泡，他人左侧白气泡 + 群名片；
 * 图片消息为缩略图（点击灯箱），文件消息为文件卡。
 */
export default function MessageRow({ m, mine, token, onImageClick }: MessageRowProps) {
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
            <a
              className="filecard-body"
              download={m.filename || ''}
              href={fileUrl(m, token)}
              title={`${m.filename || ''}（${humanBytes(m.size)}）· 点击下载`}
            >
              <div className="filecard-info">
                <div className="filecard-name" title={m.filename || ''}>{m.filename || '未命名文件'}</div>
                <div className="filecard-size">{humanBytes(m.size)}</div>
              </div>
              <FileIcon name={m.filename} />
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
