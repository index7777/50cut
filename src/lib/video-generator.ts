'use client';

import { getFFmpeg } from '@/lib/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import { loadSubtitleFont } from '@/lib/font-loader';
import type { TranscriptSegment } from '@/lib/types';

export type SubtitlePosition = 'high' | 'middle' | 'low';

// Safe zone 對應到影片高度的百分比(距頂端)
// high  = 65%(較上面，避開 Threads 底部按鈕多)
// middle = 75%
// low   = 82%(較下面，適合影片下半沒重要畫面)
const POSITION_MAP: Record<SubtitlePosition, number> = {
  high: 0.65,
  middle: 0.75,
  low: 0.82,
};

export type GenerateOptions = {
  file: File;
  highlight: { start: number; end: number };
  segments: TranscriptSegment[];
  position: SubtitlePosition;
  onProgress?: (progress: number, phase: string) => void;
};

/**
 * Cut video to highlight range and burn subtitles in.
 * Runs entirely in the browser via ffmpeg.wasm.
 * Returns an MP4 Blob.
 */
export async function generateShortVideo(opts: GenerateOptions): Promise<Blob> {
  const { file, highlight, segments, position, onProgress } = opts;
  const hlStart = Math.max(0, highlight.start);
  const hlEnd = Math.max(hlStart + 0.5, highlight.end);
  const hlDuration = hlEnd - hlStart;

  // 1. 載字型
  onProgress?.(0, '準備字型...');
  const fontBytes = await loadSubtitleFont((p) => onProgress?.(p * 0.2, '準備字型...'));

  // 2. 載 ffmpeg
  onProgress?.(0.2, '準備處理器...');
  const ffmpeg = await getFFmpeg();

  // 3. 寫入字型與影片
  const inputName = 'in' + guessExt(file.name);
  await ffmpeg.writeFile('font.otf', fontBytes);
  await ffmpeg.writeFile(inputName, await fetchFile(file));

  // 4. 準備字幕(挑落在 highlight 範圍內的 segments，時間校正到 0 起算)
  const enc = new TextEncoder();
  const subs = segments
    .filter((s) => s.end > hlStart && s.start < hlEnd)
    .map((s) => ({
      start: Math.max(0, s.start - hlStart),
      end: Math.min(hlDuration, s.end - hlStart),
      text: wrapChinese(s.text.trim(), 15), // 每行最多 15 個字
    }))
    .filter((s) => s.end - s.start >= 0.1 && s.text.length > 0);

  // 為每段字幕寫一個 textfile(避免 shell 跳脫問題)
  const subtitleFiles: string[] = [];
  for (let i = 0; i < subs.length; i++) {
    const name = `sub_${i}.txt`;
    await ffmpeg.writeFile(name, enc.encode(subs[i].text));
    subtitleFiles.push(name);
  }

  // 5. 建 filter_complex
  //    位置公式：y = h*percent - text_h/2(垂直置中對齊 percent 高度)
  const posPct = POSITION_MAP[position];
  const fontSizeExpr = 'h/22'; // 相對字級，直式 1080 高會是 ~49px

  const drawtexts = subs.map((s, i) => {
    const parts = [
      `fontfile=font.otf`,
      `textfile=${subtitleFiles[i]}`,
      `fontsize=${fontSizeExpr}`,
      `fontcolor=white`,
      `borderw=4`,
      `bordercolor=black@0.85`,
      `line_spacing=8`,
      `x=(w-text_w)/2`,
      `y=h*${posPct.toFixed(2)}-text_h/2`,
      `enable='between(t,${s.start.toFixed(3)},${s.end.toFixed(3)})'`,
    ];
    return `drawtext=${parts.join(':')}`;
  });

  const filter = drawtexts.length > 0 ? drawtexts.join(',') : 'null';

  const outputName = 'out.mp4';

  // 6. 進度事件
  const progHandler = ({ progress }: { progress: number }) => {
    // ffmpeg 進度 0..1，映射到 20%..95%
    const p = 0.2 + Math.min(1, Math.max(0, progress)) * 0.75;
    onProgress?.(p, '合成影片...');
  };
  ffmpeg.on('progress', progHandler);

  try {
    // 7. 執行：先 seek 再 encode，加字幕 filter
    //    -ss 放輸入前是快速 seek(適合關鍵幀對齊)
    //    保持原比例、原尺寸，不改解析度
    onProgress?.(0.2, '合成影片...');
    await ffmpeg.exec([
      '-ss', hlStart.toFixed(2),
      '-i', inputName,
      '-t', hlDuration.toFixed(2),
      '-vf', filter,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y',
      outputName,
    ]);

    const data = await ffmpeg.readFile(outputName);

    // 8. 清 VFS(不留使用者資料)
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}
    for (const f of subtitleFiles) {
      try { await ffmpeg.deleteFile(f); } catch {}
    }

    onProgress?.(1, '完成');
    return new Blob([data as BlobPart], { type: 'video/mp4' });
  } finally {
    ffmpeg.off('progress', progHandler);
  }
}

/**
 * 中英混合字幕的簡易自動斷行。
 * 中文按字元寬度，英文按空格斷開，盡量在標點/空格處換行。
 */
function wrapChinese(text: string, maxCharsPerLine: number): string {
  if (!text) return '';
  // 若已經有換行，保留使用者原本斷法
  if (text.includes('\n')) return text;

  const softBreak = /[,、。;:!?…,;:!?\s]/;
  const lines: string[] = [];
  let line = '';

  for (let i = 0; i < text.length; i++) {
    line += text[i];
    if (line.length >= maxCharsPerLine) {
      // 嘗試在 line 末尾找一個標點/空格斷開
      let breakAt = -1;
      for (let j = line.length - 1; j >= Math.max(1, line.length - 6); j--) {
        if (softBreak.test(line[j])) {
          breakAt = j + 1;
          break;
        }
      }
      if (breakAt > 0 && breakAt < line.length) {
        lines.push(line.slice(0, breakAt).trim());
        line = line.slice(breakAt).trim();
      } else if (line.length >= maxCharsPerLine + 2) {
        // 硬斷
        lines.push(line.trim());
        line = '';
      }
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n');
}

function guessExt(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.mp4')) return '.mp4';
  if (lower.endsWith('.mov')) return '.mov';
  if (lower.endsWith('.webm')) return '.webm';
  if (lower.endsWith('.mkv')) return '.mkv';
  if (lower.endsWith('.m4v')) return '.m4v';
  return '.mp4';
}
