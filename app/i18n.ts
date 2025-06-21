import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import ja from './locales/ja/common.json';
import en from './locales/en/common.json';

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
    ns: ['common'],          // namespaceとして"common"を明示
    defaultNS: 'common',     // デフォルトnamespace
    react: { useSuspense: false }, // 必要であれば
  });

export default i18n;