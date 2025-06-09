import { useFetcher } from "@remix-run/react";

export function SyncStockButton() {
  const fetcher = useFetcher();

  return (
    <fetcher.Form method="post" action="/api/sync-stock">
      <button type="submit" disabled={fetcher.state === "submitting"}>
        {fetcher.state === "submitting" ? "同期中..." : "Shopify在庫と同期"}
      </button>
      {fetcher.data && (fetcher.data as any).results && (
        <div>同期完了！</div>
      )}
    </fetcher.Form>
  );
}