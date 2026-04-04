import { authenticate } from "~/shopify.server";
import sessionStorage from "../sessionStorage.server";
import { createSupabaseAdminClient } from "~/lib/supabase.server";

export const action = async ({ request }) => {
  const supabase = createSupabaseAdminClient();
  const { shop, session, topic } = await authenticate.webhook(request);

  // Shopifyセッション削除
  if (shop) {
    const sessions = await sessionStorage.findSessionsByShop(shop);
    if (sessions.length > 0) {
      await sessionStorage.deleteSessions(sessions.map((storedSession) => storedSession.id));
    }
  }

  // Supabase shipmentsテーブルからshop_idで削除
  if (shop) {
    try {
      // 1. まず、該当shop_idのshipmentsを取得（ファイルパスを取得するため）
      const { data: shipments, error: fetchError } = await supabase
        .from("shipments")
        .select("si_number, invoice_url, pl_url, si_url, other_url")
        .eq("shop_id", shop);

      if (fetchError) {
      } else if (shipments && shipments.length > 0) {
        // 2. 各shipmentのファイルを削除
        const filesToDelete = [];
        
        shipments.forEach(shipment => {
          // 各ファイルURLからファイルパスを抽出
          if (shipment.invoice_url) {
            const path = extractFilePathFromUrl(shipment.invoice_url);
            if (path) filesToDelete.push(path);
          }
          if (shipment.pl_url) {
            const path = extractFilePathFromUrl(shipment.pl_url);
            if (path) filesToDelete.push(path);
          }
          if (shipment.si_url) {
            const path = extractFilePathFromUrl(shipment.si_url);
            if (path) filesToDelete.push(path);
          }
          if (shipment.other_url) {
            const path = extractFilePathFromUrl(shipment.other_url);
            if (path) filesToDelete.push(path);
          }
        });

        // 3. 重複を除去してファイルを削除
        const uniqueFiles = [...new Set(filesToDelete)];
        if (uniqueFiles.length > 0) {
          const { error: deleteError } = await supabase.storage
            .from("shipment-files")
            .remove(uniqueFiles);

          if (deleteError) {
          } else {
          }
        }
      }

      // 4. shipmentsテーブルからshop_idで削除
      const { error: deleteShipmentsError } = await supabase
        .from("shipments")
        .delete()
        .eq("shop_id", shop);

      if (deleteShipmentsError) {
      } else {
      }

    } catch (error) {
    }
  }

  return new Response();
};

// URLからファイルパスを抽出する関数
function extractFilePathFromUrl(url) {
  if (!url) return null;
  
  try {
    // Supabase Storage URLの形式: https://xxx.supabase.co/storage/v1/object/public/shipment-files/path/to/file
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    
    // shipment-filesの後のパスを取得
    const shipmentFilesIndex = pathParts.indexOf('shipment-files');
    if (shipmentFilesIndex !== -1 && shipmentFilesIndex + 1 < pathParts.length) {
      return pathParts.slice(shipmentFilesIndex + 1).join('/');
    }
    
    return null;
  } catch (error) {
    return null;
  }
}
