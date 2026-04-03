import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

// Keep session storage behind one module so we can swap Prisma out later
// without reworking the Shopify app bootstrap.
const sessionStorage = new PrismaSessionStorage(prisma);

export default sessionStorage;
