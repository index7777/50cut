# 50cut

影片界的 50 元快剪 — 手機錄完丟進來,兩分鐘給你 Threads 短片。

## 快速開始

```bash
# 1. 安裝依賴
npm install

# 2. 複製環境變數範本並填入 keys
cp .env.example .env.local

# 3. 本機開發
npm run dev
```

打開 http://localhost:3000

## 資安

**開發前務必先讀 [SECURITY.md](./SECURITY.md)。**

## 架構

- 前端:Next.js 14 (App Router) + Tailwind + PWA
- 後端:Next.js API Routes(只跑 Whisper + Claude,不碰影片)
- 影片處理:全部在前端用 ffmpeg.wasm
- 資料庫:Supabase(PostgreSQL + Auth,全表 RLS)
- 儲存:不儲存影片/音訊,處理完立即刪除

## 資料流

```
[手機錄影]
    ↓
[前端 ffmpeg.wasm 抽音訊]
    ↓  只上傳音訊
[API Route → Whisper → Claude]
    ↓  回傳時間戳+字幕
[前端 ffmpeg.wasm 切片+燒字幕]
    ↓
[使用者下載 MP4]
```

影片全程留在使用者手機,伺服器只暫存音訊做辨識、處理完立即刪除。

## 部署

推到 GitHub → Vercel 自動部署。環境變數在 Vercel Dashboard 設定,**絕不 commit `.env.local`**。
