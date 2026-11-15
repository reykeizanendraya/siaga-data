import type { Config, Context } from "@netlify/functions";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { helpdeskMessages, helpdeskTickets, residents } from "../../db/schema.js";
import { addActivity, clean, fail, findResident, json, readBody, requireResident } from "../lib/siaga.js";

// Helpdesk: tiket penduduk <-> petugas Adminduk.
// Status: open (menunggu petugas), answered (dibalas petugas), closed (selesai).
const CATEGORIES = ["Akun & Token Akses", "Dokumen Kependudukan", "Koreksi Data", "Secure Share", "Lainnya"];
type Ticket = typeof helpdeskTickets.$inferSelect;

async function withMessages(tickets: Ticket[], viewer: "user" | "admin") {
  if (!tickets.length) return [];
  const ids = tickets.map((ticket) => ticket.id);
  const messages = await db.select().from(helpdeskMessages).where(inArray(helpdeskMessages.ticketId, ids)).orderBy(asc(helpdeskMessages.createdAt));
  const niks = [...new Set(tickets.map((ticket) => ticket.nik))];
  const people = await db.select({ nik: residents.nik, name: residents.name, phone: residents.phone }).from(residents).where(inArray(residents.nik, niks));
  return tickets.map((ticket) => {
    const lastRead = viewer === "user" ? ticket.userLastReadAt : ticket.adminLastReadAt;
    const otherSide = viewer === "user" ? "admin" : "user";
    const resident = people.find((person) => person.nik === ticket.nik);
    return {
      ...ticket,
      residentName: resident?.name || "Penduduk",
      residentPhone: viewer === "admin" ? resident?.phone || "" : undefined,
      unread: ticket.lastSender === otherSide && ticket.updatedAt > lastRead,
      messages: messages.filter((message) => message.ticketId === ticket.id),
    };
  });
}

async function findTicket(id: string) {
  const ticketId = Number(id);
  if (!Number.isInteger(ticketId) || ticketId <= 0) return null;
  const [ticket] = await db.select().from(helpdeskTickets).where(eq(helpdeskTickets.id, ticketId)).limit(1);
  return ticket || null;
}

async function handleUser(req: Request, nik: string, ticketId?: string) {
  const { user, error } = await requireResident(req, nik);
  if (error) return error;
  const now = Date.now();

  if (!ticketId) {
    if (req.method === "GET") {
      const tickets = await db.select().from(helpdeskTickets).where(eq(helpdeskTickets.nik, nik)).orderBy(desc(helpdeskTickets.updatedAt));
      return json(200, { tickets: await withMessages(tickets, "user"), categories: CATEGORIES });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const subject = clean(body.subject, 120);
      const category = CATEGORIES.includes(body.category) ? body.category : "Lainnya";
      const message = clean(body.message, 2000);
      if (!subject || !message) return fail(400, "Judul dan isi pesan wajib diisi.");
      const [ticket] = await db.insert(helpdeskTickets).values({
        nik, subject, category, status: "open", lastSender: "user", userLastReadAt: now, createdAt: now, updatedAt: now,
      }).returning();
      await db.insert(helpdeskMessages).values({ ticketId: ticket.id, sender: "user", senderName: user.name, senderId: nik, body: message, createdAt: now });
      return json(201, { ticket: (await withMessages([ticket], "user"))[0] });
    }
    return fail(405, "Metode tidak diizinkan.");
  }

  const ticket = await findTicket(ticketId);
  if (!ticket || ticket.nik !== nik) return fail(404, "Tiket tidak ditemukan.");
  const body = await readBody(req);
  if (req.method === "POST") {
    const message = clean(body.message, 2000);
    if (!message) return fail(400, "Pesan tidak boleh kosong.");
    await db.insert(helpdeskMessages).values({ ticketId: ticket.id, sender: "user", senderName: user.name, senderId: nik, body: message, createdAt: now });
    await db.update(helpdeskTickets).set({ status: "open", lastSender: "user", updatedAt: now, userLastReadAt: now }).where(eq(helpdeskTickets.id, ticket.id));
  } else if (req.method === "PATCH") {
    if (body.action === "close") await db.update(helpdeskTickets).set({ status: "closed", lastSender: "user", updatedAt: now, userLastReadAt: now }).where(eq(helpdeskTickets.id, ticket.id));
    else await db.update(helpdeskTickets).set({ userLastReadAt: now }).where(eq(helpdeskTickets.id, ticket.id));
  } else return fail(405, "Metode tidak diizinkan.");
  return json(200, { ticket: (await withMessages([(await findTicket(ticketId))!], "user"))[0] });
}

async function handleAdmin(req: Request, context: Context, ticketId?: string) {
  const now = Date.now();
  if (!ticketId) {
    if (req.method !== "GET") return fail(405, "Metode tidak diizinkan.");
    const tickets = await db.select().from(helpdeskTickets).orderBy(desc(helpdeskTickets.updatedAt)).limit(200);
    return json(200, { tickets: await withMessages(tickets, "admin"), categories: CATEGORIES });
  }
  const ticket = await findTicket(ticketId);
  if (!ticket) return fail(404, "Tiket tidak ditemukan.");
  const body = await readBody(req);
  if (req.method === "POST") {
    const message = clean(body.message, 2000);
    const adminName = clean(body.adminName, 120) || "Petugas Adminduk";
    if (!message) return fail(400, "Pesan tidak boleh kosong.");
    await db.insert(helpdeskMessages).values({ ticketId: ticket.id, sender: "admin", senderName: adminName, senderId: clean(body.adminId, 40), body: message, createdAt: now });
    await db.update(helpdeskTickets).set({ status: "answered", lastSender: "admin", updatedAt: now, adminLastReadAt: now }).where(eq(helpdeskTickets.id, ticket.id));
    // Balasan petugas juga muncul di menu Notifikasi penduduk.
    const resident = await findResident(ticket.nik);
    await addActivity(ticket.nik, "Balasan Helpdesk", `Petugas membalas tiket #${ticket.id}: ${ticket.subject}`, "info", "ph-headset", { context, user: resident, email: {
      subject: `Balasan Helpdesk tiket #${ticket.id}`,
      heading: "Petugas membalas tiket Anda",
      intro: `Halo ${resident?.name || ""}, ${adminName} membalas tiket Helpdesk Anda "${ticket.subject}".`,
      rows: [["Tiket", `#${ticket.id} · ${ticket.category}`], ["Balasan", message.length > 400 ? message.slice(0, 400) + "…" : message]],
      note: "Masuk ke SIAGA DATA lalu buka menu Helpdesk untuk melihat percakapan lengkap dan membalas.",
    } });
  } else if (req.method === "PATCH") {
    if (body.action === "close") {
      await db.update(helpdeskTickets).set({ status: "closed", lastSender: "admin", updatedAt: now, adminLastReadAt: now }).where(eq(helpdeskTickets.id, ticket.id));
      await addActivity(ticket.nik, "Tiket Helpdesk selesai", `Tiket #${ticket.id} (${ticket.subject}) ditandai selesai oleh petugas.`, "info", "ph-check-circle", { context });
    } else if (body.action === "reopen") {
      await db.update(helpdeskTickets).set({ status: "open", updatedAt: now, adminLastReadAt: now }).where(eq(helpdeskTickets.id, ticket.id));
    } else {
      await db.update(helpdeskTickets).set({ adminLastReadAt: now }).where(eq(helpdeskTickets.id, ticket.id));
    }
  } else return fail(405, "Metode tidak diizinkan.");
  return json(200, { ticket: (await withMessages([(await findTicket(ticketId))!], "admin"))[0] });
}

export default async (req: Request, context: Context) => {
  const { nik, ticketId } = context.params;
  try {
    return new URL(req.url).pathname.startsWith("/api/helpdesk/admin") ? await handleAdmin(req, context, ticketId) : await handleUser(req, nik, ticketId);
  } catch (error) {
    console.error(error);
    return fail(500, "Terjadi kesalahan pada server.");
  }
};

export const config: Config = {
  path: ["/api/helpdesk/admin", "/api/helpdesk/admin/:ticketId", "/api/helpdesk/user/:nik", "/api/helpdesk/user/:nik/:ticketId"],
};
