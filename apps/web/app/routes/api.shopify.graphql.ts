import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "~/shopify.server";

type GraphQLResponse = {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message?: string; extensions?: { code?: string } }> | null;
  [key: string]: unknown;
};

function hasUserErrors(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.userErrors) && record.userErrors.length > 0) {
    return true;
  }

  return Object.values(record).some((entry) => hasUserErrors(entry));
}

export const action = async ({ request }: ActionFunctionArgs) => {
  let admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"] | undefined;

  try {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const requestBody = await request.json();
    const query = requestBody?.query;
    const variables = requestBody?.variables;
    const shopIdFromQuery = url.searchParams.get("shop_id") || "";
    const shopIdFromBody = typeof requestBody?.shop_id === "string" ? requestBody.shop_id : "";
    const shopId = shopIdFromQuery || shopIdFromBody;

    if (shopId) {
      const unauthenticatedAdmin = await unauthenticated.admin(shopId);
      admin = unauthenticatedAdmin.admin;
    } else {
      ({ admin } = await authenticate.admin(request));
    }

    const response = await admin.graphql(query, { variables });
    const data = (await response.json()) as GraphQLResponse;

    if (Array.isArray(data.errors) && data.errors.length > 0) {
      const errorMessages = data.errors
        .map((error) => {
          if (error.extensions?.code) {
            return `${error.extensions.code}: ${error.message ?? "Unknown error"}`;
          }
          return error.message ?? "Unknown error";
        })
        .join(", ");

      return json(
        {
          errors: data.errors,
          error: `GraphQL errors: ${errorMessages}`,
          details: data.errors,
        },
        { status: 400 },
      );
    }

    if (hasUserErrors(data)) {
      return json(
        {
          data: data.data,
          userErrors: true,
          message: "GraphQL request completed with user errors",
        },
        { status: 200 },
      );
    }

    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    if (error instanceof Response) {
      const responseText = await error.clone().text().catch(() => "");

      if (error.status >= 300 && error.status < 400) {
        return json(
          {
            error: "Authentication failed",
            details: responseText || error.statusText || "Redirect returned from Shopify auth",
          },
          { status: 401 },
        );
      }

      return new Response(responseText || error.statusText, {
        status: error.status,
        headers: {
          "Content-Type": error.headers.get("Content-Type") || "text/plain; charset=utf-8",
        },
      });
    }

    if (error instanceof Error) {
      if (
        error.name === "SessionNotFoundError" ||
        error.message.includes("Could not find a session") ||
        error.message.includes("authentication") ||
        error.message.includes("session")
      ) {
        return json(
          {
            error: "Authentication failed",
            details: error.message,
          },
          { status: 401 },
        );
      }
    }

    return json(
      {
        error: "GraphQL request failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
};
