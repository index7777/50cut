export const LIMITS = {
  MAX_DURATION_SECONDS: 5 * 60,        // 5 分鐘
  MAX_FILE_SIZE_BYTES: 300 * 1024 * 1024, // 300MB(前端壓縮前)
  ACCEPTED_TYPES: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/*'],
} as const;
