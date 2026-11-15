import type { Config, Context } from "@netlify/functions";
import { randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { db } from "../../db/index.js";
import { shares } from "../../db/schema.js";
import { SHARE_TTL_MS, addActivity, clean, fail, findResident, isValidNik, json, readBody } from "../lib/siaga.js";
import { formatWib } from "../lib/email.js";

async function createShare(req: Request, context: Context) {
  const body = await readBody(req);
  const ownerNik = clean(body.ownerNik, 20);
  const documentId = clean(body.documentId, 20);
  const target = clean(body.target, 120) || "Instansi Umum";
  const targetCategory = clean(body.targetCategory, 80);
  const purpose = clean(body.purpose, 120);
  if (!isValidNik(ownerNik)) return fail(400, "NIK tidak valid.");
  const user = await findResident(ownerNik);
  const doc = user?.documents.find((item) => item.id === documentId);
  if (!doc?.fileData) return fail(404, "Dokumen tidak ditemukan.");
  const now = Date.now();
  await db.delete(shares).where(lt(shares.expiresAt, now));
  const id = randomBytes(24).toString("base64url");
  const expiresAt = now + SHARE_TTL_MS;
  await db.insert(shares).values({ id, ownerNik, documentId, target, targetCategory, purpose, expiresAt, createdAt: now });
  const url = `${new URL(req.url).origin}/akses-dokumen.html?id=${encodeURIComponent(id)}`;
  const recipient = targetCategory ? `${target} (${targetCategory})` : target;
  await addActivity(ownerNik, "Dokumen dibagikan", `${doc.name || "Dokumen"} dibagikan kepada ${recipient}${purpose ? ` untuk ${purpose}` : ""}. Akses berlaku 5 menit.`, "info", "ph-share-network", { context, user, email: {
    subject: `Dokumen ${doc.name || ""} dibagikan`,
    heading: "Dokumen Anda dibagikan",
    intro: `Halo ${user!.name}, dokumen Anda baru saja dibagikan melalui Secure Share SIAGA DATA.`,
    rows: [
      ["Dokumen", String(doc.name || "-")],
      ["Dibagikan kepada", target],
      ["Kategori penerima", targetCategory || "-"],
      ["Tujuan penggunaan", purpose || "-"],
      ["Akses berakhir", formatWib(expiresAt)],
    ],
    note: "Tautan hanya berlaku 5 menit dan dilindungi watermark. Anda akan menerima email lagi saat dokumen dibuka oleh penerima.",
  } });
  return json(201, { id, expiresAt, url });
}

async function openShare(id: string, context: Context) {
  const [share] = await db.select().from(shares).where(and(eq(shares.id, id), gt(shares.expiresAt, Date.now()))).limit(1);
  if (!share) return fail(404, "Tautan tidak valid atau sudah kedaluwarsa.");
  const user = await findResident(share.ownerNik);
  const doc = user?.documents.find((item) => item.id === share.documentId);
  if (!doc) return fail(404, "Dokumen tidak lagi tersedia.");
  const by = share.target ? ` oleh ${share.target}` : "";
  await addActivity(share.ownerNik, "Akses dokumen oleh pihak luar", `Dokumen ${doc.name || "penduduk"} dibuka${by} melalui tautan QR.`, "info", "ph-eye", { context, user, email: {
    subject: `Dokumen ${doc.name || ""} sedang dibuka`,
    heading: "Dokumen Anda sedang diakses",
    intro: `Halo ${user!.name}, dokumen yang Anda bagikan baru saja dibuka melalui tautan Secure Share.`,
    rows: [["Dokumen", String(doc.name || "-")], ["Penerima", share.target || "-"], ["Waktu akses", formatWib(Date.now())], ["Tautan berakhir", formatWib(share.expiresAt)]],
    note: "Jika Anda tidak merasa membagikan dokumen ini, segera hubungi petugas melalui Helpdesk.",
    tone: "warning",
  } });
  const { id: docId, name, fileName, fileType, fileData } = doc as Record<string, unknown>;
  return json(200, { document: { id: docId, name, fileName, fileType, fileData }, expiresAt: share.expiresAt, target: share.target, purpose: share.purpose });
}

export default async (req: Request, context: Context) => {
  try {
    if (context.params.id) return req.method === "GET" ? await openShare(context.params.id, context) : fail(405, "Metode tidak diizinkan.");
    return req.method === "POST" ? await createShare(req, context) : fail(405, "Metode tidak diizinkan.");
  } catch (error) {
    console.error(error);
    return fail(500, "Terjadi kesalahan pada server.");
  }
};

export const config: Config = { path: ["/api/shares", "/api/shares/:id"] };
