import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { si_number, type, url } = body;
  if (!si_number || !type || !url) {
    return json({ error: "missing fields" }, { status: 400 });
  }

  // パスは `${si_number}/${type}.拡張子` 形式前提
  const matches = url.match(/\/([^/]+)\.([a-zA-Z0-9]+)$/);
  let filePath = "";
  if (matches) {
    filePath = `${si_number}/${type}.${matches[2]}`;
  } else {
    return json({ error: "ファイルパス特定失敗" }, { status: 400 });
  }

  const { error } = await supabase
    .storage
    .from("shipment-files")
    .remove([filePath]);

  if (error) {
    return json({ error: error.message }, { status: 500 });
  }
  return json({ ok: true });
};