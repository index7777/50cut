import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

export default async function Home() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="min-h-screen">
      {/* Hero */}
      <section className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
        <h1 className="text-6xl sm:text-7xl font-semibold mb-5 tracking-tight">50cut</h1>
        <p className="text-[11px] uppercase tracking-[0.3em] opacity-50 mb-8">
          影片界的 50 元快剪
        </p>
        <p className="text-base sm:text-lg opacity-80 mb-12 max-w-sm leading-relaxed">
          錄完丟進來,兩分鐘拿短片
          <br />
          字幕都幫你上好
        </p>

        <Link
          href={user ? '/app' : '/login'}
          className="px-10 py-3 rounded-full bg-white text-black font-medium hover:opacity-90 transition tracking-wide"
        >
          {user ? '開始剪片' : '登入使用'}
        </Link>

        <p className="mt-8 text-[11px] opacity-40 tracking-wide">免費使用 · 手機也能剪</p>

        <a
          href="#how"
          className="absolute bottom-8 text-xs opacity-30 hover:opacity-70 transition"
        >
          ↓ 看怎麼用
        </a>
      </section>

      {/* 三步驟 */}
      <section id="how" className="py-24 sm:py-32 px-6">
        <div className="max-w-4xl mx-auto">
          <p className="text-[11px] uppercase tracking-[0.3em] opacity-40 text-center mb-3">
            how it works
          </p>
          <h2 className="text-3xl sm:text-4xl font-semibold text-center mb-16 tracking-tight">
            只有三步
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 sm:gap-8">
            {[
              {
                n: '01',
                t: '錄',
                d: '手機隨手錄一段。3 分鐘、5 分鐘,不用剪。',
              },
              {
                n: '02',
                t: '丟',
                d: '拖進 50cut,或點一下選檔。手機、電腦都行。',
              },
              {
                n: '03',
                t: '拿',
                d: 'AI 自動挑亮點、切片、上字幕。下載,貼脆。',
              },
            ].map((s) => (
              <div
                key={s.n}
                className="rounded-2xl bg-white/[0.04] border border-white/10 p-6"
              >
                <p className="text-[11px] tracking-widest opacity-40 mb-4">{s.n}</p>
                <h3 className="text-2xl font-semibold mb-3 tracking-tight">{s.t}</h3>
                <p className="text-sm opacity-70 leading-relaxed">{s.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 對照 */}
      <section className="py-24 sm:py-32 px-6 border-t border-white/5">
        <div className="max-w-3xl mx-auto">
          <p className="text-[11px] uppercase tracking-[0.3em] opacity-40 text-center mb-3">
            comparison
          </p>
          <h2 className="text-3xl sm:text-4xl font-semibold text-center mb-4 tracking-tight">
            跟 CapCut 差在哪
          </h2>
          <p className="text-sm opacity-60 text-center mb-12 leading-relaxed">
            我知道你會用 CapCut,但你也知道每次都要拖很久。
          </p>

          <div className="rounded-2xl bg-white/[0.04] border border-white/10 overflow-hidden">
            <ComparisonRow
              label="剪輯"
              capcut="你自己剪"
              whatsub="要會剪"
              fifty="AI 幫你剪"
            />
            <ComparisonRow
              label="字幕"
              capcut="自動加,常斷錯"
              whatsub="字幕做得好"
              fifty="自動加,還會校對"
              highlight
            />
            <ComparisonRow
              label="裝置"
              capcut="手機/電腦"
              whatsub="限電腦"
              fifty="手機優先"
            />
            <ComparisonRow
              label="難度"
              capcut="要學"
              whatsub="要有剪輯基礎"
              fifty="零基礎"
              highlight
              last
            />
          </div>

          <p className="text-xs opacity-40 text-center mt-8 leading-relaxed">
            上面是產品定位差異,不代表 CapCut 或 What&apos;Sub 不好。
            <br />
            50cut 適合「不想學剪輯」的人。
          </p>
        </div>
      </section>

      {/* 隱私 */}
      <section className="py-24 sm:py-32 px-6 border-t border-white/5">
        <div className="max-w-2xl mx-auto text-center">
          <p className="text-[11px] uppercase tracking-[0.3em] opacity-40 mb-3">privacy</p>
          <h2 className="text-3xl sm:text-4xl font-semibold mb-8 tracking-tight">
            影片不會離開你的裝置
          </h2>

          <div className="text-left space-y-4 text-sm opacity-80 leading-relaxed">
            <p>
              <span className="opacity-40">·</span> 影片全程在你的手機/電腦裡處理,
              <strong className="text-white">不上傳到我們的伺服器</strong>。
            </p>
            <p>
              <span className="opacity-40">·</span> 只有聲音(壓縮過的 1MB 左右)會上傳做辨識,
              <strong className="text-white">辨識完立刻刪除</strong>。
            </p>
            <p>
              <span className="opacity-40">·</span> 我們不儲存逐字稿、字幕、成品影片。資料庫只存 Email 和用量。
            </p>
            <p>
              <span className="opacity-40">·</span> 全站 HTTPS,Supabase 資料庫層 RLS 保護,只能讀寫自己的資料。
            </p>
          </div>

          <p className="mt-10 text-xs opacity-40 tracking-wide">
            不是承諾不看 — 是根本拿不到
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-24 sm:py-32 px-6 border-t border-white/5">
        <div className="max-w-2xl mx-auto">
          <p className="text-[11px] uppercase tracking-[0.3em] opacity-40 text-center mb-3">faq</p>
          <h2 className="text-3xl sm:text-4xl font-semibold text-center mb-12 tracking-tight">
            常見問題
          </h2>

          <div className="space-y-4">
            <FAQ
              q="真的免費?"
              a="是。每天 1 支免費,註冊送 3 支。想更多再看要不要付費,目前沒有付費方案。"
            />
            <FAQ
              q="影片長度有限制嗎?"
              a="目前最長 5 分鐘、最大 300MB。手機端處理效能考量,之後可能放寬。"
            />
            <FAQ
              q="剪得好嗎?"
              a="老實說,第一版可能還不完美。它至少能省你 20 分鐘、幫你上好字幕、切出還算有趣的片段。不滿意可以直接調時間軸、改字幕。"
            />
            <FAQ
              q="會用 CapCut 的人還需要嗎?"
              a="不一定。50cut 是給「懶得開 CapCut、只想丟進去等成品」的人。你如果享受剪輯過程,繼續用 CapCut 沒問題。"
            />
            <FAQ
              q="適合誰?"
              a="常常在 Threads / IG Reels 發短影音、但不想每次都要剪半小時的人。特別是講話類、Vlog 類、心得類。"
            />
            <FAQ
              q="會不會偷偷用我的影片訓練 AI?"
              a="不會。影片根本沒上傳到我們伺服器,只有聲音上去辨識(用 Groq Whisper),辨識完立即刪除。我們沒有你的影片,想拿也拿不到。"
            />
          </div>
        </div>
      </section>

      {/* CTA 收尾 */}
      <section className="py-24 sm:py-32 px-6 border-t border-white/5 text-center">
        <h2 className="text-3xl sm:text-4xl font-semibold mb-3 tracking-tight">要不要試試?</h2>
        <p className="text-sm opacity-60 mb-10 tracking-wide">免費 · 不用信用卡</p>
        <Link
          href={user ? '/app' : '/login'}
          className="inline-block px-10 py-3 rounded-full bg-white text-black font-medium hover:opacity-90 transition tracking-wide"
        >
          {user ? '開始剪片' : '登入使用'}
        </Link>
      </section>

      {/* Footer */}
      <footer className="py-10 px-6 border-t border-white/5">
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-3 text-[11px] opacity-40 tracking-wide">
          <p>© 2026 50cut</p>
          <p>影片界的 50 元快剪</p>
        </div>
      </footer>
    </main>
  );
}

function ComparisonRow({
  label,
  capcut,
  whatsub,
  fifty,
  highlight = false,
  last = false,
}: {
  label: string;
  capcut: string;
  whatsub: string;
  fifty: string;
  highlight?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className={`py-4 px-4 sm:px-6 text-sm ${
        !last ? 'border-b border-white/5' : ''
      }`}
    >
      <div className="text-[11px] uppercase tracking-widest opacity-40 mb-3">{label}</div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest opacity-40 mb-1">CapCut</div>
          <div className="opacity-70">{capcut}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest opacity-40 mb-1">What&apos;Sub</div>
          <div className="opacity-70">{whatsub}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest opacity-40 mb-1">50cut</div>
          <div className={highlight ? 'text-white font-medium' : 'opacity-90'}>{fifty}</div>
        </div>
      </div>
    </div>
  );
}

function FAQ({ q, a }: { q: string; a: string }) {
  return (
    <details className="rounded-xl bg-white/[0.04] border border-white/10 overflow-hidden group">
      <summary className="cursor-pointer px-5 py-4 text-sm font-medium flex justify-between items-center list-none">
        {q}
        <span className="opacity-40 group-open:rotate-45 transition-transform">+</span>
      </summary>
      <div className="px-5 pb-4 text-sm opacity-70 leading-relaxed">{a}</div>
    </details>
  );
}
