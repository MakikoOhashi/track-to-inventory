import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import ja from '../public/locales/ja/common.json';
import en from '../public/locales/en/common.json';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      ja: { common: ja },
      en: { common: en },
    },
    lng: 'ja', // デフォルト言語
    fallbackLng: 'ja',
    interpolation: { escapeValue: false },
  });

export default i18n;