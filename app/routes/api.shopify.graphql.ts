import { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin } = await authenticate.admin(request);
    
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // JSON形式のリクエストボディを解析
    const requestBody = await request.json();
    const { query, variables } = requestBody;
    
    console.log("GraphQL Query:", query);
    console.log("GraphQL Variables:", variables);
    
    const response = await admin.graphql(query, { variables });
    const data = await response.json();
    
    console.log("GraphQL Response:", JSON.stringify(data, null, 2));
    
    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("GraphQL Error:", error);
    return new Response(JSON.stringify({ 
      error: "GraphQL request failed",
      details: error instanceof Error ? error.message : "Unknown error"
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
};