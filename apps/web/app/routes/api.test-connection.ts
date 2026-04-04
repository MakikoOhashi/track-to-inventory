import { data as json, type ActionFunctionArgs } from "react-router";
import { createClient } from '@supabase/supabase-js';

export const action = async ({ request }: ActionFunctionArgs) => {
  
  try {
    // 環境変数の確認
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
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
      return json({ 
        error: 'データベース接続エラー',
        details: error.message
      }, { status: 500 });
    }
    return json({ 
      success: true, 
      message: 'Supabase接続成功',
      data: data
    });
    
  } catch (error) {
    return json({ 
      error: '予期しないエラー',
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}; 
