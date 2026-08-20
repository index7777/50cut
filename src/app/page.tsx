import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

export default async function Home() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
      <h1 className="text-6xl font-semibold mb-5 tracking-tight">50cut</h1>
      <p className="text-[11px] uppercase tracking-[0.3em] opacity-50 mb-8">影片界的 50 元快剪</p>
      <p className="text-base opacity-80 mb-12 max-w-xs leading-relaxed">
        錄完丟進來，兩分鐘拿短片
        <br />
        字幕都幫你上好
      </p>

      <Link
        href={user ? '/app' : '/login'}
        className="px-10 py-3 rounded-full bg-white text-black font-medium hover:opacity-90 transition tracking-wide"
      >
        {user ? '開始剪片' : '登入使用'}
      </Link>

      <p className="mt-16 text-[11px] opacity-30 max-w-xs leading-relaxed tracking-wide">
        影片不會離開你的裝置，只有聲音上傳辨識，處理完立即刪除
      </p>
    </main>
  );
}
