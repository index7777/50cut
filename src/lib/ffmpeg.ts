'use client';

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

/**
 * Lazy-loaded ffmpeg.wasm instance.
 * ~30MB download, only loaded on first video interaction.
 */
let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

// 使用 unpkg CDN 的 wasm/js 檔(免部署額外檔案)
const BASE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';

export async function getFFmpeg(onLog?: (msg: string) => void): Promise<FFmpeg> {
  if (ffmpegInstance && ffmpegInstance.loaded) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const ffmpeg = new FFmpeg();

    if (onLog) {
      ffmpeg.on('log', ({ message }) => onLog(message));
    }

    await ffmpeg.load({
      coreURL: await toBlobURL(`${BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${BASE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  return loadPromise;
}

/**
 * Extract audio from a video File.
 * Returns a small MP3 blob suitable for upload to Whisper API.
 *
 * @param file - Input video file
 * @param onProgress - 0..1 progress
 */
export async function extractAudio(
  file: File,
  onProgress?: (progress: number) => void
): Promise<Blob> {
  const ffmpeg = await getFFmpeg();

  const inputName = 'input' + guessExt(file.name);
  const outputName = 'audio.mp3';

  // 進度回報
  const progressHandler = ({ progress }: { progress: number }) => {
    onProgress?.(Math.min(1, Math.max(0, progress)));
  };
  ffmpeg.on('progress', progressHandler);

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(file));

    // -vn: 去影像；-ac 1: 單聲道；-ar 16000: 16kHz(Whisper 最佳);-b:a 64k: 兼顧壓縮與辨識品質
    // -af: 高通去低頻噪(冷氣/風聲)+ 動態壓縮拉高人聲，幫 Whisper 認得更準
    await ffmpeg.exec([
      '-i', inputName,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      // 只高通去低頻噪(80Hz 以下鼓聲/BGM 貝斯)，不動態壓縮避免把 BGM 拉到語音音量誤導 Whisper
      '-af', 'highpass=f=80',
      '-b:a', '64k',
      '-f', 'mp3',
      outputName,
    ]);

    const data = await ffmpeg.readFile(outputName);
    // Clean up VFS
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}

    return new Blob([data as BlobPart], { type: 'audio/mpeg' });
  } finally {
    ffmpeg.off('progress', progressHandler);
  }
}

/**
 * Quick metadata probe (duration) without full decode.
 * Uses a hidden <video> element — much faster than ffmpeg for this purpose.
 */
export function probeVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(video.duration);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('metadata_load_failed'));
    };
    video.src = url;
  });
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

/**
 * 把一整支 MP3 依秒數切成多個 chunk。
 * 只做 stream copy(不重編碼),很快。
 *
 * @param audioBlob  完整 MP3
 * @param chunkSec   每段幾秒(建議 300 = 5 分鐘)
 * @returns 每個 chunk 為一個 Blob;順序依時間軸
 */
export async function splitAudioIntoChunks(
  audioBlob: Blob,
  chunkSec: number = 300
): Promise<Blob[]> {
  const ffmpeg = await getFFmpeg();
  const inputName = 'in_split.mp3';
  const pattern = 'chunk_%03d.mp3';

  await ffmpeg.writeFile(inputName, new Uint8Array(await audioBlob.arrayBuffer()));

  await ffmpeg.exec([
    '-i', inputName,
    '-f', 'segment',
    '-segment_time', String(chunkSec),
    '-c', 'copy',
    '-reset_timestamps', '1',
    '-y',
    pattern,
  ]);

  const chunks: Blob[] = [];
  for (let i = 0; i < 200; i++) { // 上限 200 chunk(~16 小時,遠超使用場景)
    const name = `chunk_${i.toString().padStart(3, '0')}.mp3`;
    try {
      const data = await ffmpeg.readFile(name);
      chunks.push(new Blob([data as BlobPart], { type: 'audio/mpeg' }));
      try { await ffmpeg.deleteFile(name); } catch {}
    } catch {
      break;
    }
  }

  try { await ffmpeg.deleteFile(inputName); } catch {}
  return chunks;
}
