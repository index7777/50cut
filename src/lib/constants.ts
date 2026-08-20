export const LIMITS = {
  // 過渡值:5→10 分鐘讓使用者測長片壓力,之後 D+C(音訊分段)完成後拉到 30 分鐘
  MAX_DURATION_SECONDS: 10 * 60,        // 10 分鐘
  MAX_FILE_SIZE_BYTES: 500 * 1024 * 1024, // 500MB(前端壓縮前)
  ACCEPTED_TYPES: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/*'],
} as const;
