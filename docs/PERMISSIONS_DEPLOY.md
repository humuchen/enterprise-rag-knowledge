# 权限体系运维 / 部署说明

本文档覆盖企业级 RAG 的「切片 / 落库 / 检索」权限体系的部署、密钥管理、RLS 启用与离职回收操作。
配套代码：`src/redact.ts`、`src/principal.ts`、`src/crypto.ts`、`src/retriever.ts`、`src/indexer.ts`、`src/index.ts`、`src/middleware/audit.ts`、`db/init.sql`、`db/migrate.ts`、`src/config.ts`。

---

## 1. 权限模型总览

| 环节 | 机制 | 配置 / 代码 |
|------|------|-------------|
| 调用资格 | `x-api-key` 网关校验；`/api/v1/admin/*` 强制 `ADMIN_API_KEY`（fail-closed） | `src/index.ts` onRequest |
| 身份 → 标签 | 服务端 `API Key → 标签集` 映射，取代不可信的 `body.user_tags` | `PRINCIPAL_TAGS` / `src/principal.ts` |
| 召回过滤 | SQL `access_tags && $tags`（GIN 索引生效）+ 内存 `applyAccessFilter` 双保险 | `src/retriever.ts` |
| DB 层纵深 | chunks 表 `FOR SELECT` 行级安全（RLS），fail-closed | `DB_RLS_ENABLED` / `db/migrate.ts` |
| 呈现脱敏 | `metadata.sensitiveSpans` 按标签在检索层遮盖为 `[已脱敏]` | `src/redact.ts` |
| 落库加密 | 含敏感标记的切片 `content` 置 NULL、密文写入 `content_enc`（AES-256-GCM） | `CONTENT_ENCRYPTION_KEY` / `src/crypto.ts` |
| 入库打标 | 上传标签 ∩ 主体许可，防提权 | `src/index.ts` 上传路由 |
| 审计身份 | 由可信主体派生（superuser → 标签 → `key:sha256截断` → anonymous），不再信 `x-user-id` | `src/middleware/audit.ts` |
| 离职回收 | `documents.owner_id` + `DELETE /admin/owners/:id/documents`（ON DELETE CASCADE） | `src/index.ts` |

**关键认知**：权限标签（`access_tags`）与向量（`embedding`）是**完全解耦的两列**。任何权限变更都**不需要重算向量**——重算仅发生在更换 embedding 模型时。

---

## 2. 环境变量参考（.env）

| 变量 | 说明 | 默认值 | 生产要求 |
|------|------|--------|----------|
| `API_KEY` | `/api/v1/*` 网关密钥；为空则开放（仅开发） | 空 | **必配** |
| `ADMIN_API_KEY` | `/api/v1/admin/*` 密钥；未配则 admin 端点 503（fail-closed） | 空 | **必配** |
| `PRINCIPAL_TAGS` | Key→标签集 JSON，如 `{"k_emp":"public","k_hr":"public,hr","k_exec":"public,hr,exec,confidential"}` | `{}` | 建议配置 |
| `PRINCIPAL_LABELS` | Key→人类可读身份 JSON（用于审计），如 `{"k_emp":"员工","k_exec":"高管"}` | `{}` | 可选 |
| `DEFAULT_USER_TAGS` | 仅匹配 `API_KEY`（未单独登记）时的默认标签 | `public` | 按需 |
| `CONTENT_ENCRYPTION_KEY` | 落库加密密钥（AES-256-GCM）。任意口令 / 32 字节 base64 / 64 位 hex | 空（不加密，仅开发） | **必配**（强合规） |
| `DB_RLS_ENABLED` | 是否在 chunks 表启用 DB 层 RLS 策略 | `false` | 视合规要求 |
| `SCRUB_PII` | 入库时是否删除式脱敏（默认关，改用标记式） | `false` | 一般关 |
| `AUDIT_ENABLED` | 审计落库开关 | `true` | 建议开 |

> 密钥与口令**只存在服务端环境 / 密钥管理系统**，绝不写入代码、不进版本库、不入库。

---

## 3. 迁移步骤（npm run migrate）

迁移脚本幂等，可重复执行。它会：先跑 `db/init.sql`（建表、索引、可选 schema），再做 1.0.0→1.1.0 原地升级（补 `search_text`/`source` 列、修正唯一键、修正向量/FTS 索引），最后**按 `DB_RLS_ENABLED` 受控建立 RLS 策略**。

