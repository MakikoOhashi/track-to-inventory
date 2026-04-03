import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "~/shopify.server";

// GraphQLレスポンスの詳細ログ出力関数
function logGraphQLResponse(step: string, data: any, variables?: any) {
  console.log(`\n=== ${step} GraphQL詳細ログ ===`);
  console.log("Variables:", JSON.stringify(variables, null, 2));
  console.log("Response:", JSON.stringify(data, null, 2));
  
  // GraphQL errorsの詳細表示
  if (data.errors && Array.isArray(data.errors)) {
    console.error(`\n${step} GraphQL Errors (${data.errors.length}件):`);
    data.errors.forEach((error: any, index: number) => {
      console.error(`  Error ${index + 1}:`, {
        message: error.message,
        extensions: error.extensions,
        path: error.path,
        locations: error.locations,
        code: error.extensions?.code,
        field: error.path?.join('.')
      });
    });
  }
  
  // userErrorsの再帰的検索と表示
  function findUserErrors(obj: any, path: string = ""): any[] {
    const userErrors: any[] = [];
    
    if (obj && typeof obj === 'object') {
      if (obj.userErrors && Array.isArray(obj.userErrors)) {
        console.error(`\n${step} userErrors found at ${path}:`);
        obj.userErrors.forEach((error: any, index: number) => {
          console.error(`  UserError ${index + 1}:`, {
            field: error.field,
            message: error.message
          });
        });
        userErrors.push(...obj.userErrors);
      }
      
      // 再帰的に検索
      for (const [key, value] of Object.entries(obj)) {
        if (value && typeof value === 'object') {
          userErrors.push(...findUserErrors(value, `${path}.${key}`));
        }
      }
    }
    
    return userErrors;
  }
  
  const allUserErrors = findUserErrors(data);
  if (allUserErrors.length > 0) {
    console.error(`\n${step} 全userErrors (${allUserErrors.length}件):`, allUserErrors);
  }
  
  console.log(`=== ${step} GraphQLログ終了 ===\n`);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  let admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"] | undefined;
  try {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const requestBody = await request.json();
    const { query, variables } = requestBody;
    const shopIdFromQuery = url.searchParams.get("shop_id") || "";
    const shopIdFromBody =
      typeof requestBody?.shop_id === "string" ? requestBody.shop_id : "";
    const shopId = shopIdFromQuery || shopIdFromBody;

    if (shopId) {
      const unauthenticatedAdmin = await unauthenticated.admin(shopId);
      admin = unauthenticatedAdmin.admin;
      console.log("GraphQL route using unauthenticated admin:", {
        shopId,
        hasAdmin: Boolean(admin),
      });
    } else {
      ({ admin } = await authenticate.admin(request));
      console.log("GraphQL route using authenticated admin context");
    }

    // JSON形式のリクエストボディを解析
    console.log("GraphQL Query:", query);
    console.log("GraphQL Variables:", variables);
    
    const response = await admin.graphql(query, { variables });
    const data = await response.json() as any;
    
    // 詳細なログ出力
    logGraphQLResponse("GraphQL API", data, variables);
    
    // GraphQLエラーの詳細なチェック
    if (data.errors && Array.isArray(data.errors) && data.errors.length > 0) {
      console.error("GraphQL Errors detected:", data.errors);
      
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
    
    // userErrorsのチェック
    function hasUserErrors(obj: any): boolean {
      if (obj && typeof obj === 'object') {
        if (obj.userErrors && Array.isArray(obj.userErrors) && obj.userErrors.length > 0) {
          return true;
        }
        
        // 再帰的に検索
        for (const value of Object.values(obj)) {
          if (value && typeof value === 'object' && hasUserErrors(value)) {
            return true;
          }
        }
      }
      return false;
    }
    
    if (hasUserErrors(data)) {
      console.error("UserErrors detected in response");
      return new Response(JSON.stringify({ 
        data: data.data,
        userErrors: true,
        message: "GraphQL request completed with user errors"
      }), {
        status: 200, // userErrorsは200で返す（ビジネスロジックエラー）
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
    console.error("GraphQL Error details:", {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
      stack: error instanceof Error ? error.stack : undefined,
      adminAvailable: Boolean(admin),
    });

    if (error instanceof Response) {
      const responseText = await error.clone().text().catch(() => "");
      console.error("GraphQL thrown Response:", {
        status: error.status,
        statusText: error.statusText,
        body: responseText,
      });

      if (error.status >= 300 && error.status < 400) {
        return new Response(JSON.stringify({
          error: "Authentication failed",
          details: responseText || error.statusText || "Redirect returned from Shopify auth",
        }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
          },
        });
      }

      return new Response(responseText || responseText, {
        status: error.status,
        headers: {
          "Content-Type": error.headers.get("Content-Type") || "text/plain; charset=utf-8",
        },
      });
    }
    
    // 認証エラーの特別な処理
    if (error instanceof Error) {
      if (error.name === "SessionNotFoundError" || error.message.includes("Could not find a session")) {
        return new Response(JSON.stringify({
          error: "Authentication failed",
          details: error.message,
        }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
          },
        });
      }

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
