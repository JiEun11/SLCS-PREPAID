import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { AdminAuth } from "./admin-auth.js";
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

  const db = drizzle(DATABASE_URL);
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  const adminAuth: AdminAuth = {
    async getUserId(token) {
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
      return data.user?.id ?? null;
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

  return { adminAuth, customerService: createCustomerService(db) };
}
