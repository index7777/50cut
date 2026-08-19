import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { VideoUploader } from '@/components/video-uploader';
import { isUnlimitedEmail } from '@/lib/auth-helpers';

export default async function AppPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const unlimited = isUnlimitedEmail(user.email);

  // 讀自己的用量(RLS 保證只能讀自己的)
  const { data: usage } = await supabase
    .from('users_usage')
    .select('total_used, daily_used, bonus_remaining')
    .eq('user_id', user.id)
    .single();

  return (
    <main className="min-h-screen flex flex-col items-center px-6 py-12">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold mb-1">50cut</h1>
        <p className="text-sm opacity-50 mb-8">哈囉 👋</p>

        <div className="rounded-2xl bg-white/5 border border-white/10 p-5 mb-6">
          {unlimited ? (
            <>
              <div className="text-xs opacity-50 mb-1">帳號</div>
              <div className="text-3xl font-bold">
                無限制
                <span className="text-sm opacity-40 ml-2">✦</span>
              </div>
              <div className="text-xs opacity-40 mt-2">累計用過 {usage?.total_used ?? 0} 支</div>
            </>
          ) : (
            <>
              <div className="text-xs opacity-50 mb-1">今日剩餘</div>
              <div className="text-3xl font-bold">
                {(usage?.bonus_remaining ?? 0) + Math.max(0, 1 - (usage?.daily_used ?? 0))}
                <span className="text-sm opacity-40 ml-2">支</span>
              </div>
              <div className="text-xs opacity-40 mt-2">
                註冊贈送 {usage?.bonus_remaining ?? 0} 支 · 每日免費 1 支 · 累計用過{' '}
                {usage?.total_used ?? 0} 支
              </div>
            </>
          )}
        </div>

        <VideoUploader />

        <form action="/auth/signout" method="post">
          <button className="mt-8 w-full py-2 text-sm opacity-50 hover:opacity-100 transition">
            登出
          </button>
        </form>
      </div>
    </main>
  );
}
