const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");

const smtpConfig = {
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: false,
  requireTLS: process.env.SMTP_PORT == 587,
};

if (process.env.SMTP_USER) {
  smtpConfig.auth = {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  };
}

const transporter = nodemailer.createTransport(smtpConfig);

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const TEMPLATE = fs.readFileSync(
  path.join(__dirname, "..", "templates", "contact-email.html"),
  "utf8"
);

function render(vars) {
  return TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

async function sendContactEmail({ name, email, phone, message, meta = {} }) {
  const fromAddress = process.env.EMAIL_FROM;
  const toAddress = process.env.CONTACT_TO;

  const text =
    `New contact message received:\n\n` +
    `Name: ${name}\n` +
    `Email: ${email}\n` +
    `Phone: ${phone || "N/A"}\n\n` +
    `Message:\n${message}\n\n` +
    `---\n` +
    `IP: ${meta.ipAddress || "N/A"}\n` +
    `User-Agent: ${meta.userAgent || "N/A"}\n`;

  const html = render({
    name: escapeHtml(name),
    email: escapeHtml(email),
    phone: escapeHtml(phone || "N/A"),
    messageHtml: (escapeHtml(message || "").replace(/\n/g, "<br>") || "—"),
    ip: escapeHtml(meta.ipAddress || "N/A"),
    ua: escapeHtml(meta.userAgent || "N/A"),
  });

  return transporter.sendMail({
    from: fromAddress,
    to: toAddress,
    replyTo: email,
    subject: "New Contact Message Received",
    text,
    html,
    attachments: [
      {
        filename: "test.jpg",
        path: path.join(__dirname, "..", "images", "test.jpg"),
        cid: "test",
      },
    ],
  });
}

module.exports = { sendContactEmail };