import sessionStorage from "~/sessionStorage.server";
import { deleteNotionConnection } from "~/lib/notionConnection.server";

export type UninstallCleanupDependencies = {
  findSessionsByShop: (shop: string) => Promise<Array<{ id: string }>>;
  deleteSessions: (ids: string[]) => Promise<boolean>;
  deleteNotionConnection: (shop: string) => Promise<void>;
};

/** Uninstall invalidates authentication only; D1 business data is retained. */
export async function cleanupUninstall(
  shop: string,
  dependencies: UninstallCleanupDependencies = {
    findSessionsByShop: (value) => sessionStorage.findSessionsByShop(value),
    deleteSessions: (ids) => sessionStorage.deleteSessions(ids),
    deleteNotionConnection,
  },
): Promise<void> {
  if (!shop) return;

  const sessions = await dependencies.findSessionsByShop(shop);
  if (sessions.length > 0) {
    await dependencies.deleteSessions(sessions.map((session) => session.id));
  }

  // Notion is not a TrackToInventory feature; retain only the legacy cleanup boundary.
  try {
    await dependencies.deleteNotionConnection(shop);
  } catch {
    // Unrelated legacy metadata must not block the uninstall acknowledgement.
  }
}
