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
          redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

// Admin User Creation (Protected)
app.post('/api/admin/add-user', verifyAdminToken, async (req, res) => {
  const { newUsername, newPassword } = req.body;
  if (!newUsername || !newPassword) {
    return res.status(400).json({ success: false, message: 'Username and password required.' });
  }
  try {
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)', [newUsername.trim().toLowerCase(), hashed, 'admin']);
    res.json({ success: true, message: `Manager account "${newUsername}" created successfully!` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'User already exists or server error.' });
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

app.post('/api/admin/promotions/create', verifyAdminToken, async (req, res) => {
  const { code, title, discountText, expiresAt } = req.body;
  if (!code || !title || !discountText) {
    return res.status(400).json({ success: false, message: 'Code, title, and discount text required.' });
  }

  const cleanCode = code.trim().toUpperCase();
  const expDate = expiresAt ? expiresAt : '2026-12-31 23:59:59';

  try {
    const result = await pool.query(
      `INSERT INTO promotions (code, title, discount_text, expires_at, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (code) DO UPDATE 
       SET title = $2, discount_text = $3, expires_at = $4, is_active = true
       RETURNING *`,
      [cleanCode, title.trim(), discountText.trim(), expDate]
    );

    io.emit('promoStateUpdated');
    res.json({ success: true, message: `🎉 Promotion "${cleanCode}" saved!`, promotion: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/promotions/toggle', async (req, res) => {
  const { code, is_active } = req.body;
  try {
    await pool.query('UPDATE promotions SET is_active = $1 WHERE code = $2', [is_active, code]);
    io.emit('promoStateUpdated');
    res.json({ success: true, message: 'Promotion status updated.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Open to Cashiers: Delete Promotion without Admin Token
app.post('/api/promotions/delete', async (req, res) => {
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
    const promo = await pool.query('SELECT * FROM promotions WHERE UPPER(TRIM(code)) = $1 AND is_active = true', [promoCode]);
    if (promo.rows.length === 0) {
      return res.status(404).send('Promotion not found or inactive.');
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
            logo: {
              sourceUri: {
                uri: 'https://smokenchill-geofencing.onrender.com/Snc3-logo.png'
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
                header: 'Terms',
                body: '1 redemption per customer every 24 hours.'
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

// Redeem Coupon with Austin Time Zone 24hr Cooldown
app.post('/api/redeem', async (req, res) => {
  const { couponCode, customerId } = req.body;
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

    await pool.query('INSERT INTO redemptions (coupon_code, customer_id) VALUES ($1, $2)', [code, customer]);
    const unlocksAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    io.emit('couponRedeemed', { couponCode: code, customerId: customer, unlocksAt });

    res.json({ success: true, message: `✅ Coupon "${code}" successfully redeemed for customer (${customer})!` });
  } catch (err) {
    res.status(500).json({ success: false, message: `Server error: ${err.message}` });
  }
});

// Open to Cashiers: Undo Redemptions Instantly (No Admin Token Required)
app.post('/api/cashier/reset-cooldown', async (req, res) => {
  const { couponCode, customerId } = req.body;
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

    io.emit('promoStateUpdated');
    res.json({ success: true, message: `✅ Accidentally redeemed lock cleared for customer (${customer}) on "${code}". Coupon reopened!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Smoke N Chill Server running on port ${PORT}`);
});