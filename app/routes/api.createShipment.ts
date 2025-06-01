// app/routes/api.createShipment.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

// Supabaseクライアントの初期化
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // サーバーサイドではSERVICE_ROLE_KEYを使用


if (!supabaseUrl || !supabaseKey) {
  throw new Error("Supabase環境変数が設定されていません");
}

const supabase = createClient(supabaseUrl, supabaseKey);

type ShipmentItem = {
  name: string;
  quantity: number | string;
  product_code?: string;
  unit_price?: string;
};

type Shipment = {
  si_number: string;
  supplier_name: string;
  transport_type?: string;
  items: ShipmentItem[];
  status?: string;
  etd?: string;
  eta?: string;
  delayed?: boolean;
  clearance_date?: string;
  arrival_date?: string;
  memo?: string;
  shop_id?: string;
  is_archived?: boolean;
};


export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // CORS設定
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('📦 受信データ:', req.body);

    const shipment: Shipment = req.body.shipment; // Modal.jsxと同じ形式でデータを受け取る

    // バリデーション
    if (!shipment.si_number || !shipment.supplier_name) {
      return res.status(400).json({ error: 'SI番号と仕入先は必須項目です' });
    }

    // メインデータをshipmentsテーブルに保存（Modal.jsxと同じテーブル構造）
    const { data: shipmentData, error: shipmentError } = await supabase
      .from('shipments') // Modal.jsxと同じテーブル名
      .insert([
        {
        ...shipment,
        status: shipment.status || "SI発行済",
        delayed: shipment.delayed ?? false,
        is_archived: shipment.is_archived ?? false,
        }
      ])
      .select()
      .single();

    if (shipmentError) {
      console.error('❌ Shipment insert error:', shipmentError);
      console.error('❌ Error details:', {
        message: shipmentError.message,
        details: shipmentError.details,
        hint: shipmentError.hint,
        code: shipmentError.code
      });
      return res.status(500).json({ 
        error: 'データの保存に失敗しました',
        details: shipmentError.message,
        hint: shipmentError.hint
      });
    }

    console.log('✅ 保存成功:', shipmentData);

    // 成功レスポンス
    res.status(200).json({ 
      id: shipmentData.id, 
      message: 'データが正常に保存されました',
      data: shipmentData
    });

  } catch (error: any) {
    console.error('❌ Unexpected error in createShipment:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({ 
      error: 'サーバーエラーが発生しました',
      details: error.message 
    });
  }
}