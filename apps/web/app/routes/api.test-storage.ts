import { data as json, type ActionFunctionArgs } from "react-router";
import { createSupabaseAdminClient } from "~/lib/supabase.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  
  try {
    const supabase = createSupabaseAdminClient();
    
    // バケット一覧を取得
    const { data: buckets, error: bucketError } = await supabase.storage.listBuckets();
    
    if (bucketError) {
      return json({ 
        error: 'ストレージバケット取得エラー',
        details: bucketError.message
      }, { status: 500 });
    }
    
    // shipment-filesバケットの存在確認
    const shipmentFilesBucket = buckets.find(bucket => bucket.name === 'shipment-files');
    
    if (!shipmentFilesBucket) {
      return json({ 
        error: 'shipment-filesバケットが見つかりません',
        availableBuckets: buckets.map(b => b.name)
      }, { status: 404 });
    }
    
    // バケット内のファイル一覧を取得（テスト用）
    const { data: files, error: fileError } = await supabase.storage
      .from('shipment-files')
      .list('', { limit: 10 });
    
    if (fileError) {
      return json({ 
        error: 'Failed to list files in bucket',
        details: fileError.message,
        bucketExists: true
      }, { status: 500 });
    }
    
    // テストファイルのアップロード
    const testContent = "test file content";
    const testFileName = `test-${Date.now()}.txt`;
    
    const { error: uploadError } = await supabase.storage
      .from('shipment-files')
      .upload(testFileName, testContent, {
        contentType: 'text/plain',
        upsert: false
      });

    if (uploadError) {
      return json({ 
        error: 'テストファイルアップロードエラー',
        details: uploadError.message 
      }, { status: 500 });
    }

    // テストファイルの削除
    const { error: deleteError } = await supabase.storage
      .from('shipment-files')
      .remove([testFileName]);

    if (deleteError) {
    }

    return json({ 
      success: true, 
      message: 'Supabase Storage接続成功',
      bucket: shipmentFilesBucket,
      fileCount: files?.length || 0,
      sampleFiles: files?.slice(0, 5) || [],
      uploadTest: 'passed'
    });
    
  } catch (error) {
    return json({ 
      error: '予期しないエラー',
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}; 
