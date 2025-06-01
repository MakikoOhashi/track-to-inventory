//my-next-app>pages>api>shipments.js

import { createClient } from '@supabase/supabase-js';
import type { NextApiRequest, NextApiResponse } from 'next';

// サーバーサイド環境変数からキーを取得
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // クエリパラメータからshop_idを取得
  const { shop_id } = req.query;
  if (!shop_id) {
    res.status(400).json({ error: 'shop_id is required' });
    return;
  }

  // Supabaseでデータ取得
  const { data, error } = await supabase
    .from('shipments')
    .select('*')
    .eq('shop_id', shop_id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.status(200).json({ data });
}