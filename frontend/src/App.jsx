import React, { useEffect, useState } from 'react';
import { apiFetch } from './lib/api.js';
import ChatPage from './components/ChatPage.jsx';
import AdminPage from './components/AdminPage.jsx';

export default function App() {
  const [config, setConfig] = useState(null);
  const [route, setRoute] = useState('main');
  const [dark, setDark] = useState(() => localStorage.getItem('fs_theme') === 'dark');

  // 主题：设备级偏好，保留 localStorage（新标签页应保持）
  useEffect(() => {
    document.documentElement.classList.toggle('theme-dark', dark);
  }, [dark]);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    localStorage.setItem('fs_theme', next ? 'dark' : 'light');
  };

  async function loadConfig() {
    try {
      const cfg = await apiFetch('api/config');
      setConfig(cfg);
      document.title = cfg.name || '文件快递';
      return cfg;
    } catch (_) {
      return null;
    }
  }

  // hash 路由：#/admin | #/c/{code} | 空
  useEffect(() => {
    function onHash() {
      setRoute(location.hash.startsWith('#/admin') ? 'admin' : 'main');
    }
    window.addEventListener('hashchange', onHash);
    onHash();
    loadConfig();
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <>
      <header className="topbar">
        <a className="brand" href="./">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path d="M7 9h10M7 13h7M12 17l3-3-3-3" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </span>
          <span className="brand-name" id="siteName">{(config && config.name) || '文件快递'}</span>
          <span className="brand-sub" id="siteDesc">{(config && config.description) || ''}</span>
        </a>
        <nav className="topbar-nav">
          <a href="#/admin" className="admin-link">管理</a>
          <button className="theme-btn" id="themeBtn" type="button" title="切换明暗主题" aria-label="切换明暗主题"
            onClick={toggleTheme}>
            {dark ? '☀️' : '🌙'}
          </button>
        </nav>
      </header>

      <div className="banner" id="setupBanner" hidden={!!(config && config.initialized)}>
        首次使用：请先 <a href="#/admin">设置管理密码</a> 完成初始化。
      </div>

      {route === 'admin' ? (
        <AdminPage config={config} onConfigSaved={loadConfig} />
      ) : (
        <main className="layout single" id="mainView">
          <ChatPage config={config} />
        </main>
      )}

    </>
  );
}
