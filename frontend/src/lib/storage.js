// 会话存储：sessionStorage（不跨标签页——刷新保留、关标签即清、新开标签页干净）
export function getRoomSession() {
  try {
    return JSON.parse(sessionStorage.getItem('fs_room') || 'null');
  } catch (_) {
    return null;
  }
}

export function saveRoomSession(session) {
  if (session && session.code && session.token) {
    sessionStorage.setItem('fs_room', JSON.stringify(session));
  } else {
    sessionStorage.removeItem('fs_room');
  }
}

export function getAdminToken() {
  return sessionStorage.getItem('fs_admin_token');
}

export function setAdminToken(token) {
  sessionStorage.setItem('fs_admin_token', token);
}

export function clearAdminToken() {
  sessionStorage.removeItem('fs_admin_token');
}

// 分片断点续传信息（同标签页）
export function getUploadId(fileKey) {
  return sessionStorage.getItem('fs_up_' + fileKey);
}

export function setUploadId(fileKey, uploadId) {
  sessionStorage.setItem('fs_up_' + fileKey, uploadId);
}

export function clearUploadId(fileKey) {
  sessionStorage.removeItem('fs_up_' + fileKey);
}
