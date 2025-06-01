/** @type {import('next-i18next').UserConfig} */
const config = {
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'ja'],
    localeDetection: false, // 自動検出を無効化(明示的な切り替えのみ)
  },
  reloadOnPrerender: process.env.NODE_ENV === 'development',
};

export default config;