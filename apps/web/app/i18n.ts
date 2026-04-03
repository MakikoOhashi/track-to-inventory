import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import ja from './locales/ja/common.json';
import en from './locales/en/common.json';

// localStorageから言語設定を取得
const getStoredLanguage = () => {
  if (typeof window !== 'undefined') {
    return localStorage.getItem('i18nextLng') || 'ja';
  }
  return 'ja';
};

i18n
  .use(initReactI18next)
  .init({
    resources: {
      ja: { common: ja },
      en: { common: en },
    },
    lng: getStoredLanguage(), // localStorageから取得した言語を使用
    fallbackLng: 'ja',
    supportedLngs: ['ja', 'en'],
    interpolation: { escapeValue: false },
    ns: ['common'],          // namespaceとして"common"を明示
    defaultNS: 'common',     // デフォルトnamespace
    react: { useSuspense: false }, // 必要であれば
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
  });

export default i18n;