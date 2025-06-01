import { createClient } from '@supabase/supabase-js';
import type { NextApiRequest, NextApiResponse } from 'next';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  const { shipment } = req.body;
  if (!shipment) return res.status(400).json({ error: 'missing shipment' });

  const { invoiceFile, siFile, ...safeData } = shipment;
  const { data, error } = await supabase
    .from('shipments')
    .upsert([safeData]);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ data });
}