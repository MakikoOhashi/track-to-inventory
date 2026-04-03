import { data as json, type LoaderFunctionArgs } from "react-router";
import { warmOcrBackend } from "~/lib/ocrBackend.server";

export const loader = async (_args: LoaderFunctionArgs) => {
  try {
    const result = await warmOcrBackend();
    return json(result);
  } catch (error) {
    console.error("OCR health check failed:", error);
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "OCR health check failed",
      },
      { status: 502 },
    );
  }
};

