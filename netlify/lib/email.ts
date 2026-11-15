import nodemailer from "nodemailer";

// Pengiriman email notifikasi SIAGA DATA lewat SMTP Gmail.
// Kredensial HANYA dibaca dari environment variable Netlify (tidak pernah dikirim ke browser):
//   SMTP_USER  – alamat Gmail pengirim (default: siagadatabersama@gmail.com)
//   SMTP_PASS  – App Password Gmail (16 karakter) untuk akun tersebut
//   SMTP_HOST / SMTP_PORT – opsional, default smtp.gmail.com:465
const DEFAULT_SENDER = "siagadatabersama@gmail.com";
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  const pass = process.env.SMTP_PASS;
  if (!pass) return null;
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT || 465);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER || DEFAULT_SENDER, pass },
    });
  }
  return transporter;
}

const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const formatWib = (ms: number) =>
  new Date(ms).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" }) + " WIB";

type Row = [label: string, value: string];

export interface MailContent {
  subject: string;
  heading: string;
  intro: string;
  rows?: Row[];
  highlight?: string;
  note?: string;
  tone?: "info" | "warning" | "success";
}

function render({ heading, intro, rows = [], highlight, note, tone = "info" }: MailContent) {
  const accent = { info: "#0F52BA", warning: "#F5A623", success: "#2EBA6D" }[tone];
  const rowsHtml = rows.map(([label, value]) =>
    `<tr><td style="padding:6px 0;color:#7F8C8D;width:42%">${escapeHtml(label)}</td><td style="padding:6px 0;font-weight:600;color:#2C3E50">${escapeHtml(value)}</td></tr>`).join("");
  const html = `<!doctype html><html><body style="margin:0;background:#F8FAFC;font-family:Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #E2E8F0">
      <tr><td style="background:#0F52BA;color:#fff;padding:18px 24px;font-size:18px;font-weight:700">&#128737; SIAGA DATA</td></tr>
      <tr><td style="height:4px;background:${accent}"></td></tr>
      <tr><td style="padding:24px">
        <h2 style="margin:0 0 12px;color:#2C3E50;font-size:20px">${escapeHtml(heading)}</h2>
        <p style="margin:0 0 16px;color:#2C3E50;line-height:1.6">${escapeHtml(intro)}</p>
        ${highlight ? `<div style="margin:0 0 16px;padding:14px;border-radius:8px;background:#E6F0FA;text-align:center;font-size:22px;font-weight:700;letter-spacing:2px;color:#0B3D8A">${escapeHtml(highlight)}</div>` : ""}
        ${rowsHtml ? `<table role="presentation" width="100%" style="font-size:14px;border-top:1px solid #E2E8F0;border-bottom:1px solid #E2E8F0;margin-bottom:16px">${rowsHtml}</table>` : ""}
        ${note ? `<p style="margin:0;color:#7F8C8D;font-size:13px;line-height:1.6">${escapeHtml(note)}</p>` : ""}
      </td></tr>
      <tr><td style="padding:14px 24px;background:#F8FAFC;color:#7F8C8D;font-size:12px">Email otomatis dari SIAGA DATA – Sistem Informasi dan Keamanan Data Kependudukan. Jangan membalas email ini. Jika Anda tidak merasa melakukan aktivitas ini, segera hubungi petugas melalui menu Helpdesk.</td></tr>
    </table>
  </td></tr></table></body></html>`;
  const text = [heading, "", intro, highlight ? `\n${highlight}\n` : "", ...rows.map(([l, v]) => `${l}: ${v}`), "", note || "", "", "— SIAGA DATA"].join("\n");
  return { html, text };
}

/** Mengirim email; tidak pernah melempar error agar alur utama aplikasi tetap berjalan. */
export async function sendEmail(to: string | undefined | null, content: MailContent): Promise<boolean> {
  if (!to || !EMAIL_PATTERN.test(to)) return false;
  const transport = getTransporter();
  if (!transport) {
    console.warn("[email] SMTP_PASS belum diatur, email tidak dikirim:", content.subject);
    return false;
  }
  try {
    const { html, text } = render(content);
    await transport.sendMail({
      from: `"SIAGA DATA" <${process.env.SMTP_USER || DEFAULT_SENDER}>`,
      to,
      subject: `[SIAGA DATA] ${content.subject}`,
      html,
      text,
    });
    return true;
  } catch (error) {
    console.error("[email] Gagal mengirim email:", (error as Error).message);
    return false;
  }
}
