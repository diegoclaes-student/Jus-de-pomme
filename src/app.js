import express from "express";
import session from "express-session";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import expressLayouts from "express-ejs-layouts";
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
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(expressLayouts);
app.set("layout", "layout");

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev_secret",
    resave: false,
    saveUninitialized: false,
    cookie: { sameSite: "lax" }
  })
);

// Branding constants
const BRAND = {
  name: "Jus de pomme des pionniers d’Ecaussinnes",
  primary: "#7B1E2B",
  accent: "#B23A48"
};

// Helpers
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect("/admin/login");
}
function isBeforeSlotStart(slotStartIso) {
  const now = new Date();
  const start = new Date(slotStartIso);
  return now < start;
}

// Routes - Client (Calendrier + créneaux du jour sélectionné)
app.get("/", (req, res) => {
  const allSlots = listUpcomingSlots({});
  const counts = {};
  for (const s of allSlots) {
    const day = s.start_at.slice(0, 10);
    counts[day] = (counts[day] || 0) + 1;
  }
  const availableDays = Object.keys(counts);
  let selectedDate = req.query.d && counts[req.query.d] ? req.query.d : (availableDays[0] || null);

  let groupedByLoc = {};
  if (selectedDate) {
    const daySlots = listUpcomingSlots({ dateFilter: selectedDate });
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

app.get("/reserve/:slotId", (req, res) => {
  const slot = getSlotById(Number(req.params.slotId));
  if (!slot) return res.status(404).send("Créneau introuvable");
  res.render("reserve", { BRAND, slot });
});

app.post("/reserve/:slotId", async (req, res) => {
  const slotId = Number(req.params.slotId);
  const slot = getSlotById(slotId);
  if (!slot) return res.status(404).send("Créneau introuvable");

  const { first_name, last_name, phone, quantity, comment, email } = req.body;
  if (!first_name || !last_name || !phone || !quantity) {
    return res.status(400).send("Champs requis manquants");
  }
  const qty = parseInt(quantity, 10);
  if (isNaN(qty) || qty < 1) return res.status(400).send("Quantité invalide");

  const token = uuidv4();
  createReservation({
    slot_id: slotId,
    first_name,
    last_name,
    phone,
    quantity: qty,
    comment: comment || null,
    token
  });

  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
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

app.get("/r/:token/edit", (req, res) => {
  const r = getReservationByToken(req.params.token);
  if (!r) return res.status(404).send("Réservation introuvable");
  if (!isBeforeSlotStart(r.start_at)) return res.status(403).send("Modification non autorisée (créneau commencé)");
  res.render("modify", { BRAND, r });
});

app.post("/r/:token/edit", (req, res) => {
  const r = getReservationByToken(req.params.token);
  if (!r) return res.status(404).send("Réservation introuvable");
  if (!isBeforeSlotStart(r.start_at)) return res.status(403).send("Modification non autorisée (créneau commencé)");

  const { first_name, last_name, phone, quantity, comment } = req.body;
  const qty = parseInt(quantity, 10);
  if (!first_name || !last_name || !phone || !qty || qty < 1) {
    return res.status(400).send("Champs requis invalides");
  }
  updateReservation(req.params.token, { first_name, last_name, phone, quantity: qty, comment: comment || null });

  res.render("modified", { BRAND, r: { ...r, first_name, last_name, phone, quantity: qty, comment: comment || "" } });
});

app.get("/r/:token/cancel", (req, res) => {
  const r = getReservationByToken(req.params.token);
  if (!r) return res.status(404).send("Réservation introuvable");
  if (!isBeforeSlotStart(r.start_at)) return res.status(403).send("Annulation non autorisée (créneau commencé)");
  res.render("cancel_confirm", { BRAND, r });
});

app.post("/r/:token/cancel", (req, res) => {
  const r = getReservationByToken(req.params.token);
  if (!r) return res.status(404).send("Réservation introuvable");
  if (!isBeforeSlotStart(r.start_at)) return res.status(403).send("Annulation non autorisée (créneau commencé)");
  deleteReservationByToken(req.params.token);
  res.render("canceled", { BRAND, r });
});

// Admin
app.get("/admin/login", (req, res) => {
  res.render("admin/login", { BRAND, error: null });
});
app.post("/admin/login", (req, res) => {
  const { password } = req.body;
  if (password && password === (process.env.ADMIN_PASSWORD || "admin")) {
    req.session.isAdmin = true;
    return res.redirect("/admin");
  }
  res.render("admin/login", { BRAND, error: "Mot de passe incorrect" });
});
app.post("/admin/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"));
});

app.get("/admin", requireAdmin, (req, res) => {
  const presences = listPresences();
  const today = new Date().toISOString().slice(0, 10);
  const todayReservations = listReservations({ date: today });
  res.render("admin/dashboard", { BRAND, presences, todayReservations });
});

app.get("/admin/presences/new", requireAdmin, (req, res) => {
  res.render("admin/presences_new", { BRAND, error: null });
});
app.post("/admin/presences/new", requireAdmin, (req, res) => {
  const { location, date, start_time, end_time } = req.body;
  if (!location || !date || !start_time || !end_time) {
    return res.render("admin/presences_new", { BRAND, error: "Tous les champs sont requis" });
  }
  const start = new Date(`${date}T${start_time}:00`);
  const end = new Date(`${date}T${end_time}:00`);
  if (!(start < end)) {
    return res.render("admin/presences_new", { BRAND, error: "L'heure de fin doit être après l'heure de début" });
  }
  createPresence({ location, date, start_time, end_time });
  res.redirect("/admin/presences");
});

/* ===== Gestion des présences ===== */

// Liste et actions
app.get("/admin/presences", requireAdmin, (req, res) => {
  const rows = listPresencesWithCounts();
  res.render("admin/presences_index", { BRAND, presences: rows });
});

// Edit form
app.get("/admin/presences/:id/edit", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const presence = getPresenceById(id);
  if (!presence) return res.status(404).send("Présence introuvable");
  const reservationsCount = countReservationsForPresence(id);
  res.render("admin/presences_edit", { BRAND, presence, reservationsCount, error: null });
});

// Edit submit (avec régénération des créneaux)
app.post("/admin/presences/:id/edit", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const presence = getPresenceById(id);
  if (!presence) return res.status(404).send("Présence introuvable");

  const { location, date, start_time, end_time, confirm_impact } = req.body;
  if (!location || !date || !start_time || !end_time) {
    const reservationsCount = countReservationsForPresence(id);
    return res.render("admin/presences_edit", { BRAND, presence, reservationsCount, error: "Tous les champs sont requis" });
  }
  const start = new Date(`${date}T${start_time}:00`);
  const end = new Date(`${date}T${end_time}:00`);
  if (!(start < end)) {
    const reservationsCount = countReservationsForPresence(id);
    return res.render("admin/presences_edit", { BRAND, presence, reservationsCount, error: "L'heure de fin doit être après l'heure de début" });
  }

  const reservationsCount = countReservationsForPresence(id);
  if (reservationsCount > 0 && !confirm_impact) {
    // Demander confirmation explicite
    return res.render("admin/presences_edit", {
      BRAND,
      presence: { id, location, date, start_time, end_time },
      reservationsCount,
      error: "Cette modification va supprimer des créneaux existants et leurs réservations. Coche la case de confirmation pour continuer."
    });
  }

  updatePresenceWithRegeneration(id, { location, date, start_time, end_time });
  res.redirect("/admin/presences");
});

// Delete confirm page
app.get("/admin/presences/:id/delete", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const presence = getPresenceById(id);
  if (!presence) return res.status(404).send("Présence introuvable");
  const reservationsCount = countReservationsForPresence(id);
  res.render("admin/presences_delete_confirm", { BRAND, presence, reservationsCount });
});

// Delete action
app.post("/admin/presences/:id/delete", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const presence = getPresenceById(id);
  if (!presence) return res.status(404).send("Présence introuvable");

  // Optionnel: vérifier confirm suppression
  deletePresence(id);
  res.redirect("/admin/presences");
});

// Réservations
app.get("/admin/reservations", requireAdmin, (req, res) => {
  const { date, lieu } = req.query;
  const reservations = listReservations({ date: date || null, location: lieu || "" });
  res.render("admin/reservations", { BRAND, reservations, query: { date: date || "", lieu: lieu || "" } });
});
app.post("/admin/reservations/delete", requireAdmin, (req, res) => {
  const { token } = req.body;
  if (token) deleteReservationByToken(token);
  res.redirect("/admin/reservations");
});

// Start
app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});