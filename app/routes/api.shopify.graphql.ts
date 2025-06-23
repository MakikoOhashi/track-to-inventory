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
    const data = await response.json() as any;
    
    console.log("GraphQL Response:", JSON.stringify(data, null, 2));
    
    // GraphQLエラーの詳細なチェック
    if (data.errors && Array.isArray(data.errors)) {
      console.error("GraphQL Errors:", data.errors);
      
      // エラーメッセージを詳細に解析
      const errorMessages = data.errors.map((error: any) => {
        if (error.extensions && error.extensions.code) {
          return `${error.extensions.code}: ${error.message}`;
        }
        return error.message;
      }).join(', ');
      
      return new Response(JSON.stringify({ 
        errors: data.errors,
        error: `GraphQL errors: ${errorMessages}`,
        details: data.errors
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }
    
    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("GraphQL Error:", error);
    
    // 認証エラーの特別な処理
    if (error instanceof Error) {
      if (error.message.includes('authentication') || error.message.includes('session')) {
        return new Response(JSON.stringify({ 
          error: "Authentication failed",
          details: error.message
        }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
          },
        });
      }
    }
    
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