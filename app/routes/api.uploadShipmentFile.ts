import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";

// セキュリティ: 許可するMIMEタイプと拡張子を定義
const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain'
];

const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'txt'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// export const config = {
//   api: { bodyParser: false }, // Remixでは不要。Next.js専用なので削除OK
// };

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log('uploadShipmentFile API called'); // Debug log
  
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    // FormDataを使用してファイルを取得
    const formData = await request.formData();
    console.log('FormData parsed successfully'); // Debug log

    const si_number = formData.get('si_number') as string;
    const type = formData.get('type') as string;
    const file = formData.get('file') as File;

    console.log('Extracted fields:', { 
      si_number, 
      type, 
      fileName: file?.name,
      fileSize: file?.size 
    }); // Debug log

    if (!si_number || !type || !file) {
      console.error('Missing required fields:', { 
        si_number: !!si_number, 
        type: !!type, 
        file: !!file 
      });
      return json({ error: "必須フィールドが不足しています" }, { status: 400 });
    }

    // ファイルサイズチェック
    if (file.size === 0) {
      console.error('Empty file detected');
      return json({ error: "空のファイルはアップロードできません" }, { status: 400 });
    }
    
    if (file.size > MAX_FILE_SIZE) {
      console.error('File too large:', { 
        fileSize: file.size, 
        maxSize: MAX_FILE_SIZE 
      });
      return json({ 
        error: `ファイルサイズは最大10MBまでです（現在のサイズ: ${(file.size / (1024 * 1024)).toFixed(1)}MB）` 
      }, { status: 400 });
    }
    
    // ファイル形式チェック
    const fileExt = file.name.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = file.type;

    console.log('File details:', { 
      fileName: file.name, 
      fileExt, 
      mimeType, 
      fileSize: file.size 
    }); // Debug log

    if (!ALLOWED_EXTENSIONS.includes(fileExt) || !ALLOWED_MIME_TYPES.includes(mimeType)) {
      console.error('Invalid file type:', { 
        fileExt, 
        mimeType, 
        allowed: ALLOWED_EXTENSIONS 
      });
      return json({ error: "許可されていないファイル形式です" }, { status: 400 });
    }

    // パスのバリデーション（ディレクトリトラバーサル防止）
    if (/[\\/:*?"<>|]/.test(si_number) || /[\\/:*?"<>|]/.test(type)) {
      console.error('Invalid path characters detected');
      return json({ error: "不正なファイルパスです" }, { status: 400 });
    }

    const filePath = `${si_number}/${type}.${fileExt}`;
    console.log('File path:', filePath); // Debug log

    // ファイルをArrayBufferに変換
    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    
    console.log('File converted to Uint8Array, size:', uint8Array.length); // Debug log

    console.log('Uploading to Supabase storage...'); // Debug log
    
    // Supabaseクライアントの初期化を確認
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('Missing Supabase environment variables');
      return json({ error: "Supabase設定エラー" }, { status: 500 });
    }

    console.log('Supabase configuration:', {
      url: process.env.SUPABASE_URL ? 'Set' : 'Missing',
      key: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'Set' : 'Missing'
    });

    // ファイルをSupabase Storageにアップロード
    const { error: uploadError } = await supabase.storage
      .from("shipment-files")
      .upload(filePath, uint8Array, { 
        upsert: true,
        contentType: mimeType
      });

    if (uploadError) {
      console.error('Supabase upload error:', uploadError);
      console.error('Upload details:', {
        bucket: 'shipment-files',
        filePath,
        fileSize: uint8Array.length,
        contentType: mimeType
      });
      return json({ 
        error: `アップロードエラー: ${uploadError.message}`,
        details: uploadError,
        filePath,
        fileSize: uint8Array.length
      }, { status: 500 });
    }

    console.log('File uploaded successfully, generating signed URL...'); // Debug log
    
    // 署名付きURLを生成（7日間有効）
    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from("shipment-files")
      .createSignedUrl(filePath, 7 * 24 * 60 * 60); // 7日間

    if (signedUrlError) {
      console.error('Signed URL generation error:', signedUrlError);
      return json({ 
        error: `署名付きURL生成エラー: ${signedUrlError.message}`,
        filePath: filePath
      }, { status: 500 });
    }

    if (!signedUrlData?.signedUrl) {
      console.error('No signed URL returned');
      return json({ 
        error: "署名付きURLが生成されませんでした",
        filePath: filePath
      }, { status: 500 });
    }

    console.log('Signed URL generated successfully'); // Debug log
    
    // ファイルパスと署名付きURLの両方を返す
    return json({ 
      filePath: filePath,
      signedUrl: signedUrlData.signedUrl,
      message: 'ファイルが正常にアップロードされました'
    });

  } catch (error) {
    console.error('Unexpected error in uploadShipmentFile:', error);
    return json({ 
      error: "ファイルアップロード中にエラーが発生しました",
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
};