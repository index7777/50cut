import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'PingFang TC', 'Noto Sans TC', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
