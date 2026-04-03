import { data as json, type ActionFunctionArgs } from "react-router";
import { convertPdfToImage } from "~/lib/ocrBackend.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const result = await convertPdfToImage(request);
    return json(result);
  } catch (e) {
    console.error(e);
    const message = e instanceof Error ? e.message : "PDF→画像変換に失敗しました";
    return json({ error: message }, { status: message.includes("アップロード") ? 400 : 500 });
  }
};
