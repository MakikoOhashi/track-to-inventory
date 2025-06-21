import { RemixBrowser } from "@remix-run/react";
import { hydrateRoot } from "react-dom/client";
import { StrictMode, startTransition } from "react";
import "./i18n";

// 開発環境でより詳細なエラーを表示
if (process.env.NODE_ENV === 'development') {
  // Reactの開発モードを有効にする
  (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ || {};
}

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
  
  // Reactエラーの詳細を解析
  if (event.error?.message?.includes('React error #418')) {
    console.error('React Error #418: Invalid React element being rendered');
    console.error('This usually means null, undefined, or invalid JSX is being rendered');
  }
  
  if (event.error?.message?.includes('React error #423')) {
    console.error('React Error #423: Invalid React component or element type');
    console.error('This usually means an invalid component is being rendered');
  }
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