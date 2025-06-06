import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import formidable from "formidable";
import fs from "fs";

export const config = {
  api: { bodyParser: false }, // Remixでは不要。Next.js専用なので削除OK
};

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

// formidable.parse を Promise 化
function parseForm(request: Request): Promise<{ fields: formidable.Fields; files: formidable.Files }> {
  return new Promise((resolve, reject) => {
    const form = formidable();
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
    return json({ error: "Form parse error" }, { status: 500 });
  }

  const si_number = Array.isArray(fields.si_number) ? fields.si_number[0] : fields.si_number;
  const type = Array.isArray(fields.type) ? fields.type[0] : fields.type;
  const file = Array.isArray(files.file) ? files.file[0] : files.file;

  if (!si_number || !type || !file) {
    return json({ error: "missing fields" }, { status: 400 });
  }

  const originalFilename = file.originalFilename || "";
  const fileExt = originalFilename.split(".").pop();
  const filePath = `${si_number}/${type}.${fileExt}`;

  const fileStream = fs.createReadStream(file.filepath);

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