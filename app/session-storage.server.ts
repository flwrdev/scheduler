// Postgres storage for Shopify sessions (the access tokens issued when the app is installed).
// Implements the store/load/delete/find-by-shop interface that shopifyApp expects and maps
// Shopify's Session object to the `Session` table in prisma/schema.prisma.

import { Session } from "@shopify/shopify-api";
import { Prisma, type PrismaClient } from "./generated/prisma/client";

const UNIQUE_KEY_CONSTRAINT_ERROR_CODE = "P2002";

export class PrismaSessionStorage {
  constructor(private prisma: PrismaClient) {}

  async storeSession(session: Session): Promise<boolean> {
    const data = this.sessionToRow(session);
    try {
      await this.prisma.session.upsert({
        where: { id: session.id },
        update: data,
        create: data,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_KEY_CONSTRAINT_ERROR_CODE
      ) {
        await this.prisma.session.upsert({
          where: { id: session.id },
          update: data,
          create: data,
        });
        return true;
      }
      throw error;
    }
    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const row = await this.prisma.session.findUnique({ where: { id } });
    if (!row) return undefined;
    return this.rowToSession(row);
  }

  async deleteSession(id: string): Promise<boolean> {
    try {
      await this.prisma.session.delete({ where: { id } });
    } catch {
      return true;
    }
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    await this.prisma.session.deleteMany({ where: { id: { in: ids } } });
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const sessions = await this.prisma.session.findMany({
      where: { shop },
      take: 25,
      orderBy: [{ expires: "desc" }],
    });
    return sessions.map((row) => this.rowToSession(row));
  }

  private sessionToRow(session: Session) {
    const sessionParams = session.toObject();
    return {
      id: session.id,
      shop: session.shop,
      state: session.state,
      isOnline: session.isOnline,
      scope: session.scope || null,
      expires: session.expires || null,
      accessToken: session.accessToken || "",
      userId: sessionParams.onlineAccessInfo?.associated_user.id ?? null,
      firstName:
        sessionParams.onlineAccessInfo?.associated_user.first_name ?? null,
      lastName:
        sessionParams.onlineAccessInfo?.associated_user.last_name ?? null,
      email: sessionParams.onlineAccessInfo?.associated_user.email ?? null,
      accountOwner:
        sessionParams.onlineAccessInfo?.associated_user.account_owner ??
        false,
      locale: sessionParams.onlineAccessInfo?.associated_user.locale ?? null,
      collaborator:
        sessionParams.onlineAccessInfo?.associated_user.collaborator ?? false,
      emailVerified:
        sessionParams.onlineAccessInfo?.associated_user.email_verified ??
        false,
      refreshToken: sessionParams.refreshToken ?? null,
      refreshTokenExpires: sessionParams.refreshTokenExpires ?? null,
    };
  }

  private rowToSession(row: {
    id: string;
    shop: string;
    state: string;
    isOnline: boolean;
    scope: string | null;
    expires: Date | null;
    accessToken: string;
    userId: bigint | null;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    accountOwner: boolean | null;
    locale: string | null;
    collaborator: boolean | null;
    emailVerified: boolean | null;
    refreshToken: string | null;
    refreshTokenExpires: Date | null;
  }): Session {
    const sessionParams: Record<string, string | number | boolean> = {
      id: row.id,
      shop: row.shop,
      state: row.state,
      isOnline: row.isOnline,
      userId: String(row.userId),
      firstName: String(row.firstName),
      lastName: String(row.lastName),
      email: String(row.email),
      locale: String(row.locale),
    };
    if (row.accountOwner !== null) sessionParams.accountOwner = row.accountOwner;
    if (row.collaborator !== null) sessionParams.collaborator = row.collaborator;
    if (row.emailVerified !== null) sessionParams.emailVerified = row.emailVerified;
    if (row.expires) sessionParams.expires = row.expires.getTime();
    if (row.scope) sessionParams.scope = row.scope;
    if (row.accessToken) sessionParams.accessToken = row.accessToken;
    if (row.refreshToken) sessionParams.refreshToken = row.refreshToken;
    if (row.refreshTokenExpires) {
      sessionParams.refreshTokenExpires = row.refreshTokenExpires.getTime();
    }
    return Session.fromPropertyArray(Object.entries(sessionParams), true);
  }
}