```bash
# 1. 配置 .env（至少 DB_*、API_KEY、ADMIN_API_KEY、CONTENT_ENCRYPTION_KEY）
cp .env.example .env   # 若不存在示例，手动创建

# 2. 执行迁移（建议先对数据库做一次备份 / 快照）
npm run migrate

# 期望输出（RLS 关闭时）：
#   Already at schema version 1.1.0 - skipping   （或 Schema migrated to version 1.1.0）
#   [RLS] disabled (DB_RLS_ENABLED=false) — skipping policy creation

# 3. 启动服务
npm run build && npm start
#   或开发态：npm run dev
```

启用 RLS 时，迁移会额外输出：
```
[RLS] enabled on chunks: FOR SELECT policy chunks_principal_select
```

> **顺序要求**：`migrate` 必须在服务首次启动**之前或与 schema 同步**执行，否则旧代码对空库 `ALTER TABLE` 会失败。全新库 `init.sql` 已含全部新列（`content_enc`、`owner_id`），`migrate` 只是幂等补强。

---

## 4. 启用 RLS（DB 层纵深防御）

### 4.1 原理
- `src/db.ts` 的 `queryWithAccess` 在**受控事务内**通过 `set_config('app.current_tags'/'app.is_superuser', ..., true)` 注入会话变量（`true`=事务级本地，不泄漏到连接池其它请求）。
- `db/migrate.ts` 在 `DB_RLS_ENABLED=true` 时，对 `chunks` 表 `ENABLE ROW LEVEL SECURITY` 并建立 `FOR SELECT` 策略：
  ```sql
  CREATE POLICY chunks_principal_select ON chunks FOR SELECT
    USING (
      current_setting('app.is_superuser', 'off') = 'on'
      OR access_tags && string_to_array(current_setting('app.current_tags', ''), ',')
    );
  ```
- **fail-closed**：未注入会话变量时所有 `chunks` 读取被拒绝（返回 0 行）。
- 仅约束 `SELECT`；`INSERT/UPDATE/DELETE`（含离职回收的级联删除）不受影响。
- 应用层 `access_tags && $tags` 过滤与 RLS 双重生效，语义一致。

### 4.2 启用操作
```bash
# 1. 在 .env 中设置
DB_RLS_ENABLED=true

# 2. 重新迁移（仅新建策略，幂等）
npm run migrate

# 3. 重启服务使策略生效（代码始终注入会话变量，但重启保证状态一致）
npm run build && npm start
```

### 4.3 验证（在 live PostgreSQL 上由运维执行）
```sql
-- (a) 策略已建立
SELECT polname, cmd FROM pg_policies WHERE tablename = 'chunks';
-- 期望：chunks_principal_select | SELECT

-- (b) 超级用户会话变量：应见全量
BEGIN;
SELECT set_config('app.is_superuser', 'on', true);
SELECT count(*) FROM chunks;   -- = 全表行数
COMMIT;

-- (c) 普通员工（仅 public）：仅见 access_tags 含 'public' 的切片
BEGIN;
SELECT set_config('app.is_superuser', 'off', true),
       set_config('app.current_tags', 'public', true);
SELECT count(*) FROM chunks;   -- ≤ 全量
COMMIT;

-- (d) 未注入会话变量（fail-closed，必须返回 0）
SELECT count(*) FROM chunks;   -- = 0
```
若 (d) 不为 0，说明 RLS 未生效（策略未建立或表未开启 RLS），需复查 4.1/4.2。

### 4.4 关闭 / 回滚
```bash
# 关闭只需改 .env 并手动 DROP 策略，无需重建表：
DB_RLS_ENABLED=false   # 仅影响下次迁移；已建策略不会自动删除
# 手动去除（如需即时关闭）：
psql $DATABASE_URL -c "DROP POLICY IF EXISTS chunks_principal_select ON chunks;"
psql $DATABASE_URL -c "ALTER TABLE chunks DISABLE ROW LEVEL SECURITY;"
# 应用层过滤仍然有效，不影响检索正确性。
```

> 前置条件：PostgreSQL ≥ 9.2（自定义带点 GUC 占位符支持）。

---

## 5. 密钥与加密管理

### 5.1 CONTENT_ENCRYPTION_KEY
- 格式任意（口令 / 32 字节 base64 / 64 位 hex），内部经 SHA-256 派生 32 字节密钥。
- **生成**：`openssl rand -hex 32` 或 `openssl rand -base64 32`。
- 仅服务端持有，存于密钥管理系统 / 环境变量，**不入库**。
- 缺失时 `src/crypto.ts` 安全退化为明文透传（仅开发态允许）。

### 5.2 密钥轮换（rotation）
- 轮换 `CONTENT_ENCRYPTION_KEY` 后，**旧密文 `content_enc` 将无法解密**（检索时返回空/报错）。
- 因此轮换必须伴随敏感文档**重新入库**：对含 `sensitiveSpans` 的文档重新走上传 / `npm run ingest` 流程，用新密钥重写 `content_enc`。
- 非敏感切片（无密文）不受影响。

### 5.3 库内明文边界
- 敏感切片：`content=NULL`、`search_text=NULL`、`content_enc=密文` → 库内无明文 PII。
- 非敏感切片：`content=明文`、`content_enc=NULL`。
- 若需「即使应用进程被攻破也看不到明文」，启用第 4 节 RLS，并在 RLS 之上叠加 `pgcrypto` 列加密（见代码注释中的可选 RLS 段落）。

---

## 6. 离职回收 SOP（O(1)，零向量重算）

1. **吊销访问**：在 `.env` 的 `PRINCIPAL_TAGS` 中移除该人 Key（或轮换其 API Key）。立即生效，无需动数据。
2. **（可选）回收其上传内容**：按其 `owner_id` 删除名下文档。
   - `owner_id` = 上传时由 `principalAuditId()` 派生的身份，取值为：
     - 超级用户 → `superuser`
     - 在 `PRINCIPAL_LABELS` 中 → 对应标签（如 `高管`）
     - 仅 Key → `key:<sha256 前 12 位>`
     - 匿名 → `anonymous`
   ```bash
   curl -X DELETE \
     -H "x-api-key: $ADMIN_API_KEY" \
     "http://<host>:9000/api/v1/admin/owners/<owner_id>/documents"
   # 返回 { "status":"deleted", "owner_id":"...", "documents_deleted": N }
   ```
   - `ON DELETE CASCADE` 自动清理其 `chunks` 与 `embedding`，**不涉及任何向量重算**。
3. **审计对账**：`audit_log` 已按可信主体记录其历史访问，可作为离职前的访问追溯依据。

> 关键：权限与向量解耦，离职 = 收口身份入口 +（可选）删文档，**绝不需要重跑向量库**。

---

## 7. 上线前安全自检清单

- [ ] `API_KEY`、`ADMIN_API_KEY`、`CONTENT_ENCRYPTION_KEY` 均已配置且非空
- [ ] 生产环境 `NODE_ENV=production` 且未告警「API_KEY is not set」
- [ ] `PRINCIPAL_TAGS` 已登记，低权限 Key 无法自报 `user_tags` 提权（上传裁剪生效）
- [ ] 强合规场景已 `DB_RLS_ENABLED=true` 并完成 4.3 验证
- [ ] `CONTENT_ENCRYPTION_KEY` 存于密钥管理系统，未进版本库
- [ ] 审计 `audit_log.user_id` 为可信主体派生值（非 `x-user-id`）
- [ ] 已对数据库做迁移前备份

---

## 8. 故障排查

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 检索返回空，但库内有数据 | RLS 已启用但会话变量未注入（代码非最新） | 确认部署的是含 `queryWithAccess` 的版本并重启 |
| 所有 `chunks` 读取为 0 | RLS 启用但策略读取到空 `app.current_tags` | 见 4.3(d)；确认 `DB_RLS_ENABLED` 与代码版本匹配 |
| 敏感切片检索报解密错误 | `CONTENT_ENCRYPTION_KEY` 与入库时不一致 / 已轮换 | 用入库时密钥，或重新入库敏感文档（5.2） |
| admin 端点 503 | 未配 `ADMIN_API_KEY` | 配置后重启 |
| 离职后其文档仍可被检索 | 未执行 owner 删除，或仅吊销 Key 但文档本就 `public` | 执行第 6 节删除；`public` 文档对所有主体可见属预期 |
