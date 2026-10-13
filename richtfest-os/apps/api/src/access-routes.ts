import crypto from "node:crypto";
import { Router, type Request } from "express";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { ok, permissions as permissionKeys } from "@richtfest/shared";
import {
  authDevOutbox,
  invitations,
  memberships,
  rolePermissions,
  roles,
  tenants,
  users,
} from "./db/schema";
import { authSession, authUser } from "./db/auth-schema";
import type { Database } from "./db/client";
import { HttpError } from "./middleware/auth";
import { recordAudit } from "./audit";
import { env } from "./env";

type RequestActor = {
  id: string;
  tenantId: string;
  permissions: Set<string>;
};

const actor = (req: Request) => (req as any).actor as RequestActor;
const send = (res: any, status: number, body: any) =>
  res.status(status).json(body);

const roleInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).default(""),
    permissions: z
      .array(z.enum(permissionKeys))
      .max(permissionKeys.length)
      .transform((keys) => [...new Set(keys)]),
  })
  .refine((role) => role.permissions.includes("richtfest-os:use"), {
    message: "Workspace roles require Richtfest OS access",
    path: ["permissions"],
  });

export const createAccessRouter = (
  db: Database,
  auth: any,
  allowDevAuth: boolean,
) => {
  const router = Router();
  const manage = (req: Request) => {
    const current = actor(req);
    if (!current.permissions.has("access:manage")) {
      throw new HttpError(
        403,
        "forbidden",
        "Team administration requires access:manage",
      );
    }
    return current;
  };
  // Serialize access changes per workspace, including member changes, so two
  // concurrent administrators cannot both remove the last usable manager.
  const managedTransaction = <T>(
    current: RequestActor,
    write: (
      tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    ) => Promise<T>,
  ) =>
    db.transaction(async (tx) => {
      await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, current.tenantId))
        .for("update");
      const managers = () =>
        tx
          .select({ userId: memberships.userId })
          .from(memberships)
          .innerJoin(roles, eq(roles.id, memberships.roleId))
          .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
          .where(
            and(
              eq(memberships.tenantId, current.tenantId),
              eq(roles.tenantId, current.tenantId),
              eq(memberships.status, "active"),
              eq(rolePermissions.permission, "access:manage"),
              sql`exists (select 1 from ${rolePermissions} os_grant where os_grant.role_id = ${roles.id} and os_grant.permission = 'richtfest-os:use')`,
            ),
          );
      // Authorization may have changed while this request waited for the lock.
      if (!(await managers()).some((row) => row.userId === current.id)) {
        throw new HttpError(
          403,
          "forbidden",
          "Team administration requires access:manage",
        );
      }
      const result = await write(tx);
      if (!(await managers()).length) {
        throw new HttpError(
          409,
          "last_manager_required",
          "Assign another workspace administrator before removing the last manager",
        );
      }
      return result;
    });

  router.get("/access/team", async (req, res, next) => {
    try {
      const current = actor(req);
      const members = await db
        .select({
          id: users.id,
          userId: users.id,
          name: users.name,
          email: users.email,
          role: roles.name,
          roleId: roles.id,
          status: memberships.status,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .innerJoin(roles, eq(roles.id, memberships.roleId))
        .where(
          and(
            eq(memberships.tenantId, current.tenantId),
            ne(memberships.status, "invited"),
          ),
        )
        .orderBy(users.name);
      const availableRoles = await db
        .select({
          id: roles.id,
          name: roles.name,
          description: roles.description,
        })
        .from(roles)
        .where(eq(roles.tenantId, current.tenantId))
        .orderBy(roles.name);
      const grants = current.permissions.has("access:manage")
        ? await db
            .select({
              roleId: roles.id,
              permission: rolePermissions.permission,
            })
            .from(roles)
            .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
            .where(eq(roles.tenantId, current.tenantId))
        : [];
      const pending = await db
        .select({
          id: invitations.id,
          name: users.name,
          email: invitations.email,
          expiresAt: invitations.expiresAt,
          role: roles.name,
        })
        .from(invitations)
        .innerJoin(roles, eq(roles.id, invitations.roleId))
        .leftJoin(users, eq(users.email, invitations.email))
        .where(
          and(
            eq(invitations.tenantId, current.tenantId),
            isNull(invitations.acceptedAt),
            isNull(invitations.cancelledAt),
            gt(invitations.expiresAt, new Date()),
          ),
        );
      return send(
        res,
        200,
        ok({
          members,
          roles: availableRoles.map((role) => ({
            ...role,
            ...(current.permissions.has("access:manage")
              ? {
                  permissions: grants
                    .filter((grant) => grant.roleId === role.id)
                    .map((grant) => grant.permission),
                }
              : {}),
          })),
          invitations: pending.map((item) => ({ ...item, status: "pending" })),
          canManageTeam: current.permissions.has("access:manage"),
          devOutboxAvailable: allowDevAuth,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post("/access/roles", async (req, res, next) => {
    try {
      const current = manage(req);
      const input = roleInput.parse(req.body);
      const role = await managedTransaction(current, async (tx) => {
        const [created] = await tx
          .insert(roles)
          .values({
            tenantId: current.tenantId,
            name: input.name,
            description: input.description,
          })
          .onConflictDoNothing()
          .returning();
        if (!created)
          throw new HttpError(
            409,
            "role_exists",
            "A role with this name already exists",
          );
        await tx
          .insert(rolePermissions)
          .values(
            input.permissions.map((permission) => ({
              roleId: created.id,
              permission,
            })),
          );
        await recordAudit(
          tx,
          current.id,
          current.tenantId,
          "access.role.created",
          "role",
          created.id,
          input,
        );
        return { ...created, permissions: input.permissions };
      });
      return send(res, 201, ok(role, "Role created"));
    } catch (error) {
      next(error);
    }
  });

  router.put("/access/roles/:id", async (req, res, next) => {
    try {
      const current = manage(req);
      const id = z.string().uuid().parse(req.params.id);
      const input = roleInput.parse(req.body);
      const role = await managedTransaction(current, async (tx) => {
        const [existing] = await tx
          .select()
          .from(roles)
          .where(and(eq(roles.id, id), eq(roles.tenantId, current.tenantId)));
        if (!existing) throw new HttpError(404, "not_found", "Role not found");
        const [duplicate] = await tx
          .select({ id: roles.id })
          .from(roles)
          .where(
            and(
              eq(roles.tenantId, current.tenantId),
              eq(roles.name, input.name),
              ne(roles.id, id),
            ),
          );
        if (duplicate)
          throw new HttpError(
            409,
            "role_exists",
            "A role with this name already exists",
          );
        const before = await tx
          .select({ permission: rolePermissions.permission })
          .from(rolePermissions)
          .where(eq(rolePermissions.roleId, id));
        const [updated] = await tx
          .update(roles)
          .set({ name: input.name, description: input.description })
          .where(and(eq(roles.id, id), eq(roles.tenantId, current.tenantId)))
          .returning();
        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
        await tx
          .insert(rolePermissions)
          .values(
            input.permissions.map((permission) => ({ roleId: id, permission })),
          );
        await recordAudit(
          tx,
          current.id,
          current.tenantId,
          "access.role.updated",
          "role",
          id,
          {
            before: {
              name: existing.name,
              description: existing.description,
              permissions: before.map((row) => row.permission),
            },
            after: input,
          },
        );
        return { ...updated, permissions: input.permissions };
      });
      return send(res, 200, ok(role, "Role updated"));
    } catch (error) {
      next(error);
    }
  });

  router.post("/access/invitations", async (req, res, next) => {
    try {
      const current = manage(req);
      const input = z
        .object({
          name: z.string().trim().min(1).max(120),
          email: z
            .string()
            .email()
            .transform((value) => value.toLowerCase()),
          roleId: z.string().uuid(),
          expiresInDays: z.coerce.number().int().min(1).max(30).default(7),
        })
        .parse(req.body);
      const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
      const invitationResult = await db.transaction(async (tx) => {
        const [role] = await tx
          .select({ id: roles.id })
          .from(roles)
          .where(
            and(
              eq(roles.id, input.roleId),
              eq(roles.tenantId, current.tenantId),
            ),
          )
          .limit(1);
        if (!role) {
          throw new HttpError(
            400,
            "invalid_role",
            "Role is not available in this workspace",
          );
        }

        const [existing] = await tx
          .select()
          .from(users)
          .where(eq(users.email, input.email))
          .limit(1);
        const userId = existing?.id ?? crypto.randomUUID();
        if (existing) {
          const [existingMembership] = await tx
            .select({
              tenantId: memberships.tenantId,
              status: memberships.status,
            })
            .from(memberships)
            .where(eq(memberships.userId, userId))
            .limit(1);
          if (
            existingMembership?.status === "active" &&
            existingMembership.tenantId === current.tenantId
          ) {
            throw new HttpError(
              409,
              "member_exists",
              "This identity is already an active workspace member",
            );
          }
          if (
            existingMembership?.status === "active" &&
            existingMembership.tenantId !== current.tenantId
          ) {
            throw new HttpError(
              409,
              "identity_already_bound",
              "This identity already belongs to another workspace",
            );
          }
        } else {
          await tx.insert(users).values({
            id: userId,
            email: input.email,
            name: input.name,
          });
          await tx.insert(authUser).values({
            id: userId,
            email: input.email,
            name: input.name,
            emailVerified: false,
          });
        }

        if (existing) {
          await tx
            .update(users)
            .set({ name: input.name })
            .where(eq(users.id, userId));
          await tx
            .update(authUser)
            .set({ name: input.name })
            .where(eq(authUser.id, userId));
        }

        await tx
          .insert(memberships)
          .values({
            tenantId: current.tenantId,
            userId,
            roleId: input.roleId,
            status: "invited",
          })
          .onConflictDoUpdate({
            target: [memberships.tenantId, memberships.userId],
            set: { roleId: input.roleId, status: "invited" },
          });
        const [invitation] = await tx
          .insert(invitations)
          .values({
            tenantId: current.tenantId,
            email: input.email,
            roleId: input.roleId,
            expiresAt,
          })
          .returning();
        await recordAudit(
          tx,
          current.id,
          current.tenantId,
          "access.invitation.created",
          "invitation",
          invitation.id,
          {
            email: input.email,
            roleId: input.roleId,
            expiresInDays: input.expiresInDays,
          },
        );
        return { invitation, userId };
      });

      let delivery: "sent" | "development_outbox" | "unconfigured" =
        "unconfigured";
      const requestedAt = new Date();
      try {
        await auth.api.signInMagicLink({
          body: { email: input.email, callbackURL: "/" },
          headers: new Headers({ origin: env.BETTER_AUTH_URL }),
        });
        if (env.RESEND_API_KEY && env.RESEND_FROM) {
          delivery = "sent";
        } else {
          const [outbox] = await db
            .select({ id: authDevOutbox.id })
            .from(authDevOutbox)
            .where(
              and(
                eq(authDevOutbox.tenantId, current.tenantId),
                eq(authDevOutbox.email, input.email),
                gt(authDevOutbox.createdAt, requestedAt),
              ),
            )
            .limit(1);
          delivery = outbox ? "development_outbox" : "unconfigured";
        }
      } catch {
        delivery = "unconfigured";
      }

      return send(
        res,
        201,
        ok(
          {
            email: input.email,
            expiresAt,
            deliveryStatus: delivery,
            userId: invitationResult.userId,
          },
          delivery === "sent"
            ? "Invitation created and sign-in link sent"
            : delivery === "development_outbox"
              ? "Invitation created; local outbox contains the sign-in link"
              : "Invitation created; configure RESEND_API_KEY and RESEND_FROM to deliver the sign-in link",
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post("/access/invitations/:id/cancel", async (req, res, next) => {
    try {
      const current = manage(req);
      const id = z.string().uuid().parse(req.params.id);
      const invitation = await db.transaction(async (tx) => {
        const [cancelled] = await tx
          .update(invitations)
          .set({ cancelledAt: new Date() })
          .where(
            and(
              eq(invitations.id, id),
              eq(invitations.tenantId, current.tenantId),
              isNull(invitations.acceptedAt),
              isNull(invitations.cancelledAt),
            ),
          )
          .returning({ id: invitations.id, email: invitations.email });
        if (!cancelled) {
          throw new HttpError(404, "not_found", "Invitation not found");
        }
        const [user] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, cancelled.email))
          .limit(1);
        if (user) {
          await tx
            .update(memberships)
            .set({ status: "inactive" })
            .where(
              and(
                eq(memberships.tenantId, current.tenantId),
                eq(memberships.userId, user.id),
                eq(memberships.status, "invited"),
              ),
            );
          await tx.delete(authSession).where(eq(authSession.userId, user.id));
        }
        await recordAudit(
          tx,
          current.id,
          current.tenantId,
          "access.invitation.cancelled",
          "invitation",
          cancelled.id,
          {},
        );
        return cancelled;
      });
      return send(
        res,
        200,
        ok({ id: invitation.id, cancelled: true }, "Invitation cancelled"),
      );
    } catch (error) {
      next(error);
    }
  });

  router.patch("/access/members/:userId", async (req, res, next) => {
    try {
      const current = manage(req);
      const userId = z.string().uuid().parse(req.params.userId);
      const { roleId } = z
        .object({ roleId: z.string().uuid() })
        .parse(req.body);
      await managedTransaction(current, async (db) => {
        const [role] = await db
          .select({ id: roles.id })
          .from(roles)
          .where(
            and(eq(roles.id, roleId), eq(roles.tenantId, current.tenantId)),
          )
          .limit(1);
        if (!role) {
          throw new HttpError(
            400,
            "invalid_role",
            "Role is not available in this workspace",
          );
        }
        const [updated] = await db
          .update(memberships)
          .set({ roleId })
          .where(
            and(
              eq(memberships.tenantId, current.tenantId),
              eq(memberships.userId, userId),
              eq(memberships.status, "active"),
            ),
          )
          .returning({ userId: memberships.userId });
        if (!updated) throw new HttpError(404, "not_found", "Member not found");
        await recordAudit(
          db,
          current.id,
          current.tenantId,
          "access.member.role_changed",
          "user",
          userId,
          { roleId },
        );
      });
      return send(res, 200, ok({ userId, roleId }, "Member role updated"));
    } catch (error) {
      next(error);
    }
  });

  router.post("/access/members/:userId/offboard", async (req, res, next) => {
    try {
      const current = manage(req);
      const userId = z.string().uuid().parse(req.params.userId);
      if (userId === current.id) {
        throw new HttpError(
          400,
          "self_offboarding_forbidden",
          "An administrator cannot offboard their own account",
        );
      }
      const { reason } = z
        .object({ reason: z.string().trim().max(500).optional() })
        .parse(req.body);
      const result = await managedTransaction(current, async (tx) => {
        const [member] = await tx
          .update(memberships)
          .set({ status: "inactive" })
          .where(
            and(
              eq(memberships.tenantId, current.tenantId),
              eq(memberships.userId, userId),
              ne(memberships.status, "inactive"),
            ),
          )
          .returning({ userId: memberships.userId });
        if (!member) throw new HttpError(404, "not_found", "Member not found");
        const [user] = await tx
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        await tx.delete(authSession).where(eq(authSession.userId, userId));
        if (user) {
          await tx
            .update(invitations)
            .set({ cancelledAt: new Date() })
            .where(
              and(
                eq(invitations.tenantId, current.tenantId),
                eq(invitations.email, user.email),
                isNull(invitations.acceptedAt),
                isNull(invitations.cancelledAt),
              ),
            );
        }
        await recordAudit(
          tx,
          current.id,
          current.tenantId,
          "access.member.offboarded",
          "user",
          userId,
          { reason: reason || null },
        );
        return member;
      });
      return send(
        res,
        200,
        ok({ userId: result.userId, status: "inactive" }, "Member offboarded"),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/access/dev-outbox", async (req, res, next) => {
    try {
      if (!allowDevAuth) {
        throw new HttpError(404, "not_found", "Development outbox is disabled");
      }
      const current = manage(req);
      const rows = await db
        .select({
          id: authDevOutbox.id,
          email: authDevOutbox.email,
          url: authDevOutbox.url,
          createdAt: authDevOutbox.createdAt,
        })
        .from(authDevOutbox)
        .where(eq(authDevOutbox.tenantId, current.tenantId))
        .orderBy(authDevOutbox.createdAt);
      return send(
        res,
        200,
        ok({
          messages: rows.map((row) => ({
            ...row,
            to: row.email,
            subject: "Richtfest sign-in link",
            text: row.url,
          })),
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
};
