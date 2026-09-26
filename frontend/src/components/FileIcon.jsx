import React from 'react';

const EXT_COLORS = {
  pdf: '#e5484d',
  doc: '#2b579a', docx: '#2b579a', rtf: '#2b579a',
  xls: '#217346', xlsx: '#217346', csv: '#217346',
  ppt: '#d24726', pptx: '#d24726',
  zip: '#f0a020', rar: '#f0a020', '7z': '#f0a020', gz: '#f0a020', tar: '#f0a020',
  txt: '#6b7280', md: '#6b7280', log: '#6b7280',
  mp3: '#8b5cf6', wav: '#8b5cf6', flac: '#8b5cf6', m4a: '#8b5cf6', aac: '#8b5cf6',
  mp4: '#7c3aed', mov: '#7c3aed', mkv: '#7c3aed', avi: '#7c3aed', webm: '#7c3aed',
  js: '#f0b400', mjs: '#f0b400', ts: '#3178c6', tsx: '#3178c6',
  py: '#3776ab', go: '#00add8', java: '#e76f00',
  c: '#5c6bc0', cpp: '#5c6bc0', h: '#5c6bc0', cs: '#68217a',
  sh: '#4eaa25', json: '#6b7280', html: '#e34f26', css: '#2965f1',
};

export function fileExt(name = '') {
  const i = name.lastIndexOf('.');
  if (i < 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase().slice(0, 4);
}

export function fileColor(name = '') {
  return EXT_COLORS[fileExt(name)] || '#6b7280';
}

function readable(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? '#1f2430' : '#ffffff';
}

/** 文档图标：右上折角 + 文件类型文字，颜色随扩展名 */
export default function FileIcon({ name, width = 42 }) {
  const ext = fileExt(name);
  const color = fileColor(name);
  const height = Math.round((width * 52) / 44);
  return (
    <svg className="fileicon" viewBox="0 0 44 52" width={width} height={height} aria-hidden="true">
      <path d="M6 2h24l10 10v38a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill={color} />
      <path d="M30 2l10 10H32a2 2 0 0 1-2-2V2z" fill="#ffffff" fillOpacity="0.55" />
      <text
        x="22" y="35" textAnchor="middle"
        fontSize={ext.length > 3 ? 9 : 11} fontWeight="700" fill={readable(color)}
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        {ext ? ext.toUpperCase() : 'FILE'}
      </text>
    </svg>
  );
}
