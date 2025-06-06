import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from '@supabase/supabase-js';

// Remixでも process.env から取得でOK
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { shipment } = body;
  if (!shipment) return json({ error: 'missing shipment' }, { status: 400 });

  // ファイルフィールドは除外（Supabaseのupsertに直接渡さない）
  const { invoiceFile, siFile, ...safeData } = shipment;

  const { data, error } = await supabase
    .from('shipments')
    .upsert([safeData]);
  if (error) return json({ error: error.message }, { status: 500 });
  return json({ data });
};