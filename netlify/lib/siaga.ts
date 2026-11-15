import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "../../db/index.js";
import { activities, loginFailures, residents } from "../../db/schema.js";
import { type MailContent, formatWib, sendEmail } from "./email.js";

export type Resident = typeof residents.$inferSelect;

export const NIK_LENGTH = 16;
// Token Akses / sesi penduduk berlaku 3 jam sejak diklaim. Setelah itu wajib klaim ulang.
export const TOKEN_TTL_HOURS = 3;
export const TOKEN_TTL_MS = TOKEN_TTL_HOURS * 60 * 60 * 1000;
// Email peringatan dikirim saat sisa masa token kurang dari 30 menit.
export const TOKEN_WARNING_MS = 30 * 60 * 1000;
export const SHARE_TTL_MS = 5 * 60 * 1000;
export const SECURITY_WINDOW_MS = 10 * 60 * 1000;
export const SECURITY_FAILURE_THRESHOLD = 4;
export const MAX_FILE_BYTES = 1024 * 1024;

// Kolom data diri yang boleh dilengkapi penduduk sendiri.
export const PROFILE_FIELDS = ["email", "birthPlace", "birthDate", "gender", "religion", "maritalStatus", "occupation", "address"] as const;
export const SETTING_FIELDS = ["twoFactor", "biometric"] as const;

export const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

export const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => json(status, { error, ...extra });

export async function readBody(req: Request): Promise<Record<string, any>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

export const digitsOnly = (value: unknown) => String(value ?? "").replace(/\D/g, "");
export const isValidNik = (nik: unknown) => typeof nik === "string" && /^\d{16}$/.test(nik);
export const clean = (value: unknown, max = 200) => String(value ?? "").trim().slice(0, max);

export function tokenStatus(user: Resident, now = Date.now()) {
  if (!user.tokenExpiresAt || user.token === "BELUM_GENERATE") return "unclaimed";
  return user.tokenExpiresAt > now ? "active" : "expired";
}

// Bentuk data penduduk yang dikirim ke browser. Hash password tidak pernah dikirim.
export function publicUser(user: Resident, { withFiles = true } = {}) {
  const documents = (user.documents || []).map((doc) => {
    if (withFiles) return doc;
    const { fileData, ...rest } = doc as Record<string, unknown>;
    return rest;
  });
  return {
    nik: user.nik,
    name: user.name,
    phone: user.phone,
    initial: (user.name || "").trim().charAt(0).toUpperCase(),
    token: user.token,
    tokenStatus: tokenStatus(user),
    tokenExpiresAt: user.tokenExpiresAt ?? null,
    updatedAt: user.updatedAt,
    documents,
    profile: user.profile || {},
    settings: user.settings || {},
    hasPassword: Boolean(user.passwordHash),
    passwordUpdatedAt: user.passwordUpdatedAt ?? null,
    tokenTtlMs: TOKEN_TTL_MS,
  };
}

export async function findResident(nik: string) {
  const [user] = await db.select().from(residents).where(eq(residents.nik, nik)).limit(1);
  return user || null;
}

// Endpoint swalayan penduduk wajib menyertakan Token Akses yang masih aktif.
export async function requireResident(req: Request, nik: string) {
  if (!isValidNik(nik)) return { error: fail(400, "NIK tidak valid.") };
  const user = await findResident(nik);
  if (!user) return { error: fail(404, "Data penduduk tidak ditemukan.") };
  const token = clean(req.headers.get("x-siaga-token"), 64).toUpperCase();
  if (tokenStatus(user) !== "active" || !token || token !== user.token) {
    return { error: fail(401, "Sesi berakhir. Silakan login kembali dengan Token Akses aktif.", { code: "SESSION_INVALID" }) };
  }
  return { user };
}

export function generateToken() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(6);
  return "TKN-" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string | null) {
  if (!stored) return false;
  const [, salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

interface ActivityOptions {
  /** Isi email khusus. `false` = jangan kirim email. Default: email dibuat dari judul & deskripsi notifikasi. */
  email?: MailContent | false;
  /** Context Netlify Function agar email dikirim di latar belakang (tidak menahan respons). */
  context?: { waitUntil?: (promise: Promise<unknown>) => void };
  /** Data penduduk (opsional) agar tidak perlu query ulang untuk alamat email. */
  user?: Resident | null;
}

// Setiap notifikasi yang masuk ke menu "Notifikasi" juga dikirim ke email penduduk.
export async function addActivity(nik: string, title: string, description: string, type = "info", icon = "ph-info", options: ActivityOptions = {}) {
  const createdAt = Date.now();
  await db.insert(activities).values({ nik, title, description, type, icon, createdAt });
  if (options.email === false) return;
  const task = (async () => {
    const user = options.user ?? (await findResident(nik));
    const to = residentEmail(user);
    if (!to) return false;
    const content: MailContent = options.email || {
      subject: title,
      heading: title,
      intro: `Halo ${user?.name || "Penduduk"}, ada notifikasi baru di akun SIAGA DATA Anda.`,
      rows: [["Notifikasi", description], ["Waktu", formatWib(createdAt)]],
      note: "Notifikasi ini juga dapat dilihat melalui menu Notifikasi di aplikasi SIAGA DATA.",
      tone: type === "warning" || type === "danger" ? "warning" : type === "success" ? "success" : "info",
    };
    return sendEmail(to, content);
  })().catch((error) => {
    console.error("[email] Gagal memproses email notifikasi:", (error as Error).message);
    return false;
  });
  if (options.context?.waitUntil) options.context.waitUntil(task);
  else await task;
}

export async function securityStatus(nik: string) {
  const since = Date.now() - SECURITY_WINDOW_MS;
  const rows = await db.select({ id: loginFailures.id }).from(loginFailures)
    .where(and(eq(loginFailures.nik, nik), gt(loginFailures.createdAt, since)));
  return {
    failedAttempts: rows.length,
    suspicious: rows.length >= SECURITY_FAILURE_THRESHOLD,
    threshold: SECURITY_FAILURE_THRESHOLD,
    windowMinutes: SECURITY_WINDOW_MS / 60000,
  };
}

export async function recordLoginFailure(nik: string, reason = "Token Akses salah", context?: ActivityOptions["context"]) {
  const now = Date.now();
  await db.insert(loginFailures).values({ nik, createdAt: now });
  const status = await securityStatus(nik);
  // Setiap login gagal dicatat sebagai notifikasi dan dikirim ke email pemilik akun.
  const user = await findResident(nik);
  await addActivity(nik, "Login gagal", `Percobaan masuk ke akun Anda gagal (${reason}) pada ${formatWib(now)}.`, "warning", "ph-sign-in", {
    context,
    user,
    email: {
      subject: "Peringatan: Login gagal",
      heading: "Percobaan login gagal",
      intro: `Halo ${user?.name || "Penduduk"}, seseorang baru saja mencoba masuk ke akun SIAGA DATA Anda namun gagal.`,
      rows: [["Alasan", reason], ["Waktu", formatWib(now)], ["Percobaan gagal (10 menit)", `${status.failedAttempts} dari batas ${status.threshold}`]],
      note: "Jika ini bukan Anda, jangan bagikan Token Akses kepada siapa pun dan segera hubungi petugas melalui menu Helpdesk.",
      tone: "warning",
    },
  });
  if (status.suspicious) {
    const [lastWarning] = await db.select({ createdAt: activities.createdAt }).from(activities)
      .where(and(eq(activities.nik, nik), eq(activities.title, "Percobaan login gagal berulang")))
      .orderBy(desc(activities.createdAt)).limit(1);
    if (!lastWarning || now - lastWarning.createdAt >= SECURITY_WINDOW_MS) {
      await addActivity(nik, "Percobaan login gagal berulang", `Terdeteksi ${status.failedAttempts} percobaan login gagal dalam 10 menit terakhir.`, "warning", "ph-warning-circle", { context, user });
    }
  }
  return status;
}

export function validateDocuments(documents: unknown) {
  if (!Array.isArray(documents)) return [];
  return documents.map((doc: any) => {
    const fileData = String(doc?.fileData || "");
    const [header, encoded] = fileData.split(",");
    if (!["data:image/png;base64", "data:application/pdf;base64"].includes(header) || !encoded) {
      throw new Error(`${doc?.name || "Dokumen"} hanya menerima file PNG atau PDF.`);
    }
    if (Buffer.from(encoded, "base64").length > MAX_FILE_BYTES) throw new Error(`${doc?.name || "Dokumen"} maksimal berukuran 1 MB.`);
    return {
      id: clean(doc.id, 20),
      name: clean(doc.name, 60),
      icon: clean(doc.icon, 60) || "ph-file-text",
      status: clean(doc.status, 30) || "Aman",
      validity: clean(doc.validity, 100) || "Dokumen tersimpan",
      fileName: clean(doc.fileName, 200),
      fileType: clean(doc.fileType, 40),
      fileData,
    };
  });
}

export function mergeDocuments(existing: Record<string, unknown>[], incoming: Record<string, unknown>[]) {
  const merged = [...(existing || [])];
  for (const doc of incoming) {
    const index = merged.findIndex((item) => item.id === doc.id);
    if (index < 0) merged.push(doc);
    else merged[index] = doc;
  }
  return merged;
}

export const residentEmail = (user: Resident | null | undefined) => (user?.profile?.email || "").trim();
