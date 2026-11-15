import type { Config, Context } from "@netlify/functions";
import { desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { activities } from "../../db/schema.js";
import { fail, isValidNik, json, securityStatus } from "../lib/siaga.js";

export default async (req: Request, context: Context) => {
  const { nik } = context.params;
  if (req.method !== "GET") return fail(405, "Metode tidak diizinkan.");
  if (!isValidNik(nik)) return fail(400, "NIK tidak valid.");
  try {
    if (new URL(req.url).pathname.startsWith("/api/security/")) return json(200, await securityStatus(nik));
    const events = await db.select().from(activities).where(eq(activities.nik, nik)).orderBy(desc(activities.createdAt)).limit(100);
    return json(200, { events });
  } catch (error) {
    console.error(error);
    return fail(500, "Terjadi kesalahan pada server.");
  }
};

export const config: Config = { path: ["/api/activities/:nik", "/api/security/:nik"] };
