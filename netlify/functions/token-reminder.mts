import type { Config } from "@netlify/functions";
import { and, eq, gt, isNull, lte, ne, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import { residents } from "../../db/schema.js";
import { TOKEN_TTL_HOURS, TOKEN_WARNING_MS, addActivity } from "../lib/siaga.js";
import { formatWib } from "../lib/email.js";

// Berjalan setiap 10 menit: kirim peringatan (email + notifikasi aplikasi) kepada penduduk
// yang Token Aksesnya akan kedaluwarsa dalam 30 menit ke depan. Satu peringatan per token.
export default async () => {
  const now = Date.now();
  const expiring = await db.select().from(residents).where(and(
    ne(residents.token, "BELUM_GENERATE"),
    gt(residents.tokenExpiresAt, now),
    lte(residents.tokenExpiresAt, now + TOKEN_WARNING_MS),
    or(isNull(residents.tokenWarningSentFor), ne(residents.tokenWarningSentFor, residents.token)),
  ));

  for (const user of expiring) {
    const minutes = Math.max(1, Math.round((user.tokenExpiresAt! - now) / 60000));
    await db.update(residents).set({ tokenWarningSentFor: user.token }).where(eq(residents.nik, user.nik));
    await addActivity(user.nik, "Token Akses segera berakhir", `Token Akses Anda berakhir dalam ±${minutes} menit (${formatWib(user.tokenExpiresAt!)}). Lakukan klaim ulang setelah kedaluwarsa.`, "warning", "ph-clock-countdown", { user, email: {
      subject: "Peringatan: Token Akses segera kedaluwarsa",
      heading: "Token Akses Anda segera berakhir",
      intro: `Halo ${user.name}, Token Akses SIAGA DATA Anda akan kedaluwarsa dalam sekitar ${minutes} menit.`,
      rows: [["NIK", user.nik], ["Kedaluwarsa pada", formatWib(user.tokenExpiresAt!)]],
      note: `Token berlaku ${TOKEN_TTL_HOURS} jam sejak diklaim. Setelah kedaluwarsa, sesi Anda otomatis berakhir. Buka halaman login lalu pilih "Daftar / Klaim Token" untuk mendapatkan token baru.`,
      tone: "warning",
    } });
  }
  console.log(`[token-reminder] ${expiring.length} peringatan diproses.`);
};

export const config: Config = { schedule: "*/10 * * * *" };
