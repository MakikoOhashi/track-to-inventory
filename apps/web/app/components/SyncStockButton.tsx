import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";

export function SyncStockButton() {
  const fetcher = useFetcher();
  const { t } = useTranslation();

  return (
    <fetcher.Form method="post" action="/api/sync-stock">
      <button type="submit" disabled={fetcher.state === "submitting"}>
        {fetcher.state === "submitting"
          ? t("common.status.syncing")
          : t("common.buttons.syncShopify")}
      </button>
      {fetcher.data && (fetcher.data as any).results && (
        <div>{t("common.messages.syncComplete")}</div>
      )}
    </fetcher.Form>
  );
}
