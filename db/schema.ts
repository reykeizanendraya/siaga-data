import { pgTable, serial, text, bigint, jsonb, integer, index } from "drizzle-orm/pg-core";

// Data penduduk (dikelola petugas, sebagian bisa dilengkapi sendiri oleh penduduk).
export const residents = pgTable("residents", {
  nik: text().primaryKey(),
  name: text().notNull(),
  phone: text().notNull().default(""),
  token: text().notNull().default("BELUM_GENERATE"),
  tokenExpiresAt: bigint("token_expires_at", { mode: "number" }),
  documents: jsonb().$type<Record<string, unknown>[]>().notNull().default([]),
  // Data diri tambahan yang dapat dilengkapi penduduk dari menu Pengaturan.
  profile: jsonb().$type<Record<string, string>>().notNull().default({}),
  // Preferensi keamanan (verifikasi 2 langkah, biometrik).
  settings: jsonb().$type<Record<string, boolean>>().notNull().default({}),
  passwordHash: text("password_hash"),
  passwordUpdatedAt: bigint("password_updated_at", { mode: "number" }),
  // Token yang sudah dikirimi email peringatan "akan kedaluwarsa" (agar tidak terkirim berulang).
  tokenWarningSentFor: text("token_warning_sent_for"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// Riwayat aktivitas penduduk di aplikasi.
export const history = pgTable("history", {
  id: serial().primaryKey(),
  nik: text().notNull(),
  entity: text().notNull(),
  action: text().notNull(),
  description: text().notNull(),
  status: text().notNull().default("Berhasil"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [index("history_nik_idx").on(t.nik, t.createdAt)]);

// Notifikasi untuk penduduk (akses dokumen oleh pihak luar, peringatan keamanan, balasan helpdesk).
export const activities = pgTable("activities", {
  id: serial().primaryKey(),
  nik: text().notNull(),
  title: text().notNull(),
  description: text().notNull(),
  type: text().notNull().default("info"),
  icon: text().notNull().default("ph-info"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [index("activities_nik_idx").on(t.nik, t.createdAt)]);

// Percobaan login gagal untuk deteksi aktivitas mencurigakan.
export const loginFailures = pgTable("login_failures", {
  id: serial().primaryKey(),
  nik: text().notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [index("login_failures_nik_idx").on(t.nik, t.createdAt)]);

// Tautan Secure Share / QR sementara (5 menit).
export const shares = pgTable("shares", {
  id: text().primaryKey(),
  ownerNik: text("owner_nik").notNull(),
  documentId: text("document_id").notNull(),
  // Penerima & tujuan pembagian (dipilih penduduk di Secure Share).
  target: text().notNull().default(""),
  targetCategory: text("target_category").notNull().default(""),
  purpose: text().notNull().default(""),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// Helpdesk: tiket yang dibuat penduduk dan ditangani petugas.
export const helpdeskTickets = pgTable("helpdesk_tickets", {
  id: serial().primaryKey(),
  nik: text().notNull(),
  subject: text().notNull(),
  category: text().notNull(),
  status: text().notNull().default("open"),
  lastSender: text("last_sender").notNull().default("user"),
  userLastReadAt: bigint("user_last_read_at", { mode: "number" }).notNull().default(0),
  adminLastReadAt: bigint("admin_last_read_at", { mode: "number" }).notNull().default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [index("helpdesk_tickets_nik_idx").on(t.nik)]);

export const helpdeskMessages = pgTable("helpdesk_messages", {
  id: serial().primaryKey(),
  ticketId: integer("ticket_id").notNull().references(() => helpdeskTickets.id, { onDelete: "cascade" }),
  sender: text().notNull(),
  senderName: text("sender_name").notNull(),
  senderId: text("sender_id").notNull().default(""),
  body: text().notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [index("helpdesk_messages_ticket_idx").on(t.ticketId)]);
