import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

// データベース接続のデバッグログ
console.log('Database Configuration:');
console.log('- DATABASE_URL exists:', !!process.env.DATABASE_URL);
console.log('- NODE_ENV:', process.env.NODE_ENV);

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient({
      log: ['query', 'info', 'warn', 'error'],
    });
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient({
  log: ['error'],
});

// データベース接続テスト
prisma.$connect()
  .then(() => {
    console.log('✅ Database connected successfully');
  })
  .catch((error) => {
    console.error('❌ Database connection failed:', error);
  });

export default prisma;

declare global {
  interface Window {
    grecaptcha: {
      execute: (siteKey: string, options: { action: string }) => Promise<string>;
      render: (...args: any[]) => any;
      getResponse: (...args: any[]) => any;
      reset: (...args: any[]) => any;
    };
  }
}
export {};