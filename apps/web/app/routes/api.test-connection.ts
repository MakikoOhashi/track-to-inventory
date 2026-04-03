import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from '@supabase/supabase-js';

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log('Test connection API called');
  
  try {
    // 環境変数の確認
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    console.log('Environment variables:');
    console.log('- URL exists:', !!supabaseUrl);
    console.log('- Key exists:', !!supabaseKey);
    console.log('- Key length:', supabaseKey?.length);
    
    if (!supabaseUrl || !supabaseKey) {
      return json({ 
        error: 'Supabase環境変数が設定されていません',
        url: !!supabaseUrl,
        key: !!supabaseKey
      }, { status: 500 });
    }
    
    // Supabaseクライアントの初期化
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // 簡単なクエリで接続テスト
    const { data, error } = await supabase
      .from('shipments')
      .select('count')
      .limit(1);
    
    if (error) {
      console.error('Supabase query error:', error);
      return json({ 
        error: 'データベース接続エラー',
        details: error.message
      }, { status: 500 });
    }
    
    console.log('Connection test successful');
    return json({ 
      success: true, 
      message: 'Supabase接続成功',
      data: data
    });
    
  } catch (error) {
    console.error('Test connection error:', error);
    return json({ 
      error: '予期しないエラー',
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}; 