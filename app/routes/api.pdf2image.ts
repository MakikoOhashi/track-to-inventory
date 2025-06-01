import formidable, { File } from "formidable";
import { fromBuffer } from "pdf2pic";
import fs from "fs";
import type { NextApiRequest, NextApiResponse } from "next";

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const form = formidable({ keepExtensions: true });

  form.parse(req, async (err: any, fields: any, files: any) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "ファイルアップロード失敗" });
    }

    // ここでファイル情報の実態を確認
    const uploaded = files.file as File | File[] | undefined;
    // formidable v3系では配列で返る場合がある
    const pdfFile = Array.isArray(uploaded) ? uploaded[0] : uploaded;

    // もしpdfFileが無ければエラー
    if (!pdfFile || !pdfFile.filepath) {
      return res.status(400).json({ error: "PDFファイルがアップロードされていません" });
    }

    try {
      const pdfBuffer = fs.readFileSync(pdfFile.filepath);

      const convert = fromBuffer(pdfBuffer, {
        density: 200,
        format: "png",
        width: 1200,
        height: 1600,
        savePath: "./public/tmp",
          // ここを追加
        //convertPath: "/usr/local/bin/convert" // もしくは which convert の出力結果
      });

      const result = await convert(1); // 1ページ目のみ
      if (!result.path) {
        return res.status(500).json({ error: "画像パスが取得できませんでした" });
      }
      const imgPath = result.path.replace(/^.*\/public/, ""); // /tmp/xxx.png
      res.status(200).json({ url: imgPath });
    } catch (e) {
      console.error(e);
      // レスポンス返すのを忘れずに！
      res.status(500).json({ error: "PDF→画像変換に失敗しました" });
    }
  });
}