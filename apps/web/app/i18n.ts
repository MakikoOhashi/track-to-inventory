import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import ja from './locales/ja/common.json';
import en from './locales/en/common.json';

// i18next's default instance exposes the plugin registration method.
// eslint-disable-next-line import/no-named-as-default-member
i18next
  .use(initReactI18next)
  .init({
    resources: {
      ja: { common: ja },
      en: { common: en },
    },
    // 初回描画はSSRと一致させ、hydration mismatchを避ける
    lng: 'ja',
    fallbackLng: 'ja',
    supportedLngs: ['ja', 'en'],
    interpolation: { escapeValue: false },
    ns: ['common'],          // namespaceとして"common"を明示
    defaultNS: 'common',     // デフォルトnamespace
    react: { useSuspense: false }, // 必要であれば
  });

export default i18next;
