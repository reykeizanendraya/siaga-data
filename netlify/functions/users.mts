import type { Config, Context } from "@netlify/functions";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { activities, helpdeskTickets, history, loginFailures, residents, shares } from "../../db/schema.js";
import {
  PROFILE_FIELDS, SETTING_FIELDS, clean, digitsOnly, fail, findResident, hashPassword, isValidNik, json,
  mergeDocuments, publicUser, readBody, requireResident, validateDocuments, verifyPassword,
} from "../lib/siaga.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function listUsers() {
  const rows = await db.select().from(residents).orderBy(asc(residents.createdAt));
  return json(200, { users: rows.map((user) => publicUser(user, { withFiles: false })) });
}

async function createUser(req: Request) {
  const body = await readBody(req);
  const nik = clean(body.nik, 20);
  const name = clean(body.name, 120);
  const phone = clean(body.phone, 30);
  if (!isValidNik(nik)) return fail(400, "NIK harus 16 digit angka.");
  if (!name) return fail(400, "Nama lengkap wajib diisi.");
  if (!digitsOnly(phone)) return fail(400, "Nomor WhatsApp wajib diisi.");
  if (await findResident(nik)) return fail(409, "NIK sudah terdaftar.");
  let documents;
  try { documents = validateDocuments(body.documents); } catch (error) { return fail(400, (error as Error).message); }
  const now = Date.now();
  const [user] = await db.insert(residents).values({ nik, name, phone, documents, createdAt: now, updatedAt: now }).returning();
  return json(201, { user: publicUser(user, { withFiles: false }) });
}

async function updateUser(req: Request, originalNik: string) {
  const user = await findResident(originalNik);
  if (!user) return fail(404, "Data penduduk tidak ditemukan.");
  const body = await readBody(req);
  const nik = clean(body.nik ?? originalNik, 20);
  const name = clean(body.name ?? user.name, 120);
  const phone = clean(body.phone ?? user.phone, 30);
  if (!isValidNik(nik)) return fail(400, "NIK harus 16 digit angka.");
  if (!name) return fail(400, "Nama lengkap wajib diisi.");
  if (nik !== originalNik && await findResident(nik)) return fail(409, "NIK baru sudah digunakan penduduk lain.");
  let incoming;
  try { incoming = validateDocuments(body.documents); } catch (error) { return fail(400, (error as Error).message); }

  await db.update(residents).set({ nik, name, phone, documents: mergeDocuments(user.documents, incoming), updatedAt: Date.now() })
    .where(eq(residents.nik, originalNik));
  if (nik !== originalNik) {
    // Riwayat, notifikasi, dan tiket helpdesk ikut berpindah ke NIK yang baru.
    await db.update(history).set({ nik }).where(eq(history.nik, originalNik));
    await db.update(activities).set({ nik }).where(eq(activities.nik, originalNik));
    await db.update(loginFailures).set({ nik }).where(eq(loginFailures.nik, originalNik));
    await db.update(shares).set({ ownerNik: nik }).where(eq(shares.ownerNik, originalNik));
    await db.update(helpdeskTickets).set({ nik }).where(eq(helpdeskTickets.nik, originalNik));
  }
  const updated = await findResident(nik);
  return json(200, { user: publicUser(updated!, { withFiles: false }) });
}

// Penduduk memperbarui nomor HP dan melengkapi data diri dari menu Pengaturan.
async function updateProfile(req: Request, nik: string) {
  const { user, error } = await requireResident(req, nik);
  if (error) return error;
  const body = await readBody(req);
  const phone = clean(body.phone ?? user.phone, 30);
  if (digitsOnly(phone).length < 9) return fail(400, "Nomor WhatsApp minimal 9 digit.");
  const input = body.profile && typeof body.profile === "object" ? body.profile : {};
  const profile: Record<string, string> = { ...(user.profile || {}) };
  for (const field of PROFILE_FIELDS) {
    if (field in input) profile[field] = clean(input[field], field === "address" ? 300 : 120);
  }
  if (profile.email && !EMAIL_PATTERN.test(profile.email)) return fail(400, "Format email tidak valid.");
  if (profile.birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(profile.birthDate)) return fail(400, "Tanggal lahir tidak valid.");
  const [updated] = await db.update(residents).set({ phone, profile, updatedAt: Date.now() }).where(eq(residents.nik, nik)).returning();
  return json(200, { user: publicUser(updated) });
}

async function updatePassword(req: Request, nik: string) {
  const { user, error } = await requireResident(req, nik);
  if (error) return error;
  const body = await readBody(req);
  const currentPassword = String(body.currentPassword ?? "");
  const newPassword = String(body.newPassword ?? "");
  if (user.passwordHash && !verifyPassword(currentPassword, user.passwordHash)) return fail(400, "Password saat ini salah.");
  const now = Date.now();
  if (body.remove === true) {
    const [updated] = await db.update(residents).set({ passwordHash: null, passwordUpdatedAt: now, updatedAt: now }).where(eq(residents.nik, nik)).returning();
    return json(200, { user: publicUser(updated) });
  }
  if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
    return fail(400, "Password baru minimal 8 karakter dan mengandung huruf serta angka.");
  }
  const [updated] = await db.update(residents).set({ passwordHash: hashPassword(newPassword), passwordUpdatedAt: now, updatedAt: now })
    .where(eq(residents.nik, nik)).returning();
  return json(200, { user: publicUser(updated) });
}

async function updateSettings(req: Request, nik: string) {
  const { user, error } = await requireResident(req, nik);
  if (error) return error;
  const body = await readBody(req);
  const settings: Record<string, boolean> = { ...(user.settings || {}) };
  for (const field of SETTING_FIELDS) if (typeof body[field] === "boolean") settings[field] = body[field];
  const [updated] = await db.update(residents).set({ settings, updatedAt: Date.now() }).where(eq(residents.nik, nik)).returning();
  return json(200, { user: publicUser(updated) });
}

export default async (req: Request, context: Context) => {
  const { nik, action } = context.params;
  try {
    if (!nik) {
      if (req.method === "GET") return await listUsers();
      if (req.method === "POST") return await createUser(req);
      return fail(405, "Metode tidak diizinkan.");
    }
    if (action) {
      if (req.method !== "PUT") return fail(405, "Metode tidak diizinkan.");
      if (action === "profile") return await updateProfile(req, nik);
      if (action === "password") return await updatePassword(req, nik);
      if (action === "settings") return await updateSettings(req, nik);
      return fail(404, "Endpoint tidak ditemukan.");
    }
    if (req.method === "GET") {
      const user = await findResident(nik);
      return user ? json(200, { user: publicUser(user) }) : fail(404, "Data penduduk tidak ditemukan.");
    }
    if (req.method === "PUT") return await updateUser(req, nik);
    return fail(405, "Metode tidak diizinkan.");
  } catch (error) {
    console.error(error);
    return fail(500, "Terjadi kesalahan pada server.");
  }
};

export const config: Config = { path: ["/api/users", "/api/users/:nik", "/api/users/:nik/:action"] };
