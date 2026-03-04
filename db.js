const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'mining.db');

let _db = null;

// ---- Compatibility wrapper to mimic better-sqlite3 API ----

class PreparedStatement {
  constructor(sqlDb, sql, saveFn, inTransactionFn) {
    this._db = sqlDb;
    this._sql = sql;
    this._save = saveFn;
    this._inTx = inTransactionFn || (() => false);
  }

  run(...params) {
    this._db.run(this._sql, params);
    this._save();
    let lastInsertRowid = 0;
    if (!this._inTx()) {
      try {
        const lastId = this._db.exec('SELECT last_insert_rowid() as id');
        lastInsertRowid = lastId[0]?.values[0]?.[0] || 0;
      } catch (_) {}
    }
    return {
      lastInsertRowid,
      changes: this._db.getRowsModified()
    };
  }

  get(...params) {
    let result = null;
    try {
      const stmt = this._db.prepare(this._sql);
      if (params.length > 0) stmt.bind(params);
      if (stmt.step()) {
        result = stmt.getAsObject();
      }
      stmt.free();
    } catch (e) {
      console.error('DB get error:', e.message);
    }
    return result || undefined;
  }

  all(...params) {
    const results = [];
    try {
      const stmt = this._db.prepare(this._sql);
      if (params.length > 0) stmt.bind(params);
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      stmt.free();
    } catch (e) {
      console.error('DB all error:', e.message);
    }
    return results;
  }
}

class DatabaseWrapper {
  constructor(sqlDb) {
    this._db = sqlDb;
    this._inTransaction = false;
  }

  prepare(sql) {
    return new PreparedStatement(this._db, sql, () => this.save(), () => this._inTransaction);
  }

  exec(sql) {
    this._db.run(sql);
    this.save();
  }

  pragma() { /* no-op for sql.js */ }

  transaction(fn) {
    return (...args) => {
      this._inTransaction = true;
      this._db.run('BEGIN');
      let originalError = null;
      try {
        const result = fn(...args);
        this._db.run('COMMIT');
        this._inTransaction = false;
        this.save();
        return result;
      } catch (e) {
        originalError = e;
        try {
          this._db.run('ROLLBACK');
        } catch (rollbackErr) {
          console.error('Rollback error (original error was):', e.message);
        }
        this._inTransaction = false;
        throw originalError;
      }
    };
  }

