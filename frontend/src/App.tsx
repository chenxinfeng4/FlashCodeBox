import React, { useEffect, useState } from 'react';
import { apiFetch } from './lib/api';
import ChatPage from './components/ChatPage';
import AdminPage from './components/AdminPage';
import type { SiteConfig } from './types';

export default function App() {
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [route, setRoute] = useState<'main' | 'admin'>('main');
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

  async function loadConfig(): Promise<SiteConfig | null> {
    try {
      const cfg = await apiFetch<SiteConfig>('api/config');
      setConfig(cfg);
      document.title = cfg.name || '快闪群传';
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
              <path d="M13 2L4.5 13h6L9 22l10.5-12h-6L14.5 2z" fill="#fff" />
            </svg>
          </span>
          <span className="brand-name" id="siteName">{(config && config.name) || '快闪群传'}</span>
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
