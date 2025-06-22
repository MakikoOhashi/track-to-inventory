import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from '@supabase/supabase-js';

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log('Test storage API called');
  
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
    
    // バケット一覧を取得
    console.log('Fetching bucket list...');
    const { data: buckets, error: bucketError } = await supabase.storage.listBuckets();
    
    if (bucketError) {
      console.error('Bucket list error:', bucketError);
      return json({ 
        error: 'ストレージバケット取得エラー',
        details: bucketError.message
      }, { status: 500 });
    }
    
    console.log('Available buckets:', buckets);
    
    // shipment-filesバケットの存在確認
    const shipmentFilesBucket = buckets.find(bucket => bucket.name === 'shipment-files');
    
    if (!shipmentFilesBucket) {
      console.error('shipment-files bucket not found');
      return json({ 
        error: 'shipment-filesバケットが見つかりません',
        availableBuckets: buckets.map(b => b.name)
      }, { status: 404 });
    }
    
    console.log('shipment-files bucket found:', shipmentFilesBucket);
    
    // バケット内のファイル一覧を取得（テスト用）
    const { data: files, error: fileError } = await supabase.storage
      .from('shipment-files')
      .list('', { limit: 10 });
    
    if (fileError) {
      console.error('File list error:', fileError);
      return json({ 
        error: 'Failed to list files in bucket',
        details: fileError.message,
        bucketExists: true
      }, { status: 500 });
    }
    
    console.log('Files in bucket:', files);
    
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
      console.warn("Test file cleanup failed:", deleteError);
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
    console.error('Storage test error:', error);
    return json({ 
      error: '予期しないエラー',
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}; 