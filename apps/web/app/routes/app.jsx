import { Link, Outlet, useLoaderData, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import { data as json } from "react-router";
import { i18n as i18nServer } from "../utils/i18n.server";

// i18nをimport
import { I18nextProvider } from "react-i18next";
import i18n from "../i18n";
import { useEffect, useState } from "react";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || "";
  const host = url.searchParams.get("host") || "";
  const locale = await i18nServer.getLocale(request);
  
  return json({ apiKey: process.env.SHOPIFY_API_KEY || "", host, locale }, {
    headers: {
      "X-Shop-Domain": shop
    }
  });
};

export default function App() {
  const { apiKey, locale } = useLoaderData();
  const location = useLocation();
  const [hasMounted, setHasMounted] = useState(false);
  const search = location.search || "";
  const isPreview = typeof window !== "undefined" && window.location.hostname.endsWith(".workers.dev");

  const linkWithSearch = (path) => `${path}${search}`;
  const scrollToTop = () => {
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    });
  };

  useEffect(() => {
    if (locale && i18n.language !== locale) {
      i18n.changeLanguage(locale);
    }
  }, [locale]);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    fetch("/api/ocr-health").catch((error) => {
    });
  }, []);

  if (!hasMounted) {
    return (
      <div suppressHydrationWarning style={{ padding: 16 }}>
        Loading...
      </div>
    );
  }

  return (
    <I18nextProvider i18n={i18n}>
      <PolarisAppProvider i18n={polarisTranslations}>
        <ShopifyAppProvider embedded apiKey={apiKey}>
          {isPreview ? (
            <div
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid #e1e3e5",
                background: "#f6f6f7",
                display: "flex",
                gap: "12px",
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: "#616161" }}>
                Preview navigation
              </span>
              <Link to={linkWithSearch("/app")} rel="home" onClick={scrollToTop}>
                Home
              </Link>
              <Link to={linkWithSearch("/app/pricing")} onClick={scrollToTop}>
                Pricing
              </Link>
              <Link to={linkWithSearch("/app/contact")} onClick={scrollToTop}>
                Contact
              </Link>
            </div>
          ) : null}
          <Outlet />
        </ShopifyAppProvider>
      </PolarisAppProvider>
    </I18nextProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
