import { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

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