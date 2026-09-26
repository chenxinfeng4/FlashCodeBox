import React, { useEffect, useState } from 'react';
import type { SettingsBody } from '../types';

interface SettingsModalProps {
  open: boolean;
  room: { allow_reply: boolean; expire_at: number };
  onSave: (body: SettingsBody) => void | Promise<void>;
  onClose: () => void;
}

type ExpireStyle = 'hour' | 'day' | 'forever';

/** 群主设置弹层：访客回消息开关 + 消息保留时长（常挂载，hidden 控制显隐） */
export default function SettingsModal({ open, room, onSave, onClose }: SettingsModalProps) {
  const [allowReply, setAllowReply] = useState<boolean>(!!room.allow_reply);
  const [style, setStyle] = useState<ExpireStyle>('day');
  const [value, setValue] = useState<number>(1);

  // 每次打开时，按群当前值重置表单
  useEffect(() => {
    if (!open) return;
    setAllowReply(!!room.allow_reply);
    if (!room.expire_at) {
      setStyle('forever');
      setValue(1);
      return;
    }
    const remain = room.expire_at - Date.now() / 1000;
    if (remain > 2 * 86400) {
      setStyle('day');
      setValue(Math.max(1, Math.round(remain / 86400)));
    } else {
      setStyle('hour');
      setValue(Math.max(1, Math.round(remain / 3600)));
    }
  }, [open, room]);

  return (
    <div className="modal" id="settingsModal" hidden={!open} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>群设置</h3>
          <button className="iconbtn" id="setCloseBtn" type="button" title="关闭" aria-label="关闭" onClick={onClose}>✕</button>
        </div>
        <label className="check">
          <input
            id="setAllowReply"
            type="checkbox"
            checked={allowReply}
            onChange={(e) => setAllowReply(e.target.checked)}
          />
          <span>允许访客回消息</span>
        </label>
        <div className="field">
          <span>消息保留时长</span>
          <div className="expire-inline">
            <select
              id="setExpireStyle"
              aria-label="保留时长单位"
              value={style}
              onChange={(e) => setStyle(e.target.value as ExpireStyle)}
            >
              <option value="hour">小时</option>
              <option value="day">天</option>
              <option value="forever">永久</option>
            </select>
            {style !== 'forever' && (
              <input
                id="setExpireValue"
                type="number"
                min="1"
                max="9999"
                value={value}
                aria-label="保留时长数值"
                onChange={(e) => setValue(Number(e.target.value))}
              />
            )}
          </div>
        </div>
        <p className="hint" id="setExpireHint">
          {style === 'forever'
            ? '消息将永久保留（可再修改）'
            : '保存后，该群及其全部消息将在该时长后自动删除'}
        </p>
        <button
          className="btn primary btn-block"
          id="setSaveBtn"
          type="button"
          onClick={() => onSave({
            allow_reply: allowReply,
            expire_style: style,
            expire_value: value || 1,
          })}
        >
          保存设置
        </button>
      </div>
    </div>
  );
}
