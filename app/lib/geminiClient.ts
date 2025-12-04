// @ts-ignore
import { GoogleGenAI } from "@google/genai";
import { GEMINI_MODEL } from "../config/gemini";

// APIキーの安全性確認
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error("GEMINI_API_KEY is not set in environment variables.");
}

const genAI = new GoogleGenAI({ 
  apiKey: apiKey,
  apiBaseUrl: "https://generativelanguage.googleapis.com/v1" }as any);

// プロンプトからGeminiの応答テキストを取得
export async function generateGeminiContent(prompt: string): Promise<string> {
  const result = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: { responseMimeType: "application/json" },

  });
  if (result.text === undefined) {
        throw new Error("Gemini APIからの応答テキストが空でした。");
    }

  return result.text;
}