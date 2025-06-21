import { RemixBrowser } from "@remix-run/react";
import { hydrateRoot } from "react-dom/client";
import { StrictMode, startTransition } from "react";
import "./i18n";

// グローバルエラーハンドラーを追加
window.addEventListener('error', (event) => {
  console.error('Global error caught:', event.error);
  console.error('Error details:', {
    message: event.error?.message,
    stack: event.error?.stack,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno
  });
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

startTransition(() => {
  try {
    hydrateRoot(
      document,
      <StrictMode>
        <RemixBrowser />
      </StrictMode>
    );
  } catch (error) {
    console.error('Hydration error:', error);
    // フォールバック: クライアントサイドレンダリング
    const root = document.createElement('div');
    root.innerHTML = `
      <div style="padding: 20px; text-align: center; font-family: Arial, sans-serif;">
        <h1>アプリケーションの読み込みに失敗しました</h1>
        <p>ページを再読み込みしてください。</p>
        <button onclick="window.location.reload()" style="padding: 10px 20px; background: #008060; color: white; border: none; border-radius: 4px; cursor: pointer;">
          再読み込み
        </button>
      </div>
    `;
    document.body.appendChild(root);
  }
});