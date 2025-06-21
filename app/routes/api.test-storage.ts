import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from '@supabase/supabase-js';

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log('Test storage API called');
  
  try {
    // 環境変数の確認
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      return json({ 
        error: 'Missing environment variables',
        urlExists: !!supabaseUrl,
        keyExists: !!supabaseKey
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
        error: 'Failed to list buckets',
        details: bucketError.message
      }, { status: 500 });
    }
    
    console.log('Available buckets:', buckets);
    
    // shipment-filesバケットの存在確認
    const shipmentFilesBucket = buckets.find(bucket => bucket.name === 'shipment-files');
    
    if (!shipmentFilesBucket) {
      console.error('shipment-files bucket not found');
      return json({ 
        error: 'shipment-files bucket not found',
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
    
    return json({ 
      success: true, 
      message: 'Storage connection successful',
      bucket: shipmentFilesBucket,
      fileCount: files?.length || 0,
      sampleFiles: files?.slice(0, 5) || []
    });
    
  } catch (error) {
    console.error('Storage test error:', error);
    return json({ 
      error: 'Storage test failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}; 