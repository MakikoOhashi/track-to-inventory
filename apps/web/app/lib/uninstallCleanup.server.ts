import sessionStorage from "~/sessionStorage.server";

export type UninstallCleanupDependencies = {
  findSessionsByShop: (shop: string) => Promise<Array<{ id: string }>>;
  deleteSessions: (ids: string[]) => Promise<boolean>;
};

/** Uninstall invalidates authentication only; D1 business data is retained. */
export async function cleanupUninstall(
  shop: string,
  dependencies: UninstallCleanupDependencies = {
    findSessionsByShop: (value) => sessionStorage.findSessionsByShop(value),
    deleteSessions: (ids) => sessionStorage.deleteSessions(ids),
  },
): Promise<void> {
  if (!shop) return;

  const sessions = await dependencies.findSessionsByShop(shop);
  if (sessions.length > 0) {
    await dependencies.deleteSessions(sessions.map((session) => session.id));
  }

}