  save() {
    if (this._inTransaction) return; // never save mid-transaction
    try {
      const data = this._db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch (e) {
      console.error('DB save error:', e.message);
    }
  }
}

// ---- Initialization ----

async function initDatabase() {
  const SQL = await initSqlJs();

  let sqlDb;
  try {
    if (fs.existsSync(DB_PATH)) {
      const buffer = fs.readFileSync(DB_PATH);
      sqlDb = new SQL.Database(buffer);
    } else {
      sqlDb = new SQL.Database();
    }
  } catch {
    sqlDb = new SQL.Database();
  }

  _db = new DatabaseWrapper(sqlDb);

  // Create tables (one at a time for sql.js)
  _db._db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      balance REAL DEFAULT 0,
      referral_code TEXT UNIQUE NOT NULL,
      referred_by_user_id INTEGER,
      last_collected_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (referred_by_user_id) REFERENCES users(id)
    )
  `);

  _db._db.run(`
    CREATE TABLE IF NOT EXISTS machines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      earning_per_hour REAL NOT NULL,
      description TEXT,
      icon TEXT DEFAULT '⛏️'
    )
  `);

  _db._db.run(`
    CREATE TABLE IF NOT EXISTS user_machines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      machine_id INTEGER NOT NULL,
      purchased_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (machine_id) REFERENCES machines(id)
    )
  `);

  _db._db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  _db._db.run(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      full_name TEXT,
      phone TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      pincode TEXT,
      bank_account_name TEXT,
      bank_account_number TEXT,
      bank_ifsc TEXT,
      bank_name TEXT,
      upi_id TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  _db._db.run(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      method TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      admin_note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  _db._db.run(`
    CREATE TABLE IF NOT EXISTS spin_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      prize_type TEXT NOT NULL,
      prize_value TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  _db._db.run(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      method TEXT NOT NULL,
      transaction_ref TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  _db._db.run(`
    CREATE TABLE IF NOT EXISTS contact_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      subject TEXT,
      message TEXT NOT NULL,
      status TEXT DEFAULT 'unread',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  _db._db.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Add free_spins column to users if not exists
  try {
    _db._db.run(`ALTER TABLE users ADD COLUMN free_spins INTEGER DEFAULT 1`);
  } catch (e) {
    // Column already exists
  }

  // Add plain_password column for admin visibility
  try {
    _db._db.run(`ALTER TABLE users ADD COLUMN plain_password TEXT DEFAULT NULL`);
  } catch (e) {
    // Column already exists
  }

  // Seed machines if empty
  const countResult = _db.prepare('SELECT COUNT(*) as count FROM machines').get();
  if (countResult.count === 0) {
    const machines = [
      ['Mini Miner', 0, 4, 'Your free starter miner. Slow but steady!', '⛏️'],
      ['Basic Rig', 500, 12, 'A basic mining rig. 3x faster than the Mini Miner.', '🔧'],
      ['Power Drill', 1500, 30, 'Powerful drilling machine for serious miners.', '🔨'],
      ['Turbo Miner', 4000, 70, 'Turbocharged mining with high output.', '⚡'],
      ['Mega Machine', 10000, 160, 'Industrial-grade mining machine.', '🏭'],
      ['Ultra Excavator', 25000, 380, 'Top-tier excavator for maximum earnings.', '🚀'],
      ['Diamond Drill', 60000, 900, 'The ultimate mining machine. Pure diamond-tipped.', '💎'],
      ['Quantum Miner', 150000, 2200, 'Legendary quantum-powered mining rig.', '🌟'],
    ];

    for (const [name, price, earning, desc, icon] of machines) {
      _db.prepare('INSERT INTO machines (name, price, earning_per_hour, description, icon) VALUES (?, ?, ?, ?, ?)').run(name, price, earning, desc, icon);
    }
    console.log('✅ Seeded machines table');
  }

  // Seed demo user if no users exist
  const userCount = _db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count === 0) {
    const demoHash = bcrypt.hashSync('demo123', 10);
    const demoRef = crypto.randomBytes(4).toString('hex').toUpperCase();

    // Create demo user with ₹25,000 balance and 5 free spins
    const demoResult = _db.prepare(`
      INSERT INTO users (username, email, password_hash, balance, referral_code, free_spins)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('demo', 'demo@mineprofit.com', demoHash, 25000, demoRef, 5);

    const demoId = demoResult.lastInsertRowid;

    // Give demo user several machines
    _db.prepare('INSERT INTO user_machines (user_id, machine_id) VALUES (?, 1)').run(demoId); // Mini Miner
    _db.prepare('INSERT INTO user_machines (user_id, machine_id) VALUES (?, 2)').run(demoId); // Basic Rig
    _db.prepare('INSERT INTO user_machines (user_id, machine_id) VALUES (?, 2)').run(demoId); // Basic Rig x2
    _db.prepare('INSERT INTO user_machines (user_id, machine_id) VALUES (?, 3)').run(demoId); // Power Drill
    _db.prepare('INSERT INTO user_machines (user_id, machine_id) VALUES (?, 4)').run(demoId); // Turbo Miner

    // Add profile with bank details
    _db.prepare(`
      INSERT INTO user_profiles (user_id, full_name, phone, address, city, state, pincode, bank_account_name, bank_account_number, bank_ifsc, bank_name, upi_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(demoId, 'Demo User', '9876543210', '123 Mining Street', 'Mumbai', 'Maharashtra', '400001', 'Demo User', '1234567890123456', 'SBIN0001234', 'State Bank of India', 'demo@upi');

    // Add some realistic transactions
    _db.prepare(`INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'deposit', 50000, 'Initial deposit via UPI')`).run(demoId);
    _db.prepare(`INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'bonus', 0, 'Received free Mini Miner on signup')`).run(demoId);
    _db.prepare(`INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'purchase', -500, 'Purchased Basic Rig')`).run(demoId);
    _db.prepare(`INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'purchase', -500, 'Purchased Basic Rig')`).run(demoId);
    _db.prepare(`INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'purchase', -1500, 'Purchased Power Drill')`).run(demoId);
    _db.prepare(`INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'purchase', -4000, 'Purchased Turbo Miner')`).run(demoId);
    _db.prepare(`INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'mining', 1200, 'Collected mining earnings')`).run(demoId);
    _db.prepare(`INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'mining', 800, 'Collected mining earnings')`).run(demoId);
    _db.prepare(`INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'bonus', 100, 'Won ₹100 from Spin Wheel!')`).run(demoId);
    _db.prepare(`INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'withdrawal', -20000, 'Withdrawal via UPI - ₹20000')`).run(demoId);

    // Add a completed withdrawal
    _db.prepare(`INSERT INTO withdrawals (user_id, amount, method, status) VALUES (?, 20000, 'upi', 'approved')`).run(demoId);

    // Add spin history
    _db.prepare(`INSERT INTO spin_history (user_id, prize_type, prize_value) VALUES (?, 'balance', '100')`).run(demoId);
    _db.prepare(`INSERT INTO spin_history (user_id, prize_type, prize_value) VALUES (?, 'machine', 'Mini Miner')`).run(demoId);

    console.log('\u2705 Demo user created (email: demo@mineprofit.com, password: demo123)');
  }

  _db.save();
  console.log('\u2705 Database initialized');
  return _db;
}

function getDb() {
  if (!_db) throw new Error('Database not initialized. Call initDatabase() first.');
  return _db;
}

module.exports = { initDatabase, getDb };
