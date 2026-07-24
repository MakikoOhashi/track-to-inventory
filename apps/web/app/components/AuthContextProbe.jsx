import { useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { shopifyAuthenticatedFetch } from "~/lib/shopifyAuthenticatedFetch.client";

/**
 * Minimal Stage B+C vertical: Embedded App → idToken → GET /api/auth-context.
 * Does not fall back to query shop when token acquisition fails.
 */
export default function AuthContextProbe() {
  const shopify = useAppBridge();
  const [status, setStatus] = useState("pending");

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      try {
        const response = await shopifyAuthenticatedFetch(shopify, "/api/auth-context", {
          method: "GET",
        });

        if (cancelled) return;

        if (!response.ok) {
          setStatus(`http_${response.status}`);
          return;
        }

        const payload = await response.json();
        if (cancelled) return;

        if (payload?.ok === true && typeof payload.shop === "string") {
          setStatus("ok");
          return;
        }

        setStatus("invalid_payload");
      } catch {
        if (!cancelled) {
          setStatus("failed");
        }
      }
    }

    probe();

    return () => {
      cancelled = true;
    };
  }, [shopify]);

  return (
    <span
      data-auth-context-status={status}
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        overflow: "hidden",
        clip: "rect(0 0 0 0)",
      }}
      aria-hidden="true"
    />
  );
}
