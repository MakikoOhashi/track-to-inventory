import { renderToReadableStream } from "react-dom/server.browser";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";

export const streamTimeout = 2500;

export default async function handleRequest(
  request,
  responseStatusCode,
  responseHeaders,
  remixContext,
  _loadContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  const userAgent = request.headers.get("user-agent");
  const waitForAllReady = isbot(userAgent ?? "") || remixContext.isSpaMode;
  let didError = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), streamTimeout + 1000);

  try {
    const body = await renderToReadableStream(
      <ServerRouter context={remixContext} url={request.url} />,
      {
        signal: controller.signal,
        onError(error) {
          didError = true;
        },
      },
    );

    if (waitForAllReady && body.allReady) {
      await body.allReady;
    }

    clearTimeout(timeout);
    responseHeaders.set("Content-Type", "text/html");

    return new Response(body, {
      headers: responseHeaders,
      status: didError ? 500 : responseStatusCode,
    });
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}
