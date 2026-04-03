import { authenticate } from "~/shopify.server";
import { createClient } from "@supabase/supabase-js";
import db from "../db.server";

// Supabaseクライアント初期化
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // Service Role Keyを必ず使う
);

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Shopifyセッション削除
  if (session) {
    await db.session.deleteMany({ where: { shop } });
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
        console.error("Supabase shipments取得エラー:", fetchError);
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
            console.error("Supabase Storage ファイル削除エラー:", deleteError);
          } else {
            console.log(`削除されたファイル数: ${uniqueFiles.length}`);
          }
        }
      }

      // 4. shipmentsテーブルからshop_idで削除
      const { error: deleteShipmentsError } = await supabase
        .from("shipments")
        .delete()
        .eq("shop_id", shop);

      if (deleteShipmentsError) {
        console.error("Supabase shipments削除エラー:", deleteShipmentsError);
      } else {
        console.log(`削除されたshipments数: ${shipments?.length || 0}`);
      }

    } catch (error) {
      console.error("Uninstall処理エラー:", error);
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
    console.error("URL解析エラー:", error);
    return null;
  }
}