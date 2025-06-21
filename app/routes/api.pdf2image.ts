import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { formidable } from "formidable";
import { fromBuffer } from "pdf2pic";
import fs from "fs";

// formidableのparseをPromise化
function parseForm(request: Request): Promise<{ fields: any; files: any }> {
  return new Promise((resolve, reject) => {
    const form = formidable({ keepExtensions: true });
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

  let fields: any, files: any;
  try {
    ({ fields, files } = await parseForm(request));
  } catch (err) {
    console.error(err);
    return json({ error: "ファイルアップロード失敗" }, { status: 500 });
  }

  const uploaded = files.file;
  const pdfFile = Array.isArray(uploaded) ? uploaded[0] : uploaded;

  if (!pdfFile || !pdfFile.filepath) {
    return json({ error: "PDFファイルがアップロードされていません" }, { status: 400 });
  }

  try {
    const pdfBuffer = fs.readFileSync(pdfFile.filepath);

    const convert = fromBuffer(pdfBuffer, {
      density: 200,
      format: "png",
      width: 1200,
      height: 1600,
      savePath: "./public/tmp",
      // convertPath: "/usr/local/bin/convert" // 必要なら有効化
    });

    const result = await convert(1); // 1ページ目のみ

    if (!result.path) {
      return json({ error: "画像パスが取得できませんでした" }, { status: 500 });
    }

    const imgPath = result.path.replace(/^.*\/public/, ""); // /tmp/xxx.png
    return json({ url: imgPath });
  } catch (e) {
    console.error(e);
    return json({ error: "PDF→画像変換に失敗しました" }, { status: 500 });
  }
};