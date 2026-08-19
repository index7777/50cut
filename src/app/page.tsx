import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

export default async function Home() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
      <h1 className="text-5xl font-bold mb-4 tracking-tight">50cut</h1>
      <p className="text-lg opacity-70 mb-2">影片界的 50 元快剪</p>
      <p className="text-sm opacity-50 mb-12 max-w-xs leading-relaxed">
        錄完、丟進來、兩分鐘拿短片
        <br />
        字幕都幫你上好
      </p>

      <Link
        href={user ? '/app' : '/login'}
        className="px-8 py-3 rounded-full bg-white text-black font-medium hover:opacity-90 transition"
      >
        {user ? '開始剪片' : '登入開始'}
      </Link>

      <p className="mt-12 text-xs opacity-30 max-w-xs leading-relaxed">
        影片留在你的手機,只有聲音去辨識,處理完立即刪除
      </p>
    </main>
  );
}
