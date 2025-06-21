import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// 翻訳ファイルを直接インポート
import ja from './locales/ja/common.json';
import en from './locales/en/common.json';

// 翻訳リソースを安全に準備
const resources = {
  ja: { 
    common: ja || {
      title: { shipmentsByOwner: "入荷予定一覧" },
      button: { cardView: "カード表示", tableView: "テーブル表示" },
      message: { noData: "データがありません" }
    }
  },
  en: { 
    common: en || {
      title: { shipmentsByOwner: "Shipment List" },
      button: { cardView: "Card View", tableView: "Table View" },
      message: { noData: "No data available" }
    }
  }
};

// i18n初期化を安全に行う
try {
  i18n
    .use(initReactI18next)
    .init({
      resources,
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
      // デバッグモードを有効にする（開発時のみ）
      debug: process.env.NODE_ENV === 'development',
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