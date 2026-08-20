/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // ffmpeg.wasm 內部用 new Worker(new URL(...)) 載入 worker,
  // 這個設定讓 Next 14 (webpack 5) 正確處理它的 worker chunk,避免 404 卡 0%
  transpilePackages: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  // ffmpeg.wasm 需要以下 headers 才能用 SharedArrayBuffer
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
          // 資安 headers
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
