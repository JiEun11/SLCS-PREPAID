import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { isPin, PinLimitError, type AdminAuth } from "./admin-auth.js";
import { createCustomerService } from "./customers.js";
import { admins } from "./db/schema.js";

export function createServices(env: NodeJS.ProcessEnv) {
  const { DATABASE_URL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = env;
  if (!DATABASE_URL && !SUPABASE_URL && !SUPABASE_PUBLISHABLE_KEY) {
    return {};
  }
  if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error(
      "Configure DATABASE_URL, SUPABASE_URL, and SUPABASE_PUBLISHABLE_KEY together",
    );
  }

  const { ADMIN_AUTH_EMAIL, ADMIN_AUTH_PASSWORD, ADMIN_PIN } = env;
  const email = ADMIN_AUTH_EMAIL?.trim().toLowerCase();
  const pinConfigured = Boolean(
    email && ADMIN_AUTH_PASSWORD && isPin(ADMIN_PIN),
  );
  let retries = 0;
  let resetAt = 0;
  function checkPin(pin: string) {
    if (!pinConfigured || !isPin(pin)) return false;
    const now = Date.now();
    if (now >= resetAt) {
      retries = 0;
      resetAt = now + 15 * 60_000;
    }
    if (retries >= 8) throw new PinLimitError(resetAt - now);
    const valid = timingSafeEqual(Buffer.from(pin), Buffer.from(ADMIN_PIN!));
    if (valid) {
      retries = 0;
    } else {
      retries++;
    }
    return valid;
  }

  const db = drizzle(DATABASE_URL);
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  // Share only in-flight checks. Each later request is still checked against Supabase.
  const tokenChecks = new Map<string, Promise<string | null>>();
  async function verifyToken(token: string) {
    const { data, error } = await supabase.auth.getUser(token);
    if (error) {
      if (
        error.status === 400 ||
        error.status === 401 ||
        error.status === 403
      ) {
        return null;
      }
      throw error;
    }
    if (!pinConfigured || data.user?.email?.toLowerCase() !== email)
      return null;
    return data.user?.id ?? null;
  }

  const adminAuth: AdminAuth = {
    getUserId(token) {
      const pending = tokenChecks.get(token);
      if (pending) return pending;
      const check = verifyToken(token).finally(() => tokenChecks.delete(token));
      tokenChecks.set(token, check);
      return check;
    },
    async reauthenticate(_token, _userId, pin) {
      return checkPin(pin);
    },
    async isAdmin(userId) {
      const [admin] = await db
        .select({ userId: admins.userId })
        .from(admins)
        .where(eq(admins.userId, userId))
        .limit(1);
      return Boolean(admin);
    },
  };

  if (pinConfigured) {
    adminAuth.signInWithPin = async (pin) => {
      if (!checkPin(pin)) return null;
      const verifier = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
      });
      const { data, error } = await verifier.auth.signInWithPassword({
        email: email!,
        password: ADMIN_AUTH_PASSWORD!,
      });
      if (error || !data.session || !data.user)
        throw new Error("Admin session unavailable");
      if (!(await adminAuth.isAdmin(data.user.id)))
        throw new Error("Admin membership missing");
      return {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      };
    };
  }

  return { adminAuth, customerService: createCustomerService(db) };
}
