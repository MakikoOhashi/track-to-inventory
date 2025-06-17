import { PrismaClient } from "@prisma/client";


declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}
if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

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