'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

const GOOGLE_ENABLED = process.env.NEXT_PUBLIC_ENABLE_GOOGLE_LOGIN === 'true';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const supabase = createClient();

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    setErrorMsg('');

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setStatus('error');
      setErrorMsg('寄送失敗,請稍後再試');
      return;
    }
    setStatus('sent');
  }

  async function signInWithGoogle() {
    setErrorMsg('');
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) setErrorMsg('Google 登入失敗');
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="text-3xl font-bold mb-2 text-center">登入 50cut</h1>
        <p className="text-sm opacity-60 mb-8 text-center">影片界的 50 元快剪</p>

        {GOOGLE_ENABLED && (
          <>
            <button
              onClick={signInWithGoogle}
              className="w-full py-3 mb-4 rounded-xl bg-white text-black font-medium hover:opacity-90 transition"
            >
              使用 Google 繼續
            </button>

            <div className="flex items-center gap-3 my-6">
              <div className="flex-1 h-px bg-white/20" />
              <span className="text-xs opacity-40">或</span>
              <div className="flex-1 h-px bg-white/20" />
            </div>
          </>
        )}

        {status !== 'sent' ? (
          <form onSubmit={sendMagicLink}>
            <input
              type="email"
              required
              placeholder="you@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              className="w-full px-4 py-3 mb-3 rounded-xl bg-white/10 border border-white/10 focus:outline-none focus:border-white/40"
            />
            <button
              type="submit"
              disabled={status === 'sending'}
              className="w-full py-3 rounded-xl bg-white text-black font-medium hover:opacity-90 disabled:opacity-50 transition"
            >
              {status === 'sending' ? '寄送中...' : '寄登入連結到信箱'}
            </button>
          </form>
        ) : (
          <div className="text-center opacity-70 py-6">
            <p className="mb-2">📧 已寄出登入連結</p>
            <p className="text-sm opacity-60">請到 {email} 收信</p>
          </div>
        )}

        {errorMsg && <p className="mt-3 text-sm text-red-400 text-center">{errorMsg}</p>}

        <p className="mt-8 text-xs opacity-40 text-center leading-relaxed">
          登入即代表同意我們的服務條款。
          <br />
          我們只儲存 Email 和用量,不儲存你的影片。
        </p>
      </div>
    </main>
  );
}
