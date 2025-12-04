// @ts-ignore
import GoogleAI from "@google/genai";
import { GEMINI_MODEL } from "../config/gemini";

// APIキーの安全性確認
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error("GEMINI_API_KEY is not set in environment variables.");
}

const genAI = new GoogleAI({ apiKey });

// プロンプトからGeminiの応答テキストを取得
export async function generateGeminiContent(prompt: string): Promise<string> {
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: { responseMimeType: "application/json" },

  });
  const result = await model.generateContent(prompt);

  // 公式型ではresponse.text()は必ず存在
  return result.response.text();
}