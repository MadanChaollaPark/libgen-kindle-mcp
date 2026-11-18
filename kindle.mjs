import nodemailer from "nodemailer";

const mailbox = /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const kindleMailbox = /^[a-z0-9._%+-]+@kindle\.com$/i;

export function configureKindle(env = process.env) {
  const to = env.KINDLE_EMAIL;
  const from = env.SMTP_FROM || env.SMTP_USER;
  const port = Number(env.SMTP_PORT || 587);
  const maxBytes = Number(env.KINDLE_MAX_BYTES || 18_000_000);
  if (!kindleMailbox.test(to ?? "") || !mailbox.test(from ?? "") ||
      !env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    throw new Error("Set KINDLE_EMAIL and the SMTP settings in .env before sending.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SMTP_PORT must be between 1 and 65535.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 50_000_000) {
    throw new Error("KINDLE_MAX_BYTES must be between 1 and 50000000.");
  }
  const secure = port === 465;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure,
    requireTLS: !secure,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 25_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return { to, from, transport, maxBytes };
}

export async function sendBook({ to, from, transport }, { book, content, filename }) {
  const contentType = book.format === "epub" ? "application/epub+zip" : "application/pdf";
  let receipt;
  try {
    receipt = await transport.sendMail({
      from,
      to,
      subject: "Send to Kindle",
      text: "Ebook attached.",
      attachments: [{ filename, content, contentType }],
    });
  } catch (error) {
    const code = /^E[A-Z]{2,20}$/.test(error.code) ? ` (${error.code})` : "";
    throw new Error(`SMTP submission failed${code}. Check the mail provider before retrying.`);
  }
  if (!receipt.accepted.some((address) => address.toLowerCase() === to.toLowerCase())) {
    throw new Error("The SMTP server did not accept the Kindle address.");
  }
  return { status: "smtp_accepted", message_id: receipt.messageId, filename, bytes: content.length };
}
