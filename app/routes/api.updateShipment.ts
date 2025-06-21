import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from '@supabase/supabase-js';

// Supabaseクライアントの初期化を改善
let supabase: any = null;

function initializeSupabase() {
  if (supabase) return supabase;
  
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase environment variables');
  }
  
  supabase = createClient(supabaseUrl, supabaseKey);
  return supabase;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log('updateShipment API called'); // Debug log
  
  if (request.method !== 'POST') {
    console.log('Method not allowed:', request.method);
    return new Response('Method Not Allowed', { status: 405 });
  }

  let body: any;
  try {
    body = await request.json();
    console.log('Request body received:', body); // Debug log
  } catch (error) {
    console.error('JSON parse error:', error);
    return json({ error: 'Invalid JSON' }, { status: 400 });
  }
  
  const { shipment } = body;
  if (!shipment) {
    console.error('Missing shipment data');
    return json({ error: 'missing shipment' }, { status: 400 });
  }

  console.log('Shipment data to save:', shipment); // Debug log

  // 環境変数の確認
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  console.log('Environment check:');
  console.log('- NEXT_PUBLIC_SUPABASE_URL exists:', !!supabaseUrl);
  console.log('- SUPABASE_SERVICE_ROLE_KEY exists:', !!supabaseKey);
  console.log('- SUPABASE_SERVICE_ROLE_KEY length:', supabaseKey?.length);
  
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase environment variables');
    return json({ error: 'Server configuration error' }, { status: 500 });
  }

  console.log('Supabase URL:', supabaseUrl); // Debug log (URLのみ)
  console.log('Supabase key exists:', !!supabaseKey); // Debug log (キーの存在のみ)

  // Supabaseクライアントの初期化
  let supabaseClient;
  try {
    supabaseClient = initializeSupabase();
    console.log('Supabase client initialized successfully');
  } catch (error) {
    console.error('Supabase initialization error:', error);
    return json({ error: 'Database connection failed' }, { status: 500 });
  }

  // ファイルURLフィールドは含める（Supabaseのupsertに渡す）
  // 実際のファイルオブジェクトがあれば除外するが、URL文字列は保存対象
  const { 
    invoiceFile, 
    siFile, 
    plFile, 
    otherFile,
    // ファイルオブジェクトのみを除外し、URLフィールドは保持
    ...safeData 
  } = shipment;

  console.log('Safe data to upsert:', safeData); // Debug log
  console.log('File URL fields included:', {
    invoice_url: safeData.invoice_url,
    si_url: safeData.si_url,
    pl_url: safeData.pl_url,
    other_url: safeData.other_url
  }); // Debug log

  try {
    const { data, error } = await supabaseClient
      .from('shipments')
      .upsert([safeData]);
      
    if (error) {
      console.error('Supabase upsert error:', error);
      return json({ error: error.message }, { status: 500 });
    }
    
    console.log('Upsert successful:', data);
    return json({ data });
  } catch (error) {
    console.error('Unexpected error in upsert:', error);
    return json({ error: 'Database operation failed' }, { status: 500 });
  }
};