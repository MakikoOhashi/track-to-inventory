import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";

export const headers = ({ loaderHeaders }) => {
  const shop = loaderHeaders.get("X-Shop-Domain");
  return {
    "Content-Security-Policy": shop
      ? `frame-ancestors https://${shop} https://admin.shopify.com`
      : "frame-ancestors https://admin.shopify.com"
  };
};

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
  );
}