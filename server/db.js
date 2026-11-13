// SQLite persistence (better-sqlite3, prebuilt binaries; works on any Node 22).
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#4f8cff',
      bio TEXT NOT NULL DEFAULT '',
      last_x REAL, last_z REAL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connection_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined
      place TEXT,
      created_at INTEGER NOT NULL,
      responded_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_req_to ON connection_requests(to_id, status);
    CREATE INDEX IF NOT EXISTS idx_req_from ON connection_requests(from_id, status);
  `);
  // migration: avatar appearance (JSON), added in v0.2
  if (!db.prepare(`PRAGMA table_info(users)`).all().some((c) => c.name === 'look')) db.exec(`ALTER TABLE users ADD COLUMN look TEXT`);

  const q = {
    insertUser: db.prepare(`INSERT INTO users (username, display_name, password_hash, color, bio, look, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    userByName: db.prepare(`SELECT * FROM users WHERE username = ?`),
    userById: db.prepare(`SELECT * FROM users WHERE id = ?`),
    updateProfile: db.prepare(`UPDATE users SET display_name = ?, color = ?, bio = ?, look = ? WHERE id = ?`),
    savePos: db.prepare(`UPDATE users SET last_x = ?, last_z = ? WHERE id = ?`),
    // latest non-declined request in either direction between two users
    between: db.prepare(`SELECT * FROM connection_requests
      WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) AND status != 'declined'
      ORDER BY id DESC LIMIT 1`),
    insertReq: db.prepare(`INSERT INTO connection_requests (from_id, to_id, place, created_at) VALUES (?, ?, ?, ?)`),
    reqById: db.prepare(`SELECT * FROM connection_requests WHERE id = ?`),
    respond: db.prepare(`UPDATE connection_requests SET status = ?, responded_at = ? WHERE id = ? AND status = 'pending'`),
    incoming: db.prepare(`SELECT r.id, r.place, r.created_at, u.id AS user_id, u.display_name, u.username, u.color, u.bio
      FROM connection_requests r JOIN users u ON u.id = r.from_id WHERE r.to_id = ? AND r.status = 'pending' ORDER BY r.id DESC`),
    outgoing: db.prepare(`SELECT r.id, r.place, r.created_at, u.id AS user_id, u.display_name, u.username, u.color
      FROM connection_requests r JOIN users u ON u.id = r.to_id WHERE r.from_id = ? AND r.status = 'pending' ORDER BY r.id DESC`),
    connections: db.prepare(`SELECT r.id, r.place, r.responded_at, u.id AS user_id, u.display_name, u.username, u.color, u.bio
      FROM connection_requests r JOIN users u ON u.id = CASE WHEN r.from_id = ? THEN r.to_id ELSE r.from_id END
      WHERE (r.from_id = ? OR r.to_id = ?) AND r.status = 'accepted' ORDER BY r.responded_at DESC`),
    removeConn: db.prepare(`UPDATE connection_requests SET status = 'declined', responded_at = ?
      WHERE status = 'accepted' AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`),
  };

  return {
    raw: db,
    createUser({ username, displayName, passwordHash, color, bio, look }) {
      const r = q.insertUser.run(username, displayName, passwordHash, color, bio, JSON.stringify(look), Date.now());
      return q.userById.get(Number(r.lastInsertRowid));
    },
    userByName: (n) => q.userByName.get(n),
    userById: (id) => q.userById.get(id),
    updateProfile: (id, { displayName, color, bio, look }) => q.updateProfile.run(displayName, color, bio, JSON.stringify(look), id),
    savePosition: (id, x, z) => q.savePos.run(x, z, id),
    relationBetween: (a, b) => q.between.get(a, b, b, a),
    createRequest: (from, to, place) => q.reqById.get(Number(q.insertReq.run(from, to, place, Date.now()).lastInsertRowid)),
    requestById: (id) => q.reqById.get(id),
    respond: (id, status) => q.respond.run(status, Date.now(), id).changes > 0,
    incoming: (id) => q.incoming.all(id),
    outgoing: (id) => q.outgoing.all(id),
    connections: (id) => q.connections.all(id, id, id),
    removeConnection: (a, b) => q.removeConn.run(Date.now(), a, b, b, a).changes > 0,
  };
}
