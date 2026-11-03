const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'smokenchill_secret_key_2026';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/cashier.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'cashier.html'));
});

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promotions (
          id SERIAL PRIMARY KEY,
          code VARCHAR(50) UNIQUE NOT NULL,
          title VARCHAR(100) NOT NULL,
          discount_text VARCHAR(100) NOT NULL,
          location VARCHAR(50) DEFAULT 'all',
          starts_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP DEFAULT '2026-12-31 23:59:59',
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(50) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          role VARCHAR(20) DEFAULT 'admin',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS redemptions (
          id SERIAL PRIMARY KEY,
          coupon_code VARCHAR(50) NOT NULL,
          customer_id VARCHAR(100) DEFAULT 'general_customer',
          redeemed_by VARCHAR(50) DEFAULT 'system',
          redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS undo_transactions (
          id SERIAL PRIMARY KEY,
          coupon_code VARCHAR(50) NOT NULL,
          customer_id VARCHAR(100) NOT NULL,
          undone_by VARCHAR(50) NOT NULL,
          undone_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS announcements (
          id SERIAL PRIMARY KEY,
          title VARCHAR(150) NOT NULL,
          message TEXT NOT NULL,
          type VARCHAR(20) DEFAULT 'info',
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`ALTER TABLE promotions ADD COLUMN IF NOT EXISTS location VARCHAR(50) DEFAULT 'all';`);
    await pool.query(`ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS redeemed_by VARCHAR(50) DEFAULT 'system';`);

    const userCheck = await pool.query('SELECT * FROM users WHERE username = $1', ['admin']);
    if (userCheck.rows.length === 0) {
      const hashedPassword = await bcrypt.hash('smokenchill123', 10);
      await pool.query(
        'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)',
        ['admin', hashedPassword, 'admin']
      );
    }
  } catch (err) {
    console.error('[PostgreSQL Init Error]:', err.message);
  }
}

initDb();

function verifyAdminToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ success: false, message: 'Access denied. Token missing.' });

  const token = authHeader.split(' ')[1];
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ success: false, message: 'Invalid or expired token.' });
    req.user = decoded;
    next();
  });
}

// Middleware to verify logged-in staff or admin for POS operations (Cashiers, Shift Managers, Admins)
function verifyStaffToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ success: false, message: 'Access denied. Staff login required.' });

  const token = authHeader.split(' ')[1];
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ success: false, message: 'Invalid or expired session.' });
    req.user = decoded;
    next();
  });
}

// Middleware to restrict promotion creation to Shift Managers and Admins only
function verifyManagerToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ success: false, message: 'Access denied. Token missing.' });

  const token = authHeader.split(' ')[1];
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ success: false, message: 'Invalid or expired token.' });
    if (decoded.role !== 'admin' && decoded.role !== 'shift_manager') {
      return res.status(403).json({ success: false, message: 'Permission denied. Shift Manager or Admin required to create promotions.' });
    }
    req.user = decoded;
    next();
  });
}

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE username = $1', [username.trim().toLowerCase()]);
    if (userResult.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid username or password.' });
    }

    const user = userResult.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(400).json({ success: false, message: 'Invalid username or password.' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ success: true, message: 'Login successful!', token });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==============================================
