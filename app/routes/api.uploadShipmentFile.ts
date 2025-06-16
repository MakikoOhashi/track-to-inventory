import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import formidable from "formidable";
import fs from "fs";

// セキュリティ: 許可するMIMEタイプと拡張子を定義
const ALLOWED_MIME_TYPES = ["application/pdf", "image/png", "image/jpeg"];
const ALLOWED_EXTENSIONS = ["pdf", "png", "jpg", "jpeg"];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MBまで

// export const config = {
//   api: { bodyParser: false }, // Remixでは不要。Next.js専用なので削除OK
// };

const supabase = createClient(
  process.env.SUPABASE_URL as string,
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
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let fields: formidable.Fields, files: formidable.Files;
  try {
    ({ fields, files } = await parseForm(request));
  } catch (err) {
    return json({ error: "Form parse error" }, { status: 400 });
  }

  const si_number = Array.isArray(fields.si_number) ? fields.si_number[0] : fields.si_number;
  const type = Array.isArray(fields.type) ? fields.type[0] : fields.type;
  const file = Array.isArray(files.file) ? files.file[0] : files.file;

  if (!si_number || !type || !file) {
    return json({ error: "missing fields" }, { status: 400 });
  }

  const originalFilename = file.originalFilename || "";
  const fileExt = originalFilename.split(".").pop()?.toLowerCase() ?? "";
  const mimeType: string = file.mimetype ?? "";
  const fileSize: number = file.size ?? 0;

  if (!ALLOWED_EXTENSIONS.includes(fileExt) || !ALLOWED_MIME_TYPES.includes(mimeType)) {
    return json({ error: "許可されていないファイル形式です" }, { status: 400 });
  }
  if (fileSize === 0) {
    return json({ error: "空のファイルはアップロードできません" }, { status: 400 });
  }
  if (fileSize > MAX_FILE_SIZE) {
    return json({ error: `ファイルサイズは最大${MAX_FILE_SIZE / (1024 * 1024)}MBまでです` }, { status: 400 });
  }

  // パスのバリデーション（ディレクトリトラバーサル防止）
  if (/[\\/:*?"<>|]/.test(si_number) || /[\\/:*?"<>|]/.test(type)) {
    return json({ error: "不正なファイルパスです" }, { status: 400 });
  }


  const filePath = `${si_number}/${type}.${fileExt}`;

  let fileStream: fs.ReadStream;
  try {
    fileStream = fs.createReadStream(file.filepath);
  } catch (err) {
    return json({ error: "ファイルストリーム作成に失敗しました" }, { status: 500 });
  }
  
  const { error: uploadError } = await supabase.storage
    .from("shipment-files")
    .upload(filePath, fileStream, { upsert: true });

  if (uploadError) {
    return json({ error: uploadError.message }, { status: 500 });
  }

  const { data } = supabase.storage
    .from("shipment-files")
    .getPublicUrl(filePath);

  return json({ publicUrl: data.publicUrl });
};