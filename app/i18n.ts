import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// 静的インポートで翻訳ファイルを読み込み
import enCommon from './locales/en/common.json';
import jaCommon from './locales/ja/common.json';
import enForms from './locales/en/forms.json';
import jaForms from './locales/ja/forms.json';
import enNavigation from './locales/en/navigation.json';
import jaNavigation from './locales/ja/navigation.json';

// 安全な翻訳ファイル読み込み
const loadTranslations = () => {
  try {
    return {
      en: {
        common: enCommon,
        forms: enForms,
        navigation: enNavigation,
      },
      ja: {
        common: jaCommon,
        forms: jaForms,
        navigation: jaNavigation,
      },
    };
  } catch (error) {
    console.error("Failed to load translations:", error);
    // フォールバック翻訳
    return {
      en: {
        common: {
          "title.shipmentsByOwner": "Shipments by Owner",
          "title.upcomingArrivals": "Upcoming Arrivals",
          "title.arrivalStatus": "Arrival Status",
          "title.detailDisplay": "Detail Display",
          "title.productArrivals": "Product Arrivals",
          "title.statusChart": "Status Chart",
          "title.siSearch": "SI Search",
          "button.cardView": "Card View",
          "button.tableView": "Table View",
          "button.showGuide": "Show Guide",
          "button.productNameAsc": "Product Name (A-Z)",
          "button.productNameDesc": "Product Name (Z-A)",
          "label.siNumber": "SI Number",
          "label.productName": "Product Name",
          "label.totalQuantity": "Total Quantity",
          "label.eta": "ETA",
          "label.status": "Status",
          "label.supplier": "Supplier",
          "label.quantity": "Quantity",
          "message.clickForDetails": "Click for details",
          "message.noData": "No data available",
          "message.noMatchingSi": "No matching SI numbers found",
          "placeholder.siNumber": "Enter SI number",
          "status.notSet": "Not Set",
          "status.productSync": "Product Sync",
          "tabs.search": "Search",
          "tabs.product": "Product",
          "tabs.status": "Status",
          "modal.status.siIssued": "SI Issued",
          "modal.status.scheduleConfirmed": "Schedule Confirmed",
          "modal.status.shipping": "Shipping",
          "modal.status.customsClearance": "Customs Clearance",
          "modal.status.warehouseArrival": "Warehouse Arrival",
          "modal.status.synced": "Synced",
        },
        forms: {},
        navigation: {},
      },
      ja: {
        common: {
          "title.shipmentsByOwner": "出荷情報一覧",
          "title.upcomingArrivals": "到着予定",
          "title.arrivalStatus": "到着状況",
          "title.detailDisplay": "詳細表示",
          "title.productArrivals": "商品別到着状況",
          "title.statusChart": "ステータス別一覧",
          "title.siSearch": "SI番号検索",
          "button.cardView": "カード表示",
          "button.tableView": "テーブル表示",
          "button.showGuide": "ガイドを表示",
          "button.productNameAsc": "商品名（昇順）",
          "button.productNameDesc": "商品名（降順）",
          "label.siNumber": "SI番号",
          "label.productName": "商品名",
          "label.totalQuantity": "総数量",
          "label.eta": "到着予定日",
          "label.status": "ステータス",
          "label.supplier": "サプライヤー",
          "label.quantity": "数量",
          "message.clickForDetails": "クリックで詳細表示",
          "message.noData": "データがありません",
          "message.noMatchingSi": "該当するSI番号が見つかりません",
          "placeholder.siNumber": "SI番号を入力",
          "status.notSet": "未設定",
          "status.productSync": "商品同期",
          "tabs.search": "検索",
          "tabs.product": "商品",
          "tabs.status": "ステータス",
          "modal.status.siIssued": "SI発行済",
          "modal.status.scheduleConfirmed": "船積スケジュール確定",
          "modal.status.shipping": "船積中",
          "modal.status.customsClearance": "輸入通関中",
          "modal.status.warehouseArrival": "倉庫着",
          "modal.status.synced": "同期済み",
        },
        forms: {},
        navigation: {},
      },
    };
  }
};

const resources = loadTranslations();

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: 'ja', // デフォルト言語
    fallbackLng: 'en', // フォールバック言語
    interpolation: {
      escapeValue: false, // Reactは既にXSSを防いでいる
    },
    debug: process.env.NODE_ENV === 'development',
    react: {
      useSuspense: false, // SSR対応
    },
  });

export default i18n;