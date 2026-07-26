import type { SupabaseShipmentRow } from "~/lib/d1/shipmentsBackfill.server";

export type DeleteShipmentMessages = {
  siNumberRequired: string;
  shipmentNotFound: string;
  databaseError: string;
  deleteFailed: string;
  serverError: string;
  success: string;
  authFailed: string;
};

export type DeleteShipmentPrimaryGateway = {
  find: (
    shopId: string,
    siNumber: string,
  ) => Promise<{ data: SupabaseShipmentRow | null; error: unknown | null }>;
  delete: (
    shopId: string,
    siNumber: string,
  ) => Promise<{ error: unknown | null }>;
};

export type DeleteShipmentFlowDependencies = {
  requireAdminShop: (
    request: Request,
  ) => Promise<{ ok: true; shop: string } | { ok: false; status: 401 | 403 }>;
  createPrimaryGateway: () => DeleteShipmentPrimaryGateway;
  checkDeleteUsageLimit: (shopId: string, limit: number) => Promise<void>;
  recordDeleteUsage: (params: { shopId: string }) => Promise<void>;
  scheduleShadowTask: (task: () => Promise<void>) => void;
  compareShadowRead: (params: {
    shopId: string;
    siNumber: string;
    primaryRow: SupabaseShipmentRow | null;
  }) => Promise<void>;
  deleteShadow: (params: {
    operation: "delete";
    shopId: string;
    siNumber: string;
  }) => Promise<void>;
};

export type DeleteShipmentFlowResult = {
  status: number;
  body: { error: string } | { success: true; message: string };
};

/**
 * Delete handler orchestration with injectable gateways for local tests.
 * Supabase remains the response authority; shadow tasks never decide the response.
 */
export async function executeDeleteShipmentFlow(params: {
  request: Request;
  messages: DeleteShipmentMessages;
  dependencies: DeleteShipmentFlowDependencies;
}): Promise<DeleteShipmentFlowResult> {
  const { request, messages, dependencies } = params;

  if (request.method !== "DELETE") {
    return { status: 405, body: { error: "Method not allowed" } };
  }

  const auth = await dependencies.requireAdminShop(request);
  if (!auth.ok) {
    return { status: auth.status, body: { error: messages.authFailed } };
  }
  const shopId = auth.shop;

  try {
    const formData = await request.formData();
    const siNumber = (formData.get("siNumber") as string) || "";

    if (!siNumber) {
      return { status: 400, body: { error: messages.siNumberRequired } };
    }

    const primary = dependencies.createPrimaryGateway();
    const { data: existingShipment, error: checkError } = await primary.find(
      shopId,
      siNumber,
    );

    if (checkError) {
      return { status: 500, body: { error: messages.databaseError } };
    }

    dependencies.scheduleShadowTask(() =>
      dependencies.compareShadowRead({
        shopId,
        siNumber,
        primaryRow: existingShipment,
      }),
    );

    if (!existingShipment) {
      return { status: 404, body: { error: messages.shipmentNotFound } };
    }

    try {
      await dependencies.checkDeleteUsageLimit(shopId, 2);
    } catch {
      return { status: 403, body: { error: "DELETE_LIMIT_EXCEEDED" } };
    }

    const { error: deleteError } = await primary.delete(shopId, siNumber);
    if (deleteError) {
      return { status: 500, body: { error: messages.deleteFailed } };
    }

    dependencies.scheduleShadowTask(() =>
      dependencies.deleteShadow({
        operation: "delete",
        shopId,
        siNumber,
      }),
    );

    try {
      await dependencies.recordDeleteUsage({ shopId });
    } catch {
      // Usage failure must not undo a successful primary delete.
    }

    return {
      status: 200,
      body: { success: true, message: messages.success },
    };
  } catch {
    return { status: 500, body: { error: messages.serverError } };
  }
}
