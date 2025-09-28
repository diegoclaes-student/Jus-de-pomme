import { sql } from "@vercel/postgres";

// Création du schéma (idempotent)
let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;
  await sql`CREATE TABLE IF NOT EXISTS presences (
    id SERIAL PRIMARY KEY,
    location TEXT NOT NULL,
    date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL
  );`;

  await sql`CREATE TABLE IF NOT EXISTS slots (
    id SERIAL PRIMARY KEY,
    presence_id INTEGER NOT NULL REFERENCES presences(id) ON DELETE CASCADE,
    start_at TIMESTAMPTZ NOT NULL,
    UNIQUE (presence_id, start_at)
  );`;

  await sql`CREATE TABLE IF NOT EXISTS reservations (
    id SERIAL PRIMARY KEY,
    slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity >= 1),
    comment TEXT,
    token TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`;
  schemaEnsured = true;
}

export async function createPresence({ location, date, start_time, end_time }) {
  await ensureSchema();
  const { rows } = await sql.begin(async (tx) => {
    const inserted = await tx`
      INSERT INTO presences (location, date, start_time, end_time)
      VALUES (${location}, ${date}, ${start_time}, ${end_time})
      RETURNING id
    `;
    const presenceId = inserted.rows[0].id;

    const ts = `${date} ${start_time}:00+00`;
    const te = `${date} ${end_time}:00+00`;

    await tx`
      INSERT INTO slots (presence_id, start_at)
      SELECT ${presenceId}, gs
      FROM generate_series(
        ${tx.unsafe(ts)}::timestamptz,
        (${tx.unsafe(te)}::timestamptz - interval '15 minutes'),
        interval '15 minutes'
      ) AS gs
      ON CONFLICT DO NOTHING
    `;
    return inserted;
  });
  return rows[0].id;
}

export async function listUpcomingSlots({ dateFilter = null, locationFilter = "" } = {}) {
  await ensureSchema();
  let q = `
    SELECT s.id AS slot_id, s.start_at, p.location, p.date
    FROM slots s
    JOIN presences p ON p.id = s.presence_id
    WHERE s.start_at >= NOW()
  `;
  const params = [];
  if (dateFilter) {
    params.push(dateFilter);
    q += ` AND s.start_at::date = $${params.length}`;
  }
  if (locationFilter) {
    params.push(`%${locationFilter}%`);
    q += ` AND p.location ILIKE $${params.length}`;
  }
  q += ` ORDER BY p.date ASC, p.location ASC, s.start_at ASC`;
  const { rows } = await sql.query(q, params);
  return rows;
}

export async function getSlotById(slotId) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT s.*, p.location, p.date
    FROM slots s
    JOIN presences p ON p.id = s.presence_id
    WHERE s.id = ${slotId}
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function createReservation({ slot_id, first_name, last_name, phone, quantity, comment, token }) {
  await ensureSchema();
  const { rows } = await sql`
    INSERT INTO reservations (slot_id, first_name, last_name, phone, quantity, comment, token)
    VALUES (${slot_id}, ${first_name}, ${last_name}, ${phone}, ${quantity}, ${comment}, ${token})
    RETURNING id
  `;
  return rows[0].id;
}

export async function getReservationByToken(token) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT r.*, s.start_at, p.location, p.date
    FROM reservations r
    JOIN slots s ON s.id = r.slot_id
    JOIN presences p ON p.id = s.presence_id
    WHERE r.token = ${token}
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function updateReservation(token, { first_name, last_name, phone, quantity, comment }) {
  await ensureSchema();
  await sql`
    UPDATE reservations
    SET first_name=${first_name}, last_name=${last_name}, phone=${phone}, quantity=${quantity}, comment=${comment}
    WHERE token=${token}
  `;
}

export async function deleteReservationByToken(token) {
  await ensureSchema();
  await sql`DELETE FROM reservations WHERE token=${token}`;
}

export async function listReservations({ date = null, location = "" } = {}) {
  await ensureSchema();
  let q = `
    SELECT r.id, r.first_name, r.last_name, r.phone, r.quantity, r.comment, r.created_at,
           s.start_at, p.location, p.date, r.token
    FROM reservations r
    JOIN slots s ON s.id = r.slot_id
    JOIN presences p ON p.id = s.presence_id
    WHERE 1=1
  `;
  const params = [];
  if (date) { 
    params.push(date); 
    q += ` AND p.date = $${params.length}`; 
  }
  if (location) { 
    params.push(`%${location}%`); 
    q += ` AND p.location ILIKE $${params.length}`; 
  }
  // Limiter les résultats pour éviter les timeouts
  q += ` ORDER BY p.date ASC, s.start_at ASC LIMIT 100`;
  const { rows } = await sql.query(q, params);
  return rows;
}

export async function listPresences() {
  await ensureSchema();
  const { rows } = await sql`SELECT * FROM presences ORDER BY date ASC, start_time ASC LIMIT 50`;
  return rows;
}

// Gestion présences
export async function getPresenceById(id) {
  await ensureSchema();
  const { rows } = await sql`SELECT * FROM presences WHERE id=${id} LIMIT 1`;
  return rows[0] || null;
}
export async function countReservationsForPresence(presenceId) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT COUNT(*)::int AS cnt
    FROM reservations r
    JOIN slots s ON s.id = r.slot_id
    WHERE s.presence_id = ${presenceId}
  `;
  return rows[0]?.cnt || 0;
}
export async function updatePresenceWithRegeneration(presenceId, { location, date, start_time, end_time }) {
  await ensureSchema();
  await sql.begin(async (tx) => {
    await tx`
      UPDATE presences
      SET location=${location}, date=${date}, start_time=${start_time}, end_time=${end_time}
      WHERE id=${presenceId}
    `;
    await tx`DELETE FROM slots WHERE presence_id=${presenceId}`;
    const ts = `${date} ${start_time}:00+00`;
    const te = `${date} ${end_time}:00+00`;
    await tx`
      INSERT INTO slots (presence_id, start_at)
      SELECT ${presenceId}, gs
      FROM generate_series(
        ${tx.unsafe(ts)}::timestamptz,
        (${tx.unsafe(te)}::timestamptz - interval '15 minutes'),
        interval '15 minutes'
      ) AS gs
      ON CONFLICT DO NOTHING
    `;
  });
}
export async function deletePresence(presenceId) {
  await ensureSchema();
  await sql`DELETE FROM presences WHERE id=${presenceId}`;
}
export async function listPresencesWithCounts() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT p.*,
      COALESCE((
        SELECT COUNT(*) FROM slots s JOIN reservations r ON r.slot_id = s.id WHERE s.presence_id = p.id
      ), 0)::int AS reservations_count,
      COALESCE((
        SELECT COUNT(*) FROM slots s WHERE s.presence_id = p.id
      ), 0)::int AS slots_count
    FROM presences p
    ORDER BY p.date ASC, p.start_time ASC
  `;
  return rows;
}