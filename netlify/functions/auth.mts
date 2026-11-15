import type { Config, Context } from "@netlify/functions";
import { eq, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { residents } from "../../db/schema.js";
import {
  TOKEN_TTL_HOURS, TOKEN_TTL_MS, clean, digitsOnly, fail, findResident, generateToken, isValidNik, json,
  publicUser, readBody, recordLoginFailure, tokenStatus, verifyPassword,
} from "../lib/siaga.js";
import { EMAIL_PATTERN, formatWib, sendEmail } from "../lib/email.js";

function phoneVariants(digits: string) {
  const variants = new Set([digits]);
  if (digits.startsWith("0")) variants.add("62" + digits.slice(1));
  if (digits.startsWith("62")) variants.add("0" + digits.slice(2));
  return [...variants];
}

async function findByIdentity(identity: string) {
  const digits = digitsOnly(identity);
  if (!digits) return null;
  const phoneColumn = sql`regexp_replace(${residents.phone}, '\\D', '', 'g')`;
  const [user] = await db.select().from(residents).where(
    or(eq(residents.nik, digits), ...phoneVariants(digits).map((value) => sql`${phoneColumn} = ${value}`)),
  ).limit(1);
  return user || null;
}

async function login(req: Request, context: Context) {
  const body = await readBody(req);
  const identity = clean(body.identity, 40);
  const token = clean(body.token, 40).toUpperCase();
  const password = String(body.password ?? "");
  if (!identity || !token) return fail(400, "NIK/nomor HP dan Token Akses wajib diisi.");

  const user = await findByIdentity(identity);
  if (!user) return fail(401, "NIK, nomor HP, atau Token Akses salah.");

  const status = tokenStatus(user);
  if (status === "unclaimed") return fail(403, "Anda belum memiliki Token Akses. Silakan klaim token terlebih dahulu.", { code: "TOKEN_UNCLAIMED" });
  if (status === "expired") return fail(403, `Token Akses Anda sudah kedaluwarsa (berlaku ${TOKEN_TTL_HOURS} jam). Silakan klaim token baru untuk masuk kembali.`, { code: "TOKEN_EXPIRED" });
  if (token !== user.token) {
    await recordLoginFailure(user.nik, "Token Akses salah", context);
    return fail(401, "NIK, nomor HP, atau Token Akses salah.");
  }

  // Lapisan tambahan: jika penduduk sudah membuat password akun di menu Pengaturan.
  if (user.passwordHash) {
    if (!password) return fail(401, "Akun ini dilindungi password. Masukkan password akun Anda untuk melanjutkan.", { code: "PASSWORD_REQUIRED" });
    if (!verifyPassword(password, user.passwordHash)) {
      await recordLoginFailure(user.nik, "Password akun salah", context);
      return fail(401, "Password akun salah.", { code: "PASSWORD_INVALID" });
    }
  }
  return json(200, { user: publicUser(user, { withFiles: false }) });
}

async function register(req: Request, context: Context) {
  const body = await readBody(req);
  const nik = clean(body.nik, 20);
  const phone = digitsOnly(body.phone);
  const email = clean(body.email, 120).toLowerCase();
  if (!isValidNik(nik)) return fail(400, "NIK harus 16 digit angka.");
  if (!phone) return fail(400, "Nomor WhatsApp wajib diisi.");
  if (!email) return fail(400, "Alamat email wajib diisi untuk menerima notifikasi.");
  if (!EMAIL_PATTERN.test(email)) return fail(400, "Format alamat email tidak valid.");

  const user = await findResident(nik);
  if (!user) return fail(404, "NIK belum terdaftar. Silakan hubungi petugas Adminduk untuk pendataan.");
  if (!phoneVariants(phone).includes(digitsOnly(user.phone))) return fail(400, "Nomor WhatsApp tidak sesuai dengan data yang terdaftar pada petugas.");

  const now = Date.now();
  // Email disimpan sebagai data diri penduduk dan dipakai untuk semua notifikasi.
  const profile = { ...(user.profile || {}), email };
  const alreadyClaimed = tokenStatus(user) === "active";
  const token = alreadyClaimed ? user.token : generateToken();
  const expiresAt = alreadyClaimed ? user.tokenExpiresAt! : now + TOKEN_TTL_MS;
  await db.update(residents).set(alreadyClaimed
    ? { profile, updatedAt: now }
    : { token, tokenExpiresAt: expiresAt, tokenWarningSentFor: null, profile, updatedAt: now })
    .where(eq(residents.nik, nik));

  const emailTask = sendEmail(email, {
    subject: alreadyClaimed ? "Token Akses Anda masih aktif" : "Registrasi & klaim Token Akses berhasil",
    heading: alreadyClaimed ? "Token Akses Anda masih aktif" : "Registrasi berhasil",
    intro: `Halo ${user.name}, ${alreadyClaimed ? "Anda meminta ulang Token Akses yang masih berlaku." : "klaim Token Akses SIAGA DATA Anda berhasil."} Gunakan token berikut bersama NIK atau nomor HP untuk masuk.`,
    highlight: token,
    rows: [["NIK", nik], ["Berlaku sampai", formatWib(expiresAt)], ["Masa berlaku", `${TOKEN_TTL_HOURS} jam sejak klaim`]],
    note: `Setelah ${TOKEN_TTL_HOURS} jam token otomatis kedaluwarsa, sesi Anda berakhir, dan Anda perlu melakukan klaim ulang. Jangan bagikan token ini kepada siapa pun.`,
    tone: "success",
  });
  context.waitUntil?.(emailTask);

  return json(alreadyClaimed ? 200 : 201, { token, expiresAt, phone: user.phone, alreadyClaimed, email, ttlMs: TOKEN_TTL_MS });
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return fail(405, "Metode tidak diizinkan.");
  const path = new URL(req.url).pathname;
  try {
    return path.endsWith("/register") ? await register(req, context) : await login(req, context);
  } catch (error) {
    console.error(error);
    return fail(500, "Terjadi kesalahan pada server.");
  }
};

export const config: Config = { path: ["/api/login", "/api/register"] };
