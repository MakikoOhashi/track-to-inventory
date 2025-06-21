import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";
import { ErrorBoundary } from "react-error-boundary";

// Error Fallback Component
function ErrorFallback({ error, resetErrorBoundary }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <title>エラーが発生しました</title>
      </head>
      <body>
        <div style={{ 
          padding: '20px', 
          fontFamily: 'Arial, sans-serif',
          textAlign: 'center' 
        }}>
          <h1>エラーが発生しました</h1>
          <p>申し訳ございませんが、アプリケーションでエラーが発生しました。</p>
          <button 
            onClick={resetErrorBoundary}
            style={{
              padding: '10px 20px',
              backgroundColor: '#008060',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            再試行
          </button>
          {process.env.NODE_ENV === 'development' && (
            <details style={{ marginTop: '20px', textAlign: 'left' }}>
              <summary>エラー詳細</summary>
              <pre style={{ 
                backgroundColor: '#f5f5f5', 
                padding: '10px', 
                overflow: 'auto',
                fontSize: '12px'
              }}>
                {error.message}
                {error.stack}
              </pre>
            </details>
          )}
        </div>
      </body>
    </html>
  );
}

export const headers = () => ({
  "X-Frame-Options": "ALLOWALL",
  "Content-Security-Policy": "frame-ancestors https://admin.shopify.com https://*.myshopify.com"
});

export function links() {
  return [
    { rel: "preconnect", href: "https://cdn.shopify.com/" },
    { rel: "stylesheet", href: "https://cdn.shopify.com/static/fonts/inter/v4/styles.css" },
    {
      rel: "stylesheet",
      href: "https://unpkg.com/@shopify/polaris@12.27.0/build/esm/styles.css"
    },
  ];
}

export default function App() {
  return (
    <ErrorBoundary FallbackComponent={ErrorFallback}>
      <html lang="ja">
        <head>
          <meta charSet="utf-8" />
          <Meta />
          <Links />
        </head>
        <body>
          <Outlet />
          <ScrollRestoration />
          <Scripts />
        </body>
      </html>
    </ErrorBoundary>
  );
}