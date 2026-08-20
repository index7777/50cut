# 50cut Handoff

給下一個接手的 AI/開發者:讀完這份 + `SECURITY.md` + `README.md` 就能無縫接手。

---

## 一句話定位

**「影片界的 50 元快剪」** — 手機錄完丟進來,兩分鐘拿到 Threads 短片,連字幕都幫你上好。

給「不會用 CapCut/剪映」的懶人用戶。

## 產品區隔(vs 已存在的工具)

- CapCut / 剪映:給你工具自己剪
- What'Sub(competitors.equal2.app):字幕做得好但要有剪輯基礎、電腦剪
- **50cut**:AI 全自動選段+燒字幕,零剪輯知識可用,手機優先

---

## 技術架構

```
[手機/桌機 PWA]  (Next.js 14 App Router + Tailwind)
     ↓
[ffmpeg.wasm 前端抽音訊]         ← 影片留本機
     ↓  只上傳 MP3(~1.2MB)
[/api/transcribe → Groq Whisper] ← 免費 6000/day
     ↓ word-level timestamp(最細粒度,不做斷句)
[subtitleSegmenter(本機、deterministic)]
     ↓ SubtitleCue[]:邊界一律取自 word 的真實時間
[/api/proofread → Gemini]        ← 只回文字 patch,不碰時間
     ↓
[/api/highlight → Gemini]        ← 系統產生候選,AI 只回 candidateId
     ↓ 亮點時間(取自候選)+ 標題 + hashtag
[ffmpeg.wasm 前端切片+燒字幕]    ← 用 Noto Sans TC (IndexedDB 快取)
     ↓
[使用者下載 MP4]
```

### 資料流原則

- **影片全程留手機**,只上傳音訊
- **音訊處理完立即刪除**(伺服器不留)
- **不儲存**逐字稿/字幕/成品
- 資料庫只存:user_id、email(Supabase 自動)、用量計數

---

## 使用的服務(全部免費層可跑 MVP)

| 服務 | 用途 | 免費層 | Env var |
|------|------|--------|---------|
| Vercel | 前端+API 部署 | Hobby 免費 | - |
| Supabase | Auth + Postgres(RLS 全開) | 免費層 | `NEXT_PUBLIC_SUPABASE_*` / `SUPABASE_SERVICE_ROLE_KEY` |
| Groq | Whisper 轉錄 | 6000 req/day | `GROQ_API_KEY` |
| Google AI Studio | Gemini 選段 | 1500 req/day | `GEMINI_API_KEY` |
| jsdelivr CDN | 字型 (Noto Sans TC ~4MB) | 免費 | `NEXT_PUBLIC_SUBTITLE_FONT_URL` |

---

## 已做完的

- ✅ Next.js 14 PWA(App Router + Tailwind + PWA manifest)
- ✅ Supabase 登入(Magic Link,Google OAuth 已預留 flag)
- ✅ RLS + `users_usage` 表 + `consume_usage` RPC(security definer)
- ✅ Middleware 保護 `/app` 和 `/api/process` 路由
- ✅ 手機優先 UI + 桌機拖放上傳
- ✅ ffmpeg.wasm 抽音訊(16kHz mono 32kbps MP3)
- ✅ Groq Whisper 辨識 + 逐字時間戳 + server 端依標點切句
- ✅ Gemini 選亮點(JSON schema 強制,含 guard rails)
- ✅ Rate limiter(IP + userId 雙 bucket)
- ✅ Logger 自動 redact email/token
- ✅ 字幕位置選擇(偏上/中間/偏下)
- ✅ Noto Sans TC 字型 IndexedDB 快取
- ✅ ffmpeg.wasm 切片+燒字幕(自動 15 字斷行)
- ✅ 影片預覽 + 下載 MP4
- ✅ 無限白名單機制(`UNLIMITED_EMAILS` env var)
- ✅ 資安 headers(COOP/COEP/X-Frame-Options/CSP-lite)
- ✅ **細粒度字幕時間軸**:用 Whisper word-level timestamp,deterministic segmenter 切 cue
- ✅ **一鍵流程**:選檔 → 處理中(階段清單)→ 完成頁,主 CTA 是下載;編輯器降為第二層
- ✅ **選片改為候選 + AI ranking**:系統產生對齊語句邊界的候選,Gemini 只回 id
- ✅ **Gemini 校字改 patch 模式**:只回 {index, from, to},不得改動時間軸
- ✅ 時間軸編輯器:波形、橫向軌道、毫秒微調、依波形自動切(可預覽/還原)
- ✅ 個人字典自動學習(從使用者實際修改 diff 出對照,localStorage)
- ✅ 分階段錯誤處理與單階段重試(不整條重跑)
- ✅ Gemini 失敗/額度用完仍能出片(deterministic fallback 候選)
- ✅ ESLint 設定(原本缺 .eslintrc.json,npm run lint 跑不起來)
- ✅ segmenter / candidates 單元測試(npm test,25 個)

## 還沒做的

- ⏳ Vercel 部署(下一步就要做)
- ⏳ Supabase URL Configuration 加 production 網址
- ⏳ 進階字幕(逐字亮起、關鍵字放大)
- ⏳ 多套商用免費字型可選(目前只 Noto Sans TC)
- ⏳ Favicon / icon-192.png / icon-512.png(現在 404)
- ⏳ 落地頁優化(現在只有極簡首頁)
- ⏳ 網域註冊(候選:50cut.app / 50cut.com / 50cut.tw)
- ⏳ Threads 帳號卡位 `@50cut`
- ⏳ 冷啟動內容(內測自己剪 20 支貼 Threads)
- ⏳ 分享/複製標題+hashtag 到剪貼簿的按鈕

## 已知問題

1. **短影片(<20s)Whisper 可能只切出 2 句** — 已加 word-level timestamp + 標點切分,可能還需要調校。debug log 已在 `transcribe/route.ts`。
2. **原影片本身有燒字幕的話,我們的字幕會疊上去而不是取代** — 產品說明要提醒使用者。
3. **iOS Safari 加到主畫面後推播沒實作** — 現在完成通知只在頁面內,未做 PWA push。

---

## 使用者做過的關鍵決策(重要!)

- **影片留本機**(隱私敘事)— 學 What'Sub,不要違背
- **保持原比例**(不強制 9:16)— 手機直錄本來就 9:16
- **字幕位置可自訂**(三段預設:高/中/低)
- **免費為主**,先衝規模,不急著收費
- **繁中在地**,不做多語(未來再說)
- **限制 5 分鐘 300MB**(手機端 ffmpeg 效能限制)
- **不上傳影片、伺服器不留檔**(資安 + 敘事)
- **Groq 而非 OpenAI**(免費 + 相同 API)
- **Gemini 而非 Claude**(免費 + 品質夠)
- **Magic Link 而非密碼**(不接觸使用者密碼)

## 使用者角色

- **獨立開發者**(全靠 AI 寫程式)
- **繁中在地市場**(台灣 Threads 生態)
- **有 Threads 帳號可以冷啟動**
- 預算越少越好、越快上線越好

---

## 檔案結構

```
C:\50cut\
├── SECURITY.md              ← 資安六大鐵律(每次改動對照)
├── HANDOFF.md               ← 本檔
├── README.md
├── .env.example             ← 環境變數範本
├── package.json
├── next.config.mjs          ← COOP/COEP + 資安 headers
├── supabase/migrations/
│   └── 001_users_usage.sql  ← users_usage 表 + RLS + consume_usage RPC
└── src/
    ├── middleware.ts         ← Session 刷新 + 路由保護
    ├── app/
    │   ├── page.tsx          ← 落地頁
    │   ├── login/page.tsx    ← Magic Link 登入
    │   ├── app/page.tsx      ← 主應用頁(用量卡 + Uploader)
    │   ├── auth/
    │   │   ├── callback/route.ts
    │   │   └── signout/route.ts
    │   └── api/
    │       ├── transcribe/route.ts   ← Groq Whisper
    │       └── highlight/route.ts    ← Gemini 選段
    ├── components/
    │   └── video-uploader.tsx        ← 完整 UI(picker/拖放/進度/預覽/下載)
    └── lib/
        ├── supabase/
        │   ├── server.ts
        │   ├── client.ts
        │   └── admin.ts               ← Service role,只在後端
        ├── ffmpeg.ts                  ← 懶載入 + 抽音訊
        ├── font-loader.ts             ← Noto Sans TC IndexedDB 快取
        ├── video-generator.ts         ← 切片+燒字幕 pipeline
        ├── auth-helpers.ts            ← isUnlimitedEmail
        ├── ratelimit.ts               ← 記憶體版
        ├── logger.ts                  ← redact 敏感欄位
        ├── constants.ts               ← LIMITS(5 分/300MB)
        ├── types.ts                   ← 共用 types(TranscriptWord/SubtitleCue)
        ├── subtitle-segmenter.ts      ← ★ deterministic 字幕切分(有測試)
        ├── highlight-candidates.ts    ← ★ 候選片段產生(有測試)
        ├── pipeline.ts                ← 一鍵流程協調層(分階段、可單階段重試)
        ├── dictionary.ts              ← 個人字典(localStorage,自動學習)
        └── utils.ts                   ← cn/formatBytes/formatTimecode/formatCueTime
```

---

## 上一個進度停在哪

**準備部署 Vercel**。使用者已:
- ✅ 建 GitHub repo:https://github.com/index7777/50cut(**PUBLIC,建議改 Private**)
- ⏳ 剛在 clone 時卡到 `50cut/` 子資料夾,尚未 push code
- ⏳ 尚未 Vercel Import

### 下一步該做的順序

1. **刪掉錯誤的 `50cut/` 子資料夾**:
   ```bash
   cd C:\50cut
   rmdir /s /q 50cut       # 或 Remove-Item -Recurse -Force 50cut
   git add .
   git status               # 確認 .env.local 不在清單
   git commit -m "初始 MVP"
   git push -u origin main
   ```

2. **把 repo 改 Private**(GitHub → Settings → Danger Zone)

3. **Vercel Import**:
   - vercel.com/new → Import `index7777/50cut`
   - **Environment Variables** 手動貼(見下)
   - Deploy

4. **Supabase 加 production URL**:
   - Dashboard → Authentication → URL Configuration
   - Site URL:`https://50cut.vercel.app`
   - Redirect URLs 加 `https://50cut.vercel.app/auth/callback`

5. **測試 production**:登入 → 上傳 → 全流程走一次

6. **卡位網域 + Threads 帳號** `@50cut`

7. **內測**:自己剪 20 支貼 Threads

---

## Vercel 環境變數清單(部署時貼進去)

```
# Public
NEXT_PUBLIC_SUPABASE_URL=<Supabase project URL>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<Supabase anon key>
NEXT_PUBLIC_SITE_URL=https://50cut.vercel.app
NEXT_PUBLIC_ENABLE_GOOGLE_LOGIN=false
NEXT_PUBLIC_SUBTITLE_FONT_URL=https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/SubsetOTF/TC/NotoSansTC-Regular.otf

# Secret(絕不加 NEXT_PUBLIC_ 前綴)
SUPABASE_SERVICE_ROLE_KEY=<Supabase service role key>
GROQ_API_KEY=<Groq key>
GEMINI_API_KEY=<Gemini key>
GEMINI_MODEL=gemini-3.6-flash

# Rate & bonus
RATE_LIMIT_PER_IP_PER_HOUR=20
FREE_DAILY_QUOTA=1
FREE_SIGNUP_BONUS=5
UNLIMITED_EMAILS=cheer@cheerdigiart.com.tw
```

**⚠️ 提醒**:實際 key 值只在使用者的密碼管理器 / 本機 `.env.local`,絕不寫進任何檔案或訊息。

---

## 對話風格建議(給下一個 AI)

使用者偏好:
- **繁體中文回應**
- **簡潔直接**,不廢話,不裝
- **有疑問先發問**,不要用推論替使用者決定
- 涉及技術決策時**列選項給使用者選**,不預設替他決定
- 使用者在 Cowork 環境,可以直接寫檔到 `C:\50cut`

---

## 若卡住

- 資安問題:對照 `SECURITY.md` 六大鐵律
- Whisper 相關:看 `src/app/api/transcribe/route.ts` 的 `splitBySentence` helper
- 字幕燒不上去:先確認 `NEXT_PUBLIC_SUBTITLE_FONT_URL` 抓得到 + IndexedDB 沒壞
- ffmpeg.wasm 在手機 crash:縮短影片長度上限、降低 `-crf` 到 26
- Gemini 選段失敗:看 log 的 `snippet` 欄位、可能是 model 名稱過期

---

**最後**:別破壞使用者當初的決策,尤其**「影片留本機」**這個核心敘事。要改前先問。


---

## 時間軸鐵律(改字幕相關功能前必讀)

```text
ASR / word timestamp  = 真實語音時間      ← 唯一時間來源
subtitleSegmenter     = deterministic 切分 ← 決定字幕邊界
Gemini                = 語意理解、校字、選片 ← 只做判斷
ffmpeg                = deterministic 執行
```

**AI 不可以同時控制**:文字、timestamp、字幕切分、影片實際剪輯時間。

具體約束:
- `SubtitleCue.start/end` 一律複製自 `TranscriptWord.start/end`,不得內插或由 LLM 產生
- `/api/proofread` 只接受 `{index, from, to}` patch,server 端會驗證 `from` 逐字存在才套用
- `/api/highlight` 的時間一律取自系統產生的候選物件,Gemini 回的任何數字都不當時間用
- 拿不到 word timestamp 時走 `subdivideSegments()`,標記 `timing: 'estimated'`、`words: []`,
  **不假造**每個字的時間;UI 必須顯示「約」與「時間為估算」

切分參數(要調就改這裡,不要改演算法):
`src/lib/subtitle-segmenter.ts` → `DEFAULT_SEGMENTER_CONFIG`
```ts
maxChars    = 14    // 一段字幕最多幾字
maxDuration = 3.5   // 一段最長幾秒
minDuration = 0.7   // 一段最短幾秒(句界優先於此值)
pauseSplit  = 0.45  // 停頓超過幾秒就切
```

候選片段參數:`src/lib/highlight-candidates.ts` → `DEFAULT_CANDIDATE_CONFIG`

## 驗證指令(改完一定要跑)

```bash
npm run typecheck
npm run lint
npm test          # 需要 tsx devDependency,先 npm install
npm run build
```

## 已知技術限制

1. **Groq 中文 word timestamp 的實際粒度未實測** — 程式對「單字」與「短詞」都能運作,
   但真實表現要看 log 的 `timing_source` 與字幕結果,不理想就調 segmenter 常數
2. **Whisper 幻聽** — 上游辨識品質問題,segmenter 修不了聽錯的字;
   防線是個人字典 + 手動編輯
3. **`-ss` 放在 `-i` 前是快速 seek** — 實際切點會吸附最近關鍵幀,可能與 cue 邊界差幾十毫秒。
   要精準需改 output seeking(慢很多),尚未改
4. **每支影片打 Gemini 兩次**(proofread + ranking),免費額度燒得快;
   proofread 失敗會靜默跳過不擋流程
