import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import formidable from "formidable";
import fs from "fs";

// セキュリティ: 許可するMIMEタイプと拡張子を定義
const ALLOWED_MIME_TYPES = ["application/pdf", "image/png", "image/jpeg"];
const ALLOWED_EXTENSIONS = ["pdf", "png", "jpg", "jpeg"];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MBまで（Supabaseの設定に合わせる）

// export const config = {
//   api: { bodyParser: false }, // Remixでは不要。Next.js専用なので削除OK
// };

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

// formidable.parse を Promise 化
function parseForm(request: Request): Promise<{ fields: formidable.Fields; files: formidable.Files }> {
  return new Promise((resolve, reject) => {
    const form = formidable({
      maxFileSize: MAX_FILE_SIZE,
      allowEmptyFiles: false,
      multiples: false,
    });
    form.parse(request as any, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log('uploadShipmentFile API called'); // Debug log
  
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let fields: formidable.Fields, files: formidable.Files;
  try {
    ({ fields, files } = await parseForm(request));
    console.log('Form parsed successfully'); // Debug log
  } catch (err) {
    console.error('Form parse error:', err);
    return json({ error: "Form parse error" }, { status: 400 });
  }

  const si_number = Array.isArray(fields.si_number) ? fields.si_number[0] : fields.si_number;
  const type = Array.isArray(fields.type) ? fields.type[0] : fields.type;
  const file = Array.isArray(files.file) ? files.file[0] : files.file;

  console.log('Extracted fields:', { si_number, type, fileName: file?.originalFilename }); // Debug log

  if (!si_number || !type || !file) {
    console.error('Missing required fields:', { si_number: !!si_number, type: !!type, file: !!file });
    return json({ error: "missing fields" }, { status: 400 });
  }

  const originalFilename = file.originalFilename || "";
  const fileExt = originalFilename.split(".").pop()?.toLowerCase() ?? "";
  const mimeType: string = file.mimetype ?? "";
  const fileSize: number = file.size ?? 0;

  console.log('File details:', { originalFilename, fileExt, mimeType, fileSize }); // Debug log

  if (!ALLOWED_EXTENSIONS.includes(fileExt) || !ALLOWED_MIME_TYPES.includes(mimeType)) {
    console.error('Invalid file type:', { fileExt, mimeType, allowed: ALLOWED_EXTENSIONS });
    return json({ error: "許可されていないファイル形式です" }, { status: 400 });
  }
  if (fileSize === 0) {
    console.error('Empty file detected');
    return json({ error: "空のファイルはアップロードできません" }, { status: 400 });
  }
  if (fileSize > MAX_FILE_SIZE) {
    console.error('File too large:', { fileSize, maxSize: MAX_FILE_SIZE });
    return json({ error: `ファイルサイズは最大50MBまでです（現在のサイズ: ${(fileSize / (1024 * 1024)).toFixed(1)}MB）` }, { status: 400 });
  }

  // パスのバリデーション（ディレクトリトラバーサル防止）
  if (/[\\/:*?"<>|]/.test(si_number) || /[\\/:*?"<>|]/.test(type)) {
    console.error('Invalid path characters detected');
    return json({ error: "不正なファイルパスです" }, { status: 400 });
  }

  const filePath = `${si_number}/${type}.${fileExt}`;
  console.log('File path:', filePath); // Debug log

  let fileStream: fs.ReadStream;
  try {
    fileStream = fs.createReadStream(file.filepath);
    console.log('File stream created successfully'); // Debug log
  } catch (err) {
    console.error('File stream creation error:', err);
    return json({ error: "ファイルストリーム作成に失敗しました" }, { status: 500 });
  }
  
  console.log('Uploading to Supabase storage...'); // Debug log
  const { error: uploadError } = await supabase.storage
    .from("shipment-files")
    .upload(filePath, fileStream, { upsert: true });

  if (uploadError) {
    console.error('Supabase upload error:', uploadError);
    return json({ error: uploadError.message }, { status: 500 });
  }

  console.log('File uploaded successfully, getting public URL...'); // Debug log
  const { data } = supabase.storage
    .from("shipment-files")
    .getPublicUrl(filePath);

  console.log('Public URL generated:', data.publicUrl); // Debug log
  return json({ publicUrl: data.publicUrl });
};