# 50cut 資安原則(SECURITY.md)

本文件是所有開發決策的優先參考。每次 PR 或大改動前對照一次。

## 六大鐵律

### 1. 資料最小化(Data Minimization)
只儲存絕對必要的資料:
- ✅ user_id(Supabase 自動)
- ✅ email(Supabase 加密儲存,登入用)
- ✅ 用量計數(整數欄位:total_used, daily_used, last_reset_date)
- ❌ **不儲存**:影片、音訊、逐字稿、字幕、任務歷史、IP、User-Agent

處理完成後所有中介資料**立即刪除**,不保留 debug 副本。

### 2. 前端不接觸敏感金鑰
| Key | 可否放前端 | 前綴規則 |
|-----|----------|----------|
| Supabase anon key | ✅ 可 | `NEXT_PUBLIC_` |
| Supabase service role key | ❌ 絕對不可 | 無前綴 |
| Anthropic API key | ❌ 絕對不可 | 無前綴 |
| OpenAI API key | ❌ 絕對不可 | 無前綴 |

**規則**:敏感 key 絕不加 `NEXT_PUBLIC_` 前綴,絕不出現在 `app/` 客戶端元件。

### 3. Supabase RLS(Row Level Security)全開
- 每張新表建立後**立即啟用 RLS**
- 每張表都要寫明確的 policy(SELECT/INSERT/UPDATE/DELETE)
- 沒 policy 的表視為漏洞,拒絕合併

### 4. 登入不用密碼
- 支援 Magic Link(Email 一次性連結)
- 支援 Google OAuth
- **不做**傳統帳密登入,不接觸使用者密碼

### 5. 速率限制與稽核
- API 每 IP 每小時上限(防濫用)
- 每使用者每日用量上限
- Log 記錄成功/失敗事件,**但不寫 email 原文**(用 user_id 或 email 的 SHA-256 前 8 碼)

### 6. 傳輸與靜態全加密
- 全站強制 HTTPS(Vercel 預設)
- Cloudflare R2 存的檔案使用**簽名連結**(TTL ≤ 10 分鐘)
- 音訊上傳完成 → 處理 → 立即刪除

---

## 開發檢查清單(每次改動對照)

- [ ] `.env.local` 有加入 `.gitignore`
- [ ] 敏感 key 沒有 `NEXT_PUBLIC_` 前綴
- [ ] 新表建完立刻開 RLS + 寫 policy
- [ ] API route 有速率限制
- [ ] Response 不夾帶其他使用者的資料
- [ ] Console.log 沒印 email、token、金鑰
- [ ] `npm audit` 沒有 high/critical
- [ ] CORS 只允許自己域名
- [ ] 用戶輸入進 Claude/DB 前有 sanitize

---

## 常見洩漏管道與對策

| 洩漏方式 | 我們的防線 |
|---------|-----------|
| Env vars 誤放前端 | 命名規則 + Code Review |
| Supabase RLS 沒開 | 建表模板強制含 RLS |
| API response 夾帶多用戶資料 | Response schema 只回自己的 row |
| Log 夾帶 email/token | Logger wrapper 過濾敏感欄位 |
| Prompt injection 洩密 | 用戶內容 sanitize、AI 回應不含系統資訊 |
| 依賴套件漏洞 | 每週 `npm audit` + Dependabot |
| Debug 資料留在 DB | 處理完立即刪除 job/task 記錄 |

---

## 事件回應

若發現洩漏或疑似洩漏:
1. 立刻停用相關 API key(Vercel Env → 換 key)
2. 撤銷所有 Supabase session(Supabase Dashboard → Users → Sign out all)
3. 排查 log 判斷影響範圍
4. 通知受影響使用者(Email 說明+補救措施)
5. 記錄事件與改進方案於 `docs/incidents/`

---

**Last updated**: 2026-08-19
**Owner**: 50cut 核心維護者
