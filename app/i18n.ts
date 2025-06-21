import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// 安全なインポート
let ja: any = {};
let en: any = {};

try {
  ja = require('./locales/ja/common.json');
} catch (error) {
  console.warn('Failed to load Japanese translations:', error);
  ja = {};
}

try {
  en = require('./locales/en/common.json');
} catch (error) {
  console.warn('Failed to load English translations:', error);
  en = {};
}

// i18n初期化を安全に行う
try {
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
      // エラーハンドリングを追加
      missingKeyHandler: (lng, ns, key, res) => {
        console.warn(`Missing translation key: ${key} for language: ${lng}`);
        return key; // キーをそのまま返す
      },
    });
} catch (error) {
  console.error('i18n initialization failed:', error);
  // フォールバック設定
  i18n.init({
    resources: {
      ja: { common: { fallback: 'フォールバック' } },
      en: { common: { fallback: 'Fallback' } },
    },
    lng: 'ja',
    fallbackLng: 'ja',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
}

export default i18n;