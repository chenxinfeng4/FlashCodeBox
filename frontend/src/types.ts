// 后端 API 的数据形状（与 internal/api 各 view 函数一一对应）

export interface RoomView {
  code: string;
  expire_at: number; // unix 秒；0 = 永久
  allow_reply: boolean;
  created_at: number;
}

export type MemberRole = 'owner' | 'guest';

export interface MemberView {
  member_id: number;
  role: MemberRole;
  sender: string;
  guest_no: number;
}

export interface MessageView {
  id: number;
  member_id: number;
  role: MemberRole;
  sender: string;
  type: 'text' | 'file';
  created_at: number;
  // type = text
  text?: string;
  // type = file
  filename?: string;
  size?: number;
  download_url?: string;
  room_code?: string;
}

export interface SiteConfig {
  initialized?: boolean;
  name: string;
  description: string;
  open_upload: boolean;
  max_upload_size: number;
  max_text_size: number;
  chunk_size: number;
  code_type: 'number' | 'secret';
  allowed_types: string[];
  max_save_seconds: number;
  version: string;
}

export interface RoomSession {
  code: string;
  role: MemberRole;
  token: string;
}

/** create / join / send / upload complete 的统一响应 */
export interface SendResult {
  room: RoomView;
  token?: string;
  member?: MemberView;
  message: MessageView;
  added?: number;
}

/** 轮询端点响应 */
export interface MessagesResult {
  room: RoomView;
  you: MemberView;
  messages: MessageView[];
}

export interface SettingsBody {
  allow_reply: boolean;
  expire_style: 'hour' | 'day' | 'forever';
  expire_value: number;
}

/** 分片上传 init/status 响应 */
export interface ChunkSessionInfo {
  upload_id: string;
  file_name: string;
  file_size: number;
  chunk_size: number;
  total_chunks: number;
  uploaded: number[];
}

export interface UploadOptions {
  expire: { value: number; style: 'hour' | 'day' | 'forever' };
  code?: string | null;
  token?: string | null;
  onProgress?: (pct: number, speed: number) => void;
}

export interface AdminRoomItem {
  code: string;
  msg_count: number;
  text_count: number;
  file_count: number;
  preview: string;
  total_size: number;
  members: number;
  allow_reply: boolean;
  expire_at: number;
  expired: boolean;
}

export interface AdminList {
  items: AdminRoomItem[];
  total: number;
  page: number;
  page_size: number;
}

/** 管理后台读写的完整站点配置 */
export interface AdminConfig {
  name: string;
  description: string;
  open_upload: boolean;
  max_upload_size: number;
  max_text_size: number;
  chunk_size: number;
  code_type: 'number' | 'secret';
  allowed_types: string[];
  max_save_seconds: number;
  rate_limit_count: number;
  rate_limit_window: number;
  chunk_expire_hours: number;
}

/** 聊天页头部状态 */
export interface ChatState {
  code: string | null;
  role: MemberRole | null;
  token: string | null;
  memberId: number | null;
  sender: string | null;
  allowReply: boolean;
  expireAt: number;
  joined: boolean;
  members?: number;
}

/** 发送队列条目（outbox） */
export interface OutboxItem {
  uid: number;
  file: File;
  status: 'sending' | 'failed';
  pct: number;
  speed: number;
  thumbUrl?: string;
  err?: string;
}
