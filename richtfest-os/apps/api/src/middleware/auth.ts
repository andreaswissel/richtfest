import type { NextFunction, Request, Response } from "express";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { fromNodeHeaders } from "better-auth/node";
import {
  invitations,
  memberships,
  rolePermissions,
  roles,
  users,
} from "../db/schema";
import type { Database } from "../db/client";

export type Actor = {
  id: string;
  email: string;
  name: string;
  uiDensity: "dense" | "normal";
  language: "en" | "de";
  theme: "light" | "dark";
  tenantId: string;
  permissions: Set<string>;
};

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const actorFor = async (
  db: Database,
  auth: any,
  req: Request,
): Promise<Actor | null> => {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!session?.user) return null;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  if (!user) return null;

  const memberRows = await db
    .select()
    .from(memberships)
    .where(eq(memberships.userId, user.id));
  if (memberRows.length !== 1) return null;
  const member = memberRows[0];

  if (member.status === "invited") {
    const [validInvitation] = await db
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          eq(invitations.tenantId, member.tenantId),
          eq(invitations.email, user.email),
          isNull(invitations.acceptedAt),
          isNull(invitations.cancelledAt),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(invitations.createdAt))
      .limit(1);
    if (!validInvitation) return null;

    await db.transaction(async (tx) => {
      await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(
          and(
            eq(invitations.id, validInvitation.id),
            isNull(invitations.acceptedAt),
            isNull(invitations.cancelledAt),
            gt(invitations.expiresAt, new Date()),
          ),
        );
      await tx
        .update(memberships)
        .set({ status: "active" })
        .where(
          and(
            eq(memberships.tenantId, member.tenantId),
            eq(memberships.userId, user.id),
            eq(memberships.status, "invited"),
          ),
        );
    });
  } else if (member.status !== "active") {
    return null;
  }

  const rows = await db
    .select({ permission: rolePermissions.permission })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .where(
      and(
        eq(memberships.userId, user.id),
        eq(memberships.tenantId, member.tenantId),
        eq(memberships.status, "active"),
      ),
    )
    .limit(100);
  if (!rows[0]) return null;

  return {
    ...user,
    uiDensity: user.uiDensity as "dense" | "normal",
    language: user.language as "en" | "de",
    theme: user.theme as "light" | "dark",
    tenantId: member.tenantId,
    permissions: new Set(
      rows
        .map((row) => row.permission)
        .filter((value): value is string => Boolean(value)),
    ),
  };
};

export const requireSession = (db: Database, auth: any) =>
  async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const actor = await actorFor(db, auth, req);
      if (!actor) {
        throw new HttpError(401, "unauthorized", "Sign in is required");
      }
      (req as any).actor = actor;
      next();
    } catch (error) {
      next(error);
    }
  };

export const requireOsUse = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  try {
    const actor = (req as any).actor as Actor | undefined;
    if (!actor?.permissions.has("richtfest-os:use")) {
      throw new HttpError(403, "forbidden", "Richtfest OS access is required");
    }
    next();
  } catch (error) {
    next(error);
  }
};
