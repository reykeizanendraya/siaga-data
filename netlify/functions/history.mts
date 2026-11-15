import type { Config, Context } from "@netlify/functions";
import { desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { history } from "../../db/schema.js";
import { clean, fail, findResident, isValidNik, json, readBody } from "../lib/siaga.js";

export default async (req: Request, context: Context) => {
  const { nik } = context.params;
  if (!isValidNik(nik)) return fail(400, "NIK tidak valid.");
  try {
    if (req.method === "GET") {
      const rows = await db.select().from(history).where(eq(history.nik, nik)).orderBy(desc(history.createdAt)).limit(100);
      return json(200, { history: rows });
    }
    if (req.method === "POST") {
      if (!await findResident(nik)) return fail(404, "Data penduduk tidak ditemukan.");
      const body = await readBody(req);
      const action = clean(body.action, 100);
      const description = clean(body.description, 300);
      if (!action) return fail(400, "Aktivitas wajib diisi.");
      const [entry] = await db.insert(history).values({
        nik, action, description, entity: "Aplikasi SIAGA DATA", status: "Berhasil", createdAt: Date.now(),
      }).returning();
      return json(201, { entry });
    }
    return fail(405, "Metode tidak diizinkan.");
  } catch (error) {
    console.error(error);
    return fail(500, "Terjadi kesalahan pada server.");
  }
};

export const config: Config = { path: "/api/history/:nik" };
