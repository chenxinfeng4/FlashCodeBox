import React from 'react';
import type { MessageView } from '../types';

interface LightboxProps {
  src: string;
  item: MessageView | null;
  onClose: () => void;
}

/** 图片灯箱：全屏遮罩 + 原图 + 下载（常挂载，hidden 控制显隐；src 已含房间令牌） */
export default function Lightbox({ src, item, onClose }: LightboxProps) {
  return (
    <div className="lightbox" id="lightbox" hidden={!item} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <button className="lightbox-close" type="button" title="关闭" aria-label="关闭" onClick={onClose}>✕</button>
      {item && (
        <img
          className="lightbox-img"
          alt={item.filename || ''}
          src={`${src}&inline=1`}
        />
      )}
      <div className="lightbox-bar">
        {item && (
          <a className="btn" download={item.filename || ''} href={src}>下载原图</a>
        )}
      </div>
    </div>
  );
}
