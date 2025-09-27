import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import expressLayouts from "express-ejs-layouts";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";

import {
  createPresence,
  listUpcomingSlots,
  getSlotById,
  createReservation,
  getReservationByToken,
  updateReservation,
  deleteReservationByToken,
  listReservations,
  listPresences,
  getPresenceById,
  countReservationsForPresence,
  updatePresenceWithRegeneration,
  deletePresence,
  listPresencesWithCounts
} from "./db.js";
import { sendConfirmationEmail } from "./email.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// EJS + layouts
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(expressLayouts);
app.set("layout", "layout");

// Static: dossier public/ à la racine du projet
app.use(express.static(path.join(process.cwd(), "public")));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Branding
const BRAND = {
  name: "Jus de pomme des pionniers d’Ecaussinnes",
  primary: "#7B1E2B",
  accent: "#B23A48"
};

// Auth admin via cookie JWT (serverless-friendly)
function setAdminCookie(res) {
  const token = jwt.sign({ admin: true }, process.env.SESSION_SECRET || "dev_secret", { expiresIn: "7d" });
  res.cookie("admin_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: !!process.env.VERCEL,
    path: "/"
  });
}
function clearAdminCookie(res) {
  res.clearCookie("admin_token", { path: "/" });
}
function requireAdmin(req, res, next) {
  const token = req.cookies?.admin_token;
  if (!token) return res.redirect("/admin/login");
  try {
    jwt.verify(token, process.env.SESSION_SECRET || "dev_secret");
    return next();
  } catch {
    return res.redirect("/admin/login");
  }
}
function isBeforeSlotStart(slotStartIso) {
  const now = new Date();
  const start = new Date(slotStartIso);
  return now < start;
}

// Health (optionnel)
app.get("/healthz", (req, res) => res.status(200).send("ok"));

// Accueil: calendrier + créneaux du jour sélectionné (?d=YYYY-MM-DD)
app.get("/", async (req, res) => {
  const allSlots = await listUpcomingSlots({});
  const counts = {};
  for (const s of allSlots) {
    const day = new Date(s.start_at).toISOString().slice(0, 10);
    counts[day] = (counts[day] || 0) + 1;
  }
  const availableDays = Object.keys(counts);
  let selectedDate = req.query.d && counts[req.query.d] ? req.query.d : (availableDays[0] || null);

  let groupedByLoc = {};
  if (selectedDate) {
    const daySlots = await listUpcomingSlots({ dateFilter: selectedDate });
    for (const s of daySlots) {
      const loc = s.location;
      if (!groupedByLoc[loc]) groupedByLoc[loc] = [];
      groupedByLoc[loc].push(s);
    }
  }

  res.render("index", {
    BRAND,
    selectedDate,
    availableDays,
    dayCounts: counts,
    groupedByLoc
  });
});

// Réservation
app.get("/reserve/:slotId", async (req, res) => {
  const slot = await getSlotById(Number(req.params.slotId));
  if (!slot) return res.status(404).send("Créneau introuvable");
  res.render("reserve", { BRAND, slot });
});
app.post("/reserve/:slotId", async (req, res) => {
  const slotId = Number(req.params.slotId);
  const slot = await getSlotById(slotId);
  if (!slot) return res.status(404).send("Créneau introuvable");

  const { first_name, last_name, phone, quantity, comment, email } = req.body;
  if (!first_name || !last_name || !phone || !quantity) {
    return res.status(400).send("Champs requis manquants");
  }
  const qty = parseInt(quantity, 10);
  if (isNaN(qty) || qty < 1) return res.status(400).send("Quantité invalide");

  const token = uuidv4();
  await createReservation({
    slot_id: slotId,
    first_name,
    last_name,
    phone,
    quantity: qty,
    comment: comment || null,
    token
  });

  const baseUrl = process.env.BASE_URL || `http://localhost:3000`;
  const reservation = {
    token,
    first_name,
    last_name,
    phone,
    quantity: qty,
    comment: comment || "",
    start_at: slot.start_at,
    location: slot.location,
    date: slot.date
  };

  if (email) {
    try {
      await sendConfirmationEmail({ to: email, reservation, baseUrl });
    } catch (e) {
      console.error("Erreur envoi email:", e);
    }
  }

  res.render("confirm", { BRAND, reservation, baseUrl, token, emailSent: !!email });
});

// Modifier / Annuler
app.get("/r/:token/edit", async (req, res) => {
  const r = await getReservationByToken(req.params.token);
  if (!r) return res.status(404).send("Réservation introuvable");
  if (!isBeforeSlotStart(r.start_at)) return res.status(403).send("Modification non autorisée (créneau commencé)");
  res.render("modify", { BRAND, r });
});
app.post("/r/:token/edit", async (req, res) => {
  const r = await getReservationByToken(req.params.token);
  if (!r) return res.status(404).send("Réservation introuvable");
  if (!isBeforeSlotStart(r.start_at)) return res.status(403).send("Modification non autorisée (créneau commencé)");

  const { first_name, last_name, phone, quantity, comment } = req.body;
  const qty = parseInt(quantity, 10);
  if (!first_name || !last_name || !phone || !qty || qty < 1) {
    return res.status(400).send("Champs requis invalides");
  }
  await updateReservation(req.params.token, { first_name, last_name, phone, quantity: qty, comment: comment || null });
  res.render("modified", { BRAND, r: { ...r, first_name, last_name, phone, quantity: qty, comment: comment || "" } });
});
app.get("/r/:token/cancel", async (req, res) => {
  const r = await getReservationByToken(req.params.token);
  if (!r) return res.status(404).send("Réservation introuvable");
  if (!isBeforeSlotStart(r.start_at)) return res.status(403).send("Annulation non autorisée (créneau commencé)");
  res.render("cancel_confirm", { BRAND, r });
});
app.post("/r/:token/cancel", async (req, res) => {
  const r = await getReservationByToken(req.params.token);
  if (!r) return res.status(404).send("Réservation introuvable");
  if (!isBeforeSlotStart(r.start_at)) return res.status(403).send("Annulation non autorisée (créneau commencé)");
  await deleteReservationByToken(req.params.token);
  res.render("canceled", { BRAND, r });
});

