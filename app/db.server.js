// Prisma client shared by the whole server. Connects to Postgres through the pg driver adapter
// using DATABASE_URL. In development the client is cached on `global` so hot reloads do not
// open extra connections.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient({ adapter });
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient({ adapter });

export default prisma;