// User Management & Audit Endpoints
// ==============================================
app.get('/api/admin/users', verifyAdminToken, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, username, role, created_at FROM users WHERE LOWER(username) != 'admin' ORDER BY id DESC");
    res.json({ success: true, users: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/delete-user', verifyAdminToken, async (req, res) => {
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ success: false, message: 'Username required.' });
  }

  try {
    if (username.trim().toLowerCase() === 'admin') {
      return res.status(403).json({ success: false, message: 'Cannot delete the primary admin account.' });
    }

    const result = await pool.query('DELETE FROM users WHERE LOWER(username) = LOWER($1)', [username.trim()]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Manager account not found.' });
    }

    res.json({ success: true, message: `Manager account "${username}" deleted successfully.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/add-user', verifyAdminToken, async (req, res) => {
  const { newUsername, newPassword, role } = req.body;
  if (!newUsername || !newPassword) {
    return res.status(400).json({ success: false, message: 'Username and password required.' });
  }

  const userRole = (role || 'shift_manager').trim().toLowerCase();

  try {
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)',
      [newUsername.trim().toLowerCase(), hashed, userRole]
    );
    res.json({ success: true, message: `Staff account "${newUsername}" created successfully!` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'User already exists or server error.' });
  }
});

// Admin Redemption Audit Endpoint
app.get('/api/admin/redemption-history', verifyAdminToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, coupon_code, customer_id, redeemed_by, redeemed_at
      FROM redemptions
      ORDER BY redeemed_at DESC
      LIMIT 100
    `);
    res.json({ success: true, redemptions: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin Undo History Audit Endpoint
app.get('/api/admin/undo-history', verifyAdminToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, coupon_code, customer_id, undone_by, undone_at
      FROM undo_transactions
      ORDER BY undone_at DESC
      LIMIT 100
    `);
    res.json({ success: true, undos: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/promotions/all', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM promotions ORDER BY id DESC');
    res.json({ success: true, promotions: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/promotions/active', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM promotions WHERE is_active = true AND expires_at > NOW() ORDER BY id DESC'
    );
    res.json({ success: true, promotions: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Promotion creation restricted to Shift Managers and Admins
app.post('/api/admin/promotions/create', verifyManagerToken, async (req, res) => {
  const { code, title, discountText, expiresAt, location } = req.body;
  if (!code || !title || !discountText) {
    return res.status(400).json({ success: false, message: 'Code, title, and discount text required.' });
  }

  const cleanCode = code.trim().toUpperCase();
  const expDate = expiresAt ? expiresAt : '2026-12-31 23:59:59';
  const promoLocation = location ? location.trim().toLowerCase() : 'all';

  try {
    const result = await pool.query(
      `INSERT INTO promotions (code, title, discount_text, location, expires_at, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (code) DO UPDATE 
       SET title = $2, discount_text = $3, location = $4, expires_at = $5, is_active = true
       RETURNING *`,
      [cleanCode, title.trim(), discountText.trim(), promoLocation, expDate]
    );

    io.emit('promoStateUpdated');
    res.json({ success: true, message: `🎉 Promotion "${cleanCode}" saved!`, promotion: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Cashiers, Shift Managers, and Admins can toggle promo status (disable/enable)
app.post('/api/promotions/toggle', verifyStaffToken, async (req, res) => {
  const { code, is_active } = req.body;
  try {
    await pool.query('UPDATE promotions SET is_active = $1 WHERE code = $2', [is_active, code]);
    io.emit('promoStateUpdated');
    res.json({ success: true, message: 'Promotion status updated.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Cashiers, Shift Managers, and Admins can delete promos
app.post('/api/promotions/delete', verifyStaffToken, async (req, res) => {
  const { code } = req.body;
  try {
    await pool.query('DELETE FROM promotions WHERE code = $1', [code]);
    io.emit('promoStateUpdated');
    res.json({ success: true, message: `Promotion "${code}" deleted.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==============================================
// Announcements API Endpoints
// ==============================================
app.get('/api/announcements', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM announcements ORDER BY id DESC');
    res.json({ success: true, announcements: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/announcements', verifyAdminToken, async (req, res) => {
  const { title, message, type } = req.body;
  if (!title || !message) {
    return res.status(400).json({ success: false, message: 'Title and message required.' });
  }
  try {
    await pool.query('INSERT INTO announcements (title, message, type) VALUES ($1, $2, $3)', [title.trim(), message.trim(), type || 'info']);
    io.emit('announcementsUpdated');
    res.json({ success: true, message: 'Announcement published successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/announcements/delete', verifyAdminToken, async (req, res) => {
  const { id } = req.body;
  try {
    await pool.query('DELETE FROM announcements WHERE id = $1', [id]);
    io.emit('announcementsUpdated');
    res.json({ success: true, message: 'Announcement removed.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==============================================
// Coupon Status Check (Handles 24hr Cooldown)
// ==============================================
app.get('/api/coupon-status', async (req, res) => {
  const { code, customerId } = req.query;
  if (!code) return res.json({ redeemed: false });

  const cleanCode = code.trim().toUpperCase();
  const cleanCustomer = (customerId || 'general_customer').trim().toLowerCase();

  try {
    const check = await pool.query(
      `SELECT redeemed_at FROM redemptions 
       WHERE UPPER(TRIM(coupon_code)) = $1 AND customer_id = $2 AND redeemed_at > NOW() - INTERVAL '24 hours'
       ORDER BY redeemed_at DESC LIMIT 1`,
      [cleanCode, cleanCustomer]
    );

    if (check.rows.length > 0) {
      const lastRedeemed = new Date(check.rows[0].redeemed_at);
      const unlocksAt = new Date(lastRedeemed.getTime() + 24 * 60 * 60 * 1000);
      return res.json({ redeemed: true, unlocks_at: unlocksAt });
    }

    res.json({ redeemed: false });
  } catch (err) {
    res.json({ redeemed: false });
  }
});

// ==============================================
// Google Wallet API Integration
// ==============================================
app.get('/api/wallet/google/:code', async (req, res) => {
  const promoCode = req.params.code.toUpperCase();
  const customerId = req.query.customerId || 'cust_' + Math.random().toString(36).substring(2, 10);

  try {
    const promo = await pool.query(
      'SELECT * FROM promotions WHERE UPPER(TRIM(code)) = $1 AND is_active = true AND expires_at > NOW()',
      [promoCode]
    );
    if (promo.rows.length === 0) {
      return res.status(404).send('Promotion not found, inactive, or expired.');
    }
    const offer = promo.rows[0];

    if (!process.env.SERVICE_ACCOUNT_JSON) {
      return res.status(500).send('Server configuration error: SERVICE_ACCOUNT_JSON is missing.');
    }

    const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
    const issuerId = process.env.GOOGLE_ISSUER_ID || '3388000000023201282';
    const classId = `${issuerId}.smokenchill_${promoCode.toLowerCase()}`;
    const objectId = `${issuerId}.pass_${promoCode.toLowerCase()}_${Date.now()}`;

    const passPayload = {
      iss: serviceAccount.client_email,
      aud: 'google',
      origins: ['https://smokenchill-geofencing.onrender.com'],
      typ: 'savetowallet',
      payload: {
        offerClasses: [
          {
            id: classId,
            issuerName: 'Smoke N Chill',
            provider: 'Smoke N Chill',
            redemptionChannel: 'INSTORE',
            title: offer.title,
            reviewStatus: 'UNDER_REVIEW',
            hexBackgroundColor: '#0f172a',
            logo: {
              sourceUri: {
                uri: 'https://smokenchill-geofencing.onrender.com/Snc3-logo.png'
              },
              contentDescription: {
                defaultValue: {
                  language: 'en-US',
                  value: 'Smoke N Chill Logo'
                }
              }
            }
          }
        ],
        offerObjects: [
          {
            id: objectId,
            classId: classId,
            state: 'ACTIVE',
            barcode: {
              type: 'QR_CODE',
              value: `${offer.code}:${customerId}`,
              alternateText: offer.code
            },
            title: offer.title,
            header: offer.discount_text,
            textModulesData: [
            {
              header: 'Store Location',
              body: 'Smoke N Chill — Austin, TX'
            },
            {
              header: 'Expires',
              body: new Date(offer.expires_at).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' })
            },
            {
              header: 'Terms',
              body: '1 redemption per customer every 24 hours. No Double Discount.'
            }
          ]
          }
        ]
      }
    };

    const token = jwt.sign(passPayload, serviceAccount.private_key, { algorithm: 'RS256' });
    res.redirect(`https://pay.google.com/gp/v/save/${token}`);
  } catch (err) {
    console.error('[Google Wallet Error]:', err);
    res.status(500).send(`Failed to generate Google Wallet Pass: ${err.message}`);
  }
});

// Redeem Coupon — Protected with verifyStaffToken & records staff username
app.post('/api/redeem', verifyStaffToken, async (req, res) => {
  const { couponCode, customerId } = req.body;
  const staffUser = req.user ? req.user.username : 'unknown_staff';

  if (!couponCode) return res.status(400).json({ success: false, message: '❌ Coupon code required.' });

  let code = couponCode.trim().toUpperCase();
  let customer = (customerId || 'general_customer').trim().toLowerCase();

  if (code.includes(':')) {
    const parts = code.split(':');
    code = parts[0].trim().toUpperCase();
    customer = parts[1].trim().toLowerCase();
  }

  try {
    const promo = await pool.query(
      `SELECT * FROM promotions WHERE UPPER(TRIM(code)) = $1 AND is_active = true AND expires_at > NOW()`,
      [code]
    );

    if (promo.rows.length === 0) {
      return res.status(400).json({ success: false, message: `❌ Invalid or expired coupon code (${code}).` });
    }

    const cooldownCheck = await pool.query(
      `SELECT redeemed_at FROM redemptions 
       WHERE UPPER(TRIM(coupon_code)) = $1 AND customer_id = $2 AND redeemed_at > NOW() - INTERVAL '24 hours' 
       ORDER BY redeemed_at DESC LIMIT 1`,
      [code, customer]
    );

    if (cooldownCheck.rows.length > 0) {
      const lastRedeemed = new Date(cooldownCheck.rows[0].redeemed_at);
      const nextAvailable = new Date(lastRedeemed.getTime() + 24 * 60 * 60 * 1000);
      
      const timeString = nextAvailable.toLocaleTimeString('en-US', {
        timeZone: 'America/Chicago',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });

      return res.status(400).json({
        success: false,
        message: `❌ Coupon already used today by customer (${customer})! Unlocks tomorrow at ${timeString}.`
      });
    }

    // Insert redemption record with staff username attribution
    await pool.query('INSERT INTO redemptions (coupon_code, customer_id, redeemed_by) VALUES ($1, $2, $3)', [code, customer, staffUser]);
    const unlocksAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    io.emit('couponRedeemed', { couponCode: code, customerId: customer, unlocksAt });

    res.json({ success: true, message: `✅ Coupon "${code}" successfully redeemed for customer (${customer}) by ${staffUser}!` });
  } catch (err) {
    res.status(500).json({ success: false, message: `Server error: ${err.message}` });
  }
});

// Reset Cooldown (Undo Scan) — Protected with verifyStaffToken & logs to undo_transactions
app.post('/api/cashier/reset-cooldown', verifyStaffToken, async (req, res) => {
  const { couponCode, customerId } = req.body;
  const staffUser = req.user ? req.user.username : 'unknown_staff';

  if (!couponCode) return res.status(400).json({ success: false, message: 'Coupon code required.' });

  let code = couponCode.trim().toUpperCase();
  let customer = (customerId || 'general_customer').trim().toLowerCase();

  if (code.includes(':')) {
    const parts = code.split(':');
    code = parts[0].trim().toUpperCase();
    customer = parts[1].trim().toLowerCase();
  }

  try {
    await pool.query(
      "DELETE FROM redemptions WHERE UPPER(TRIM(coupon_code)) = $1 AND customer_id = $2 AND redeemed_at > NOW() - INTERVAL '24 hours'",
      [code, customer]
    );

    // Record undo transaction in backend audit table
    await pool.query(
      'INSERT INTO undo_transactions (coupon_code, customer_id, undone_by) VALUES ($1, $2, $3)',
      [code, customer, staffUser]
    );

    io.emit('promoStateUpdated');
    res.json({ success: true, message: `✅ Accidentally redeemed lock cleared for customer (${customer}) on "${code}" by ${staffUser}. Coupon reopened!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Smoke N Chill Server running on port ${PORT}`);
});