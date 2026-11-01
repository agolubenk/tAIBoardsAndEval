import {
  type AnyColumn,
  and,
  eq,
  isNotNull,
  isNull,
  lt,
  or,
} from "drizzle-orm";
import { schema } from "../database";

export type BanState = {
  banned?: boolean | null;
  banExpires?: Date | string | null;
};

export function isBanActive(user: BanState | null | undefined) {
  if (!user?.banned) {
    return false;
  }
  if (!user.banExpires) {
    return true;
  }
  return new Date(user.banExpires).getTime() >= Date.now();
}

// The user table itself or an alias of it.
type BanColumns = { banned: AnyColumn; banExpires: AnyColumn };

export function notBannedCondition(user: BanColumns = schema.userTable) {
  return or(
    isNull(user.banned),
    eq(user.banned, false),
    and(isNotNull(user.banExpires), lt(user.banExpires, new Date())),
  );
}
