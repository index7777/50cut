'use client';

import { cn } from '@/lib/utils';
import type { StageState } from '@/lib/pipeline';

/**
 * 處理階段清單。
 * ✓ 完成 · ● 進行中 · ○ 待處理 · ✕ 失敗
 */
export function ProcessingSteps({ stages }: { stages: StageState[] }) {
  return (
    <div className="rounded-xl bg-black/30 border border-white/10 p-4">
      <ul className="space-y-2.5">
        {stages.map((s) => {
          const pct =
            s.status === 'running' && typeof s.progress === 'number'
              ? Math.round(Math.min(1, Math.max(0, s.progress)) * 100)
              : null;
          return (
            <li key={s.id} className="flex items-center gap-2.5 text-sm">
              <Marker status={s.status} />
              <span
                className={cn(
                  'transition-colors',
                  s.status === 'done' && 'opacity-60',
                  s.status === 'running' && 'text-white',
                  s.status === 'pending' && 'opacity-30',
                  s.status === 'failed' && 'text-red-300',
                  s.status === 'skipped' && 'opacity-30 line-through'
                )}
              >
                {s.label}
              </span>
              {pct !== null && (
                <span className="text-[11px] tabular-nums opacity-40 ml-auto">{pct}%</span>
              )}
              {s.status !== 'running' && s.message && (
                <span className="text-[11px] opacity-40 ml-auto">{s.message}</span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] opacity-30 mt-4 leading-relaxed">
        影片不會離開你的裝置，只有聲音上傳辨識，處理完立即刪除
      </p>
    </div>
  );
}

function Marker({ status }: { status: StageState['status'] }) {
  if (status === 'done') {
    return <span className="w-4 text-center text-emerald-400 text-xs">✓</span>;
  }
  if (status === 'failed') {
    return <span className="w-4 text-center text-red-400 text-xs">✕</span>;
  }
  if (status === 'running') {
    return (
      <span className="w-4 flex justify-center">
        <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
      </span>
    );
  }
  return (
    <span className="w-4 flex justify-center">
      <span className="w-2 h-2 rounded-full border border-white/30" />
    </span>
  );
}
