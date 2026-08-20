import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * 高精度時間碼。
 * decimals=2 → 0:19.87(規格要求至少 0.01 秒)
 * decimals=3 → 0:19.874(編輯器微調時用)
 */
export function formatTimecode(seconds: number, decimals: 2 | 3 = 3): string {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const scale = decimals === 2 ? 100 : 1000;
  let frac = Math.round((total % 1) * scale);
  let sec = s;
  if (frac === scale) {
    frac = 0;
    sec += 1;
  }
  return `${m}:${sec.toString().padStart(2, '0')}.${frac
    .toString()
    .padStart(decimals, '0')}`;
}

/** 00:00.00 樣式(給字幕清單,對齊規格範例) */
export function formatCueTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  let cs = Math.round((total % 1) * 100);
  let sec = s;
  if (cs === 100) {
    cs = 0;
    sec += 1;
  }
  return `${m.toString().padStart(2, '0')}:${sec
    .toString()
    .padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
}
