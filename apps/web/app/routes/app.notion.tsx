import {
  data as json,
  type LoaderFunctionArgs,
  useLoaderData,
  useLocation,
} from "react-router";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Page,
  Select,
  Text,
} from "@shopify/polaris";
import { useCallback, useEffect, useMemo, useState } from "react";
import { authenticate } from "~/shopify.server";
import {
  getNotionConnection,
  toPublicNotionConnection,
} from "~/lib/notionConnection.server";
import { isNotionOAuthConfigured } from "~/lib/notionOAuth.server";
import { isTokenEncryptionConfigured } from "~/lib/tokenEncryption.server";
import { normalizeShopDomain } from "~/utils/shopDomain";

type PublicConnection = ReturnType<typeof toPublicNotionConnection>;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  let shop = "";
  try {
    const auth = await authenticate.admin(request);
    shop = normalizeShopDomain(auth.session.shop);
  } catch {
    shop = "";
  }

  const conn = shop ? await getNotionConnection(shop) : null;
  return json({
    shop: shop || null,
    oauthConfigured: isNotionOAuthConfigured() && isTokenEncryptionConfigured(),
    connection: toPublicNotionConnection(conn),
  });
};

async function adminFetch(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  // App Bridge authenticated fetch is preferred; fall back to same-origin credentials
  if (typeof window !== "undefined" && (window as any).shopify?.idToken) {
    const token = await (window as any).shopify.idToken();
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(path, { ...init, headers });
}

export default function NotionConnectionPage() {
  const initial = useLoaderData<typeof loader>();
  const location = useLocation();
  const [connection, setConnection] = useState<PublicConnection>(initial.connection);
  const [pages, setPages] = useState<Array<{ id: string; title: string }>>([]);
  const [parentPageId, setParentPageId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const flash =
    params.get("notion") === "connected"
      ? "Notion connected."
      : params.get("notion_error")
        ? `Notion connection failed: ${params.get("notion_error")}`
        : null;

  const refreshStatus = useCallback(async () => {
    const res = await adminFetch("/api/notion/status");
    const data = await res.json();
    if (res.ok && data.connection) {
      setConnection(data.connection);
    }
  }, []);

  const loadPages = useCallback(async () => {
    setError(null);
    const res = await adminFetch("/api/notion/pages");
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Failed to list Notion pages");
      return;
    }
    setPages(data.pages || []);
    if (data.pages?.[0]?.id && !parentPageId) {
      setParentPageId(data.pages[0].id);
    }
  }, [parentPageId]);

  useEffect(() => {
    if (connection.connected) {
      void loadPages();
    }
  }, [connection.connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const connectHref = `/auth/notion${location.search || ""}`;

  const onProvision = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await adminFetch("/api/notion/provision", {
        method: "POST",
        body: JSON.stringify({ parent_page_id: parentPageId || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || data.error || "Provision failed");
      } else {
        setMessage(`Provision ${data.action}: database ${data.databaseId}`);
        await refreshStatus();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Provision failed");
    } finally {
      setBusy(false);
    }
  };

  const onSmoke = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await adminFetch("/api/notion/test-file-upload", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || data.error || "Smoke test failed");
      } else {
        setMessage(
          `File upload smoke ok: ${data.filename} (${data.size} bytes), cleanedUp=${data.cleanedUp}`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Smoke test failed");
    } finally {
      setBusy(false);
    }
  };

  const pageOptions = [
    { label: "Select a parent page", value: "" },
    ...pages.map((p) => ({ label: p.title, value: p.id })),
  ];

  return (
    <Page title="Notion connection" backAction={{ url: `/app${location.search}` }}>
      <BlockStack gap="400">
        {(flash || message) && (
          <Banner tone="success" onDismiss={() => setMessage(null)}>
            {message || flash}
          </Banner>
        )}
        {error && (
          <Banner tone="critical" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Connection status
            </Text>
            <Text as="p" variant="bodyMd">
              Shop: {initial.shop || "(not authenticated)"}
            </Text>
            <Text as="p" variant="bodyMd">
              OAuth configured: {initial.oauthConfigured ? "yes" : "no"}
            </Text>
            <Text as="p" variant="bodyMd">
              Status:{" "}
              {connection.connected
                ? `${connection.status} / ${connection.workspace_name || connection.workspace_id || "workspace"}`
                : "not connected"}
            </Text>
            {connection.connected && (
              <Text as="p" variant="bodyMd">
                Shipments DB: {connection.shipments_database_id || "(not provisioned)"}
              </Text>
            )}
            {connection.connected && connection.last_error && (
              <Text as="p" variant="bodyMd" tone="critical">
                Last error: {connection.last_error}
              </Text>
            )}
            {!connection.connected && (
              <Button url={connectHref} disabled={!initial.oauthConfigured || busy}>
                Connect Notion
              </Button>
            )}
            {connection.connected && (
              <Button url={connectHref} disabled={busy}>
                Reconnect Notion
              </Button>
            )}
          </BlockStack>
        </Card>

        {connection.connected && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Prepare Shipments database
              </Text>
              <Text as="p" variant="bodyMd">
                Creates or reuses &quot;TrackToInventory Shipments&quot; under the selected
                page. Does not migrate production shipments.
              </Text>
              <Select
                label="Parent page"
                options={pageOptions}
                value={parentPageId}
                onChange={setParentPageId}
              />
              <Button onClick={onProvision} loading={busy} variant="primary">
                Provision schema
              </Button>
              <Button
                onClick={onSmoke}
                loading={busy}
                disabled={!connection.shipments_database_id}
              >
                Run file upload smoke test
              </Button>
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
