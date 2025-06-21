import { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin } = await authenticate.admin(request);
    
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // JSON形式のリクエストボディを解析
    let requestBody;
    try {
      requestBody = await request.json();
    } catch (parseError) {
      return new Response(JSON.stringify({ 
        error: "Invalid JSON in request body",
        details: parseError instanceof Error ? parseError.message : "Unknown parsing error"
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { query, variables } = requestBody;
    
    // バリデーション
    if (!query || typeof query !== 'string') {
      return new Response(JSON.stringify({ 
        error: "GraphQL query is required and must be a string"
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    
    console.log("GraphQL Query:", query);
    console.log("GraphQL Variables:", variables);
    
    const response = await admin.graphql(query, { variables });
    const data = await response.json() as { data?: any; errors?: any[] };
    
    console.log("GraphQL Response:", JSON.stringify(data, null, 2));
    
    // GraphQLエラーチェック
    if (data.errors && Array.isArray(data.errors) && data.errors.length > 0) {
      console.error("GraphQL Errors:", data.errors);
      return new Response(JSON.stringify({ 
        error: "GraphQL query failed",
        graphQLErrors: data.errors,
        data: data.data // 部分的なデータがある場合は返す
      }), {
        status: 200, // GraphQLエラーでもHTTP 200を返す（GraphQL仕様）
        headers: { "Content-Type": "application/json" },
      });
    }
    
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