// Admin login/logout
app.get("/admin/login", (req, res) => {
  res.render("admin/login", { BRAND, error: null });
});
app.post("/admin/login", (req, res) => {
  const { password } = req.body;
  if (password && password === (process.env.ADMIN_PASSWORD || "admin")) {
    setAdminCookie(res);
    return res.redirect("/admin");
  }
  res.render("admin/login", { BRAND, error: "Mot de passe incorrect" });
});
app.post("/admin/logout", (req, res) => {
  clearAdminCookie(res);
  res.redirect("/admin/login");
});

// Admin pages
app.get("/admin", requireAdmin, async (req, res) => {
  const presences = await listPresences();
  const today = new Date().toISOString().slice(0, 10);
  const todayReservations = await listReservations({ date: today });
  res.render("admin/dashboard", { BRAND, presences, todayReservations });
});
app.get("/admin/presences/new", requireAdmin, (req, res) => {
  res.render("admin/presences_new", { BRAND, error: null });
});
app.post("/admin/presences/new", requireAdmin, async (req, res) => {
  const { location, date, start_time, end_time } = req.body;
  if (!location || !date || !start_time || !end_time) {
    return res.render("admin/presences_new", { BRAND, error: "Tous les champs sont requis" });
  }
  const start = new Date(`${date}T${start_time}:00Z`);
  const end = new Date(`${date}T${end_time}:00Z`);
  if (!(start < end)) {
    return res.render("admin/presences_new", { BRAND, error: "L'heure de fin doit être après l'heure de début" });
  }
  await createPresence({ location, date, start_time, end_time });
  res.redirect("/admin/presences");
});

// Gestion présences
app.get("/admin/presences", requireAdmin, async (req, res) => {
  const rows = await listPresencesWithCounts();
  res.render("admin/presences_index", { BRAND, presences: rows });
});
app.get("/admin/presences/:id/edit", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const presence = await getPresenceById(id);
  if (!presence) return res.status(404).send("Présence introuvable");
  const reservationsCount = await countReservationsForPresence(id);
  res.render("admin/presences_edit", { BRAND, presence, reservationsCount, error: null });
});
app.post("/admin/presences/:id/edit", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const presence = await getPresenceById(id);
  if (!presence) return res.status(404).send("Présence introuvable");

  const { location, date, start_time, end_time, confirm_impact } = req.body;
  if (!location || !date || !start_time || !end_time) {
    const reservationsCount = await countReservationsForPresence(id);
    return res.render("admin/presences_edit", { BRAND, presence, reservationsCount, error: "Tous les champs sont requis" });
  }
  const start = new Date(`${date}T${start_time}:00Z`);
  const end = new Date(`${date}T${end_time}:00Z`);
  if (!(start < end)) {
    const reservationsCount = await countReservationsForPresence(id);
    return res.render("admin/presences_edit", { BRAND, presence, reservationsCount, error: "L'heure de fin doit être après l'heure de début" });
  }
  const reservationsCount = await countReservationsForPresence(id);
  if (reservationsCount > 0 && !confirm_impact) {
    return res.render("admin/presences_edit", {
      BRAND,
      presence: { id, location, date, start_time, end_time },
      reservationsCount,
      error: "Cette modification va régénérer les créneaux et peut supprimer des réservations. Coche la case pour confirmer."
    });
  }
  await updatePresenceWithRegeneration(id, { location, date, start_time, end_time });
  res.redirect("/admin/presences");
});
app.get("/admin/presences/:id/delete", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const presence = await getPresenceById(id);
  if (!presence) return res.status(404).send("Présence introuvable");
  const reservationsCount = await countReservationsForPresence(id);
  res.render("admin/presences_delete_confirm", { BRAND, presence, reservationsCount });
});
app.post("/admin/presences/:id/delete", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const presence = await getPresenceById(id);
  if (!presence) return res.status(404).send("Présence introuvable");
  await deletePresence(id);
  res.redirect("/admin/presences");
});

// Liste réservations
app.get("/admin/reservations", requireAdmin, async (req, res) => {
  const { date, lieu } = req.query;
  const reservations = await listReservations({ date: date || null, location: lieu || "" });
  res.render("admin/reservations", { BRAND, reservations, query: { date: date || "", lieu: lieu || "" } });
});
app.post("/admin/reservations/delete", requireAdmin, async (req, res) => {
  const { token } = req.body;
  if (token) await deleteReservationByToken(token);
  res.redirect("/admin/reservations");
});

export default app;