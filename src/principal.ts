// src/principal.ts
// 服务端主体绑定：把 API Key 解析为「可访问标签集 + 是否超级用户」，
// 取代此前客户端自报的 body.user_tags（不可信）。
import crypto from 'crypto';
import { config } from './config';

export interface Principal {
  tags: string[];
  isSuperuser: boolean;
}

export function resolvePrincipalTags(apiKey?: string): Principal {
  // 1. 管理员 Key 视为超级用户，可见全部标签内容
  if (config.ADMIN_API_KEY && apiKey === config.ADMIN_API_KEY) {
    return { tags: [], isSuperuser: true };
  }
  // 2. 已登记的主体：Key -> 标签集
  if (apiKey && config.PRINCIPAL_TAGS[apiKey]) {
    return { tags: config.PRINCIPAL_TAGS[apiKey], isSuperuser: false };
  }
  // 3. 兼容旧版单 Key：落入默认标签集
  if (config.API_KEY && apiKey === config.API_KEY) {
    return { tags: config.DEFAULT_USER_TAGS, isSuperuser: false };
  }
  // 4. 其余：无权限
  return { tags: [], isSuperuser: false };
}

// 由可信主体派生的审计身份标识（取代不可伪造的客户端 x-user-id）。
// 优先级：超级用户 -> 显式标签 -> Key 的 sha256 截断（稳定且不含密钥明文）-> 匿名。
export function principalAuditId(p: Principal, apiKey?: string): string {
  if (p.isSuperuser) return 'superuser';
  if (apiKey && config.PRINCIPAL_LABELS[apiKey]) return config.PRINCIPAL_LABELS[apiKey];
  if (apiKey) return 'key:' + crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
  return 'anonymous';
}
