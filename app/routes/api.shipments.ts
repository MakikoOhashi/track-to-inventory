//app/routes/api.shipments.ts
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop_id = url.searchParams.get("shop_id");

  if (!shop_id) {
    return json({ error: "shop_id is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('shipments')
    .select('*')
    .eq('shop_id', shop_id);

  if (error) {
    return json({ error: error.message }, { status: 500 });
  }
  return json({ data });
};