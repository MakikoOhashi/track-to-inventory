import { data as json, type ActionFunctionArgs } from "react-router";
import { createSupabaseAdminClient } from "~/lib/supabase.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  
  try {
    const supabase = createSupabaseAdminClient();
    
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
