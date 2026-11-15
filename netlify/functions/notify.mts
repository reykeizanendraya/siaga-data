import type { Config, Context } from "@netlify/functions";
import { clean, fail, json, readBody, requireResident, residentEmail } from "../lib/siaga.js";
import { formatWib, sendEmail } from "../lib/email.js";

// Meneruskan notifikasi (toast/peringatan) yang muncul di aplikasi ke email penduduk.
// Kredensial SMTP hanya ada di server; browser cukup mengirim judul & isi notifikasi
// bersama Token Akses aktif (header X-Siaga-Token), sehingga hanya pemilik akun yang bisa memicunya.
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return fail(405, "Metode tidak diizinkan.");
  try {
    const { user, error } = await requireResident(req, context.params.nik);
    if (error) return error;
    const body = await readBody(req);
    const title = clean(body.title, 120);
    const message = clean(body.message, 500);
    const page = clean(body.page, 120);
    if (!title) return fail(400, "Judul notifikasi wajib diisi.");
    const to = residentEmail(user);
    if (!to) return json(200, { sent: false, reason: "NO_EMAIL" });
    const tone = body.tone === "warning" ? "warning" : body.tone === "success" ? "success" : "info";
    context.waitUntil(sendEmail(to, {
      subject: title,
      heading: title,
      intro: `Halo ${user!.name}, notifikasi berikut baru saja muncul di aplikasi SIAGA DATA Anda.`,
      rows: [
        ...(message ? [["Notifikasi", message] as [string, string]] : []),
        ...(page ? [["Halaman", page] as [string, string]] : []),
        ["Waktu", formatWib(Date.now())],
      ],
      note: "Email ini dikirim otomatis agar Anda tidak melewatkan notifikasi apa pun dari SIAGA DATA.",
      tone,
    }));
    return json(202, { sent: true });
  } catch (error) {
    console.error(error);
    return fail(500, "Terjadi kesalahan pada server.");
  }
};

export const config: Config = { path: "/api/notify/:nik" };
