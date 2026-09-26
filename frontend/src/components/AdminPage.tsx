import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch, humanBytes, fmtTime, errMsg } from '../lib/api';
import { getAdminToken, setAdminToken, clearAdminToken } from '../lib/storage';
import type { AdminConfig, AdminList, SiteConfig } from '../types';

interface AdminPageProps {
  config: SiteConfig | null;
  onConfigSaved?: () => unknown;
}

/** 管理后台：初始化/登录、站点配置、群列表 */
export default function AdminPage({ onConfigSaved }: AdminPageProps) {
  const [initialized, setInitialized] = useState<boolean | null>(null); // null = 未知
  const [token, setToken] = useState<string | null>(getAdminToken());
  const [authError, setAuthError] = useState('');
  const [roomList, setRoomList] = useState<AdminList>({ items: [], total: 0, page: 1, page_size: 20 });
  const [cfg, setCfg] = useState<AdminConfig | null>(null);
  const [page, setPage] = useState(1);

  const authed = !!token;

  // 状态探测
  useEffect(() => {
    (async () => {
      try {
        const st = await apiFetch<{ initialized: boolean }>('api/admin/status');
        setInitialized(!!st.initialized);
      } catch (e) {
        setAuthError('无法连接服务器：' + errMsg(e));
        setInitialized(false);
      }
    })();
  }, []);

  const loadAdminConfig = useCallback(async () => {
    const c = await apiFetch<AdminConfig>('api/admin/config');
    setCfg(c);
  }, []);

  const loadList = useCallback(async (p: number) => {
    try {
      const data = await apiFetch<AdminList>(`api/admin/list?page=${p}&page_size=20`);
      setRoomList(data);
      setPage(data.page || p);
    } catch (e) {
      alert('加载列表失败：' + errMsg(e));
    }
  }, []);

  // 已有 token 时校验并进入面板
  useEffect(() => {
    if (!authed || !initialized) return;
    loadAdminConfig().catch((e) => {
      clearAdminToken();
      setToken(null);
      const status = (e as { status?: number }).status;
      if (status !== 401) setAuthError(errMsg(e));
    });
    loadList(1);
  }, [authed, initialized, loadAdminConfig, loadList]);

  async function doLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAuthError('');
    try {
      const pw = new FormData(e.currentTarget).get('password');
      const data = await apiFetch<{ token: string }>('api/admin/login', { json: { password: pw } });
      setAdminToken(data.token);
      setToken(data.token);
    } catch (err) {
      setAuthError(errMsg(err));
    }
  }

  async function doSetup(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAuthError('');
    const fd = new FormData(e.currentTarget);
    const pw = fd.get('password');
    if (String(pw).length < 8) {
      setAuthError('密码至少 8 位');
      return;
    }
    if (pw !== fd.get('password2')) {
      setAuthError('两次输入的密码不一致');
      return;
    }
    try {
      const data = await apiFetch<{ token: string }>('api/admin/setup', { json: { password: pw } });
      setAdminToken(data.token);
      setToken(data.token);
      if (onConfigSaved) await onConfigSaved();
    } catch (err) {
      setAuthError(errMsg(err));
    }
  }

  async function saveConfig(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const int = (k: string, def: number): number => {
      const n = parseInt(String(fd.get(k)), 10);
      return Number.isFinite(n) ? n : def;
    };
    const body = {
      name: (String(fd.get('name') || '')).trim() || '快闪群传',
      description: String(fd.get('description') || ''),
      open_upload: fd.get('open_upload') === 'on',
      max_upload_size: int('max_upload', 1024) * 1048576,
      max_text_size: int('max_text', 1024) * 1024,
      chunk_size: int('chunk', 5) * 1048576,
      code_type: String(fd.get('code_type') || 'number') as 'number' | 'secret',
      allowed_types: String(fd.get('types') || '').split(',').map((s) => s.trim()).filter(Boolean),
      max_save_seconds: int('max_save', 7) * 86400,
      rate_limit_count: int('rate_count', 30),
      rate_limit_window: int('rate_window', 60),
      chunk_expire_hours: int('chunk_expire', 24),
    };
    try {
      await apiFetch('api/admin/config', { method: 'PUT', json: body });
      if (onConfigSaved) await onConfigSaved();
      await loadAdminConfig();
      alert('配置已保存');
    } catch (err) {
      alert('保存失败：' + errMsg(err));
    }
  }

  async function deleteRoom(code: string) {
    if (!confirm(`确定删除群 ${code} 吗？全部消息与文件也会被删除。`)) return;
    try {
      await apiFetch(`api/admin/room/${encodeURIComponent(code)}`, { method: 'DELETE' });
      loadList(page);
    } catch (e) {
      alert('删除失败：' + errMsg(e));
    }
  }

  if (initialized === null) {
    return (
      <main className="layout admin" id="adminView">
        <section className="card narrow"><p className="hint">加载中…</p></section>
      </main>
    );
  }

  // ---------- 未认证：登录 / 初始化 ----------
  if (!initialized || !authed) {
    return (
      <main className="layout admin" id="adminView">
        <section className="card narrow" id="adminAuthCard">
          <div className="card-head">
            <h2><span className="dot dot-admin" /><span id="adminAuthTitle">{initialized ? '管理登录' : '初始化'}</span></h2>
          </div>
          {initialized ? (
            <form id="loginForm" className="stack" onSubmit={doLogin}>
              <label className="field"><span>管理密码</span>
                <input type="password" id="loginPassword" name="password" autoComplete="current-password" placeholder="输入管理密码" />
              </label>
              <button className="btn primary btn-block" type="submit">登 录</button>
            </form>
          ) : (
            <form id="setupForm" className="stack" onSubmit={doSetup}>
              <p className="hint">首次使用，请设置管理密码（至少 8 位）。密码仅用于管理后台，群聊不需要它。</p>
              <label className="field"><span>设置管理密码</span>
                <input type="password" id="setupPassword" name="password" autoComplete="new-password" placeholder="至少 8 位" />
              </label>
              <label className="field"><span>确认密码</span>
                <input type="password" id="setupPassword2" name="password2" autoComplete="new-password" placeholder="再输入一次" />
              </label>
              <button className="btn primary btn-block" type="submit">完成初始化</button>
            </form>
          )}
          {authError && <div className="alert err" id="adminAuthError">{authError}</div>}
        </section>
      </main>
    );
  }

  // ---------- 管理面板 ----------
  const pages = Math.max(1, Math.ceil(roomList.total / (roomList.page_size || 20)));
  return (
    <main className="layout admin" id="adminView">
      <section className="card" id="adminPanel">
        <div className="card-head">
          <h2><span className="dot dot-admin" />站点管理</h2>
          <button className="btn ghost" id="logoutBtn" onClick={() => { clearAdminToken(); setToken(null); }}>退出登录</button>
        </div>

        <details open>
          <summary>站点配置</summary>
          <form id="configForm" className="config-grid" onSubmit={saveConfig}>
            <label className="field"><span>站点名称</span><input id="cfgName" name="name" maxLength={60} defaultValue={cfg ? cfg.name : ''} key={'n' + (cfg ? cfg.name : '')} /></label>
            <label className="field"><span>站点描述</span><input id="cfgDesc" name="description" maxLength={200} defaultValue={cfg ? cfg.description : ''} key={'d' + (cfg ? cfg.description : '')} /></label>
            <label className="field"><span>单文件上限 (MB)</span><input id="cfgMaxUpload" name="max_upload" type="number" min={1} step={1} defaultValue={cfg ? Math.round(cfg.max_upload_size / 1048576) : 1024} key={'u' + (cfg ? cfg.max_upload_size : '')} /></label>
            <label className="field"><span>文本上限 (KB)</span><input id="cfgMaxText" name="max_text" type="number" min={1} step={1} defaultValue={cfg ? Math.round(cfg.max_text_size / 1024) : 1024} key={'t' + (cfg ? cfg.max_text_size : '')} /></label>
            <label className="field"><span>分片大小 (MB)</span><input id="cfgChunk" name="chunk" type="number" min={1} step={1} defaultValue={cfg ? Math.round(cfg.chunk_size / 1048576) : 5} key={'c' + (cfg ? cfg.chunk_size : '')} /></label>
            <label className="field"><span>群号类型</span>
              <select id="cfgCodeType" name="code_type" defaultValue={cfg ? cfg.code_type : 'number'} key={'k' + (cfg ? cfg.code_type : '')}>
                <option value="number">5 位数字</option>
                <option value="secret">5 位大写字母+数字</option>
              </select>
            </label>
            <label className="field"><span>类型白名单（逗号分隔或 *）</span><input id="cfgTypes" name="types" placeholder="jpg, png, zip 或 *" defaultValue={cfg ? (cfg.allowed_types || []).join(', ') : '*'} key={'w' + (cfg ? cfg.allowed_types.join(',') : '')} /></label>
            <label className="field"><span>有效期上限（天，0=不限）</span><input id="cfgMaxSave" name="max_save" type="number" min={0} step={1} defaultValue={cfg ? (cfg.max_save_seconds ? Math.round(cfg.max_save_seconds / 86400) : 0) : 7} key={'s' + (cfg ? cfg.max_save_seconds : '')} /></label>
            <label className="field"><span>限流次数（每窗口/IP，0=关闭）</span><input id="cfgRateCount" name="rate_count" type="number" min={0} step={1} defaultValue={cfg ? cfg.rate_limit_count : 30} key={'r' + (cfg ? cfg.rate_limit_count : '')} /></label>
            <label className="field"><span>限流窗口（秒）</span><input id="cfgRateWindow" name="rate_window" type="number" min={1} step={1} defaultValue={cfg ? cfg.rate_limit_window : 60} key={'rw' + (cfg ? cfg.rate_limit_window : '')} /></label>
            <label className="field"><span>未完成分片保留（小时）</span><input id="cfgChunkExpire" name="chunk_expire" type="number" min={1} step={1} defaultValue={cfg ? cfg.chunk_expire_hours : 24} key={'h' + (cfg ? cfg.chunk_expire_hours : '')} /></label>
            <label className="check span2"><input id="cfgOpenUpload" name="open_upload" type="checkbox" defaultChecked={cfg ? !!cfg.open_upload : true} key={'o' + (cfg ? cfg.open_upload : '')} /><span>开放匿名使用（关闭后仅管理员可发言）</span></label>
            <div className="span2"><button className="btn primary" type="submit">保存配置</button></div>
          </form>
        </details>

        <details open>
          <summary>群列表</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>群号</th><th>消息</th><th>概要</th><th>文件大小</th><th>成员</th><th>到期时间</th><th />
                </tr>
              </thead>
              <tbody id="listBody">
                {roomList.items.map((it) => (
                  <tr key={it.code} className={it.expired ? 'row-expired' : ''}>
                    <td className="cell-code">{it.code}</td>
                    <td>{`${it.msg_count} 条（文${it.text_count}/件${it.file_count}）`}</td>
                    <td className="cell-dim" title={it.preview || ''}>{it.preview || '-'}</td>
                    <td>{humanBytes(it.total_size)}</td>
                    <td>{`${it.members} 人${it.allow_reply ? '' : ' · 已禁回复'}`}</td>
                    <td>{it.expire_at ? fmtTime(it.expire_at) : '永久'}</td>
                    <td>
                      <button
                        className="iconbtn danger"
                        title="解散该群，删除全部消息并释放文件空间"
                        onClick={() => deleteRoom(it.code)}
                      >删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <button className="btn ghost" id="prevPage" disabled={page <= 1} onClick={() => loadList(page - 1)}>上一页</button>
            <span className="hint" id="pageInfo">{`第 ${page} / ${pages} 页 · 共 ${roomList.total} 间`}</span>
            <button className="btn ghost" id="nextPage" disabled={page >= pages} onClick={() => loadList(page + 1)}>下一页</button>
          </div>
        </details>
      </section>
    </main>
  );
}
