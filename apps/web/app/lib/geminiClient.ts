import { GEMINI_MODEL } from "../config/gemini";

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  error?: {
    message?: string;
    status?: string;
  };
};

function getGeminiApiKey() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set in environment variables.");
  }
  return apiKey;
}

function extractText(response: GeminiResponse): string {
  const text =
    response.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim() ?? "";

  if (!text) {
    throw new Error("Gemini API returned an empty response text.");
  }

  return text;
}

async function postGenerateContent(body: Record<string, unknown>): Promise<string> {
  const apiKey = getGeminiApiKey();
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  const payload = (await response.json()) as GeminiResponse;

  if (!response.ok) {
    const message = payload.error?.message || `Gemini API request failed with status ${response.status}`;
    throw new Error(message);
  }

  return extractText(payload);
}

export async function generateGeminiContent(prompt: string): Promise<string> {
  return postGenerateContent({
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
    },
  });
}

export async function generateGeminiMultimodalContent(params: {
  prompt: string;
  mimeType: string;
  base64Data: string;
}): Promise<string> {
  return postGenerateContent({
    contents: [
      {
        role: "user",
        parts: [
          { text: params.prompt },
          {
            inlineData: {
              mimeType: params.mimeType,
              data: params.base64Data,
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
    },
  });
}
