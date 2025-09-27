import nodemailer from "nodemailer";

function hasSmtp() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM);
}

let transporter = null;

export function getTransporter() {
  if (transporter) return transporter;

  if (hasSmtp()) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
  } else {
    // Fallback: log en console
    transporter = {
      sendMail: async (opts) => {
        console.log("[EMAIL SIMULÉ] À:", opts.to);
        console.log("Sujet:", opts.subject);
        console.log("Texte:", opts.text);
        console.log("HTML:", opts.html);
        return { messageId: "console-log" };
      }
    };
  }
  return transporter;
}

export async function sendConfirmationEmail({ to, reservation, baseUrl }) {
  const { token, first_name, last_name, phone, quantity, comment, start_at, location, date } = reservation;
  const start = new Date(start_at);
  const hh = String(start.getHours()).padStart(2, "0");
  const mm = String(start.getMinutes()).padStart(2, "0");

  const modifyUrl = `${baseUrl}/r/${token}/edit`;
  const cancelUrl = `${baseUrl}/r/${token}/cancel`;

  const subject = "Confirmation – Réservation jus de pomme";
  const text = `Merci pour votre réservation !

Détails:
- Lieu: ${location}
- Date: ${date}
- Heure: ${hh}:${mm}
- Nom: ${first_name} ${last_name}
- Téléphone: ${phone}
- Quantité: ${quantity}
${comment ? "- Commentaire: " + comment : ""}

Modifier: ${modifyUrl}
Annuler: ${cancelUrl}
`;

  const html = `
  <div style="font-family:Arial,sans-serif">
    <h2>Confirmation – Réservation jus de pomme</h2>
    <p><strong>Merci de soutenir les pionniers d’Ecaussinnes !</strong></p>
    <ul>
      <li><b>Lieu:</b> ${location}</li>
      <li><b>Date:</b> ${date}</li>
      <li><b>Heure:</b> ${hh}:${mm}</li>
      <li><b>Nom:</b> ${first_name} ${last_name}</li>
      <li><b>Téléphone:</b> ${phone}</li>
      <li><b>Quantité:</b> ${quantity}</li>
      ${comment ? `<li><b>Commentaire:</b> ${comment}</li>` : ""}
    </ul>
    <p>
      <a href="${modifyUrl}">Modifier ma réservation</a> |
      <a href="${cancelUrl}">Annuler ma réservation</a>
    </p>
  </div>
  `;

  const from = process.env.SMTP_FROM || "no-reply@example.com";
  await getTransporter().sendMail({ from, to, subject, text, html });
}