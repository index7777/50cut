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

    // -vn: 去影像;-ac 1: 單聲道;-ar 16000: 16kHz(Whisper 最佳);-b:a 32k: 低碼率省頻寬
    await ffmpeg.exec([
      '-i', inputName,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-b:a', '32k',
      '-f', 'mp3',
      outputName,
    ]);

    const data = await ffmpeg.readFile(outputName);
    // Clean up VFS
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}

    return new Blob([data], { type: 'audio/mpeg' });
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
