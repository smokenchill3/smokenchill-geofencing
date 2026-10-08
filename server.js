const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'smokenchill_secret_key_2026';

// ==============================================
// Google Wallet Configuration
// ==============================================
const ISSUER_ID = '3388000000023201282';
const CLASS_ID = `${ISSUER_ID}.smoke_n_chill_promo`;

function getServiceAccount() {
  if (process.env.SERVICE_ACCOUNT_JSON) {
    try {
      const sa = typeof process.env.SERVICE_ACCOUNT_JSON === 'string'
        ? JSON.parse(process.env.SERVICE_ACCOUNT_JSON)
        : process.env.SERVICE_ACCOUNT_JSON;
      
      if (sa && sa.private_key) {
        sa.private_key = sa.private_key.replace(/\\n/g, '\n');
      }
      return sa;
    } catch (err) {
      console.error('[Service Account Error] Failed to parse SERVICE_ACCOUNT_JSON:', err.message);
      return null;
    }
  } else if (fs.existsSync('./service-account.json')) {
    try {
      const sa = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
      if (sa && sa.private_key) {
        sa.private_key = sa.private_key.replace(/\\n/g, '\n');
      }
      return sa;
    } catch (err) {
      console.error('[Service Account Error] Failed to read service-account.json:', err.message);
      return null;
    }
  }
  return null;
}

function createGoogleWalletUrl(promo) {
  const serviceAccount = getServiceAccount();

  if (!serviceAccount) {
    throw new Error('Google service-account.json credentials are missing or invalid on server.');
  }

  const objectId = `${ISSUER_ID}.${promo.code.replace(/[^a-zA-Z0-9_.-]/g, '_')}_${Date.now()}`;

  const claims = {
    iss: serviceAccount.client_email,
    aud: 'google',
    origins: ['*'],
    typ: 'savetowallet',
    payload: {
      genericObjects: [
        {
          id: objectId,
          classId: CLASS_ID,
          state: 'ACTIVE',
          hexBackgroundColor: '#0f0f15',
          cardTitle: {
            defaultValue: { language: 'en-US', value: 'Smoke N Chill' }
          },
          header: {
            defaultValue: { language: 'en-US', value: promo.discount_text }
          },
          subheader: {
            defaultValue: { language: 'en-US', value: promo.title }
          },
          logo: {
            sourceUri: { uri: 'https://smokenchill-geofencing.onrender.com/Snc3-logo.png' },
            contentDescription: { defaultValue: { language: 'en-US', value: 'Smoke N Chill Logo' } }
          },
          heroImage: {
            sourceUri: { uri: 'https://smokenchill-geofencing.onrender.com/Snc3-Entrance.jpg' },
            contentDescription: { defaultValue: { language: 'en-US', value: 'Smoke N Chill Banner' } }
          },
          barcode: {
            type: 'QR_CODE',
            value: promo.code,
            alternateText: promo.code
          },
          textModulesData: [
            { header: 'COUPON CODE', body: promo.code, id: 'code_module' },
            { header: 'EXPIRES', body: new Date(promo.expires_at).toLocaleDateString(), id: 'exp_module' },
            { header: 'INSTRUCTIONS', body: 'Show this QR code to the cashier (Must be 21+)', id: 'instructions_module' }
          ]
        }
      ]
    }
  };

  const token = jwt.sign(claims, serviceAccount.private_key, { algorithm: 'RS256' });
  return `https://pay.google.com/gp/v/save/${token}`;
}

// ==============================================
// PostgreSQL Connection & Setup
// ==============================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ==============================================
// Authentication Middleware
// ==============================================
function verifyAdminToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ success: false, message: 'Admin authentication required.' });
  }

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token.' });
    }
    req.user = decoded;
    next();
  });
}

// ==============================================
// Database Setup & Migration
// ==============================================
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promotions (
          id SERIAL PRIMARY KEY,
          code VARCHAR(50) UNIQUE NOT NULL,
          title VARCHAR(100) NOT NULL,
          discount_text VARCHAR(100) NOT NULL,
          starts_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP NOT NULL,
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

    // Seed initial promos only if database is completely empty
    const promoCount = await pool.query('SELECT COUNT(*) FROM promotions');
    if (parseInt(promoCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO promotions (code, title, discount_text, starts_at, expires_at, is_active)
        VALUES 
          ('SNC5OFF', '$5 Off Glassware & Water Pipes', '$5 OFF', NOW(), '2026-12-31 23:59:59', true),
          ('CHILL20', '20% Off Vape Accessories', '20% OFF', NOW(), '2026-12-31 23:59:59', true),
          ('SMOKE10', '10% Off Storewide Purchase', '10% OFF', NOW(), '2026-12-31 23:59:59', true);
      `);
      console.log('[PostgreSQL] Default promotions seeded.');
    }

    // Seed default admin user
    const userCount = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(userCount.rows[0].count) === 0) {
      const hashedPw = await bcrypt.hash('admin123', 10);
      await pool.query(
        'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)',
        ['admin', hashedPw, 'admin']
      );
      console.log('[PostgreSQL] Default admin user created (admin / admin123).');
    }

    console.log('[PostgreSQL] Database schema verified successfully.');
  } catch (err) {
    console.error('[PostgreSQL Init Error]:', err.message);
  }
}

// ==============================================
// Multi-Store Coordinates (15-Mile Geofence)
// ==============================================
const STORES = [
  { id: "research", name: "Smoke N Chill - Research Blvd", lat: 30.4182, lng: -97.7473, radiusMiles: 15 },
  { id: "parmer", name: "Smoke N Chill - E Parmer Ln", lat: 30.3985, lng: -97.6521, radiusMiles: 15 }
];

function getDistanceInMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// Static HTML Endpoints
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/cashier.html', (req, res) => res.sendFile(path.join(__dirname, 'cashier.html')));

// Location Verification API
app.post('/api/verify-location', (req, res) => {
  const { userLat, userLng } = req.body;
  if (!userLat || !userLng) {
    return res.status(400).json({ allowed: false, message: "Location coordinates missing." });
  }

  let nearestStore = null;
  let minDistance = Infinity;
  let isWithinFence = false;

  for (const store of STORES) {
    const distance = getDistanceInMiles(userLat, userLng, store.lat, store.lng);
    if (distance < minDistance) {
      minDistance = distance;
      nearestStore = store;
    }
    if (distance <= store.radiusMiles) {
      isWithinFence = true;
    }
  }

  res.json({
    allowed: isWithinFence,
    storeName: nearestStore ? nearestStore.name : "Smoke N Chill",
    distanceMiles: parseFloat(minDistance.toFixed(2)),
    message: isWithinFence
      ? `Unlocked! Nearest store: ${nearestStore.name} (${minDistance.toFixed(1)} miles away).`
      : `You are ${minDistance.toFixed(1)} miles away. Offers require being within 15 miles of a store.`
  });
});

// ==============================================
// Google Wallet Endpoint
// ==============================================
app.get('/api/wallet/google/:code', async (req, res) => {
  const code = req.params.code;
  try {
    const result = await pool.query(
      'SELECT * FROM promotions WHERE code = $1 AND is_active = true AND expires_at > NOW()',
      [code]
    );

    if (result.rows.length === 0) {
      return res.status(404).send('This offer is no longer active or has expired.');
    }

    const walletUrl = createGoogleWalletUrl(result.rows[0]);
    return res.redirect(walletUrl);
  } catch (err) {
    console.error('[Google Wallet Error]:', err.message);
    return res.status(500).send(`Google Wallet Integration Error: ${err.message}`);
  }
});

// ==============================================
// Auth Routes
// ==============================================
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username.trim().toLowerCase()]);
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ success: true, token, username: user.username, message: 'Login successful!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/add-user', verifyAdminToken, async (req, res) => {
  const { newUsername, newPassword } = req.body;
  try {
    const hashedPw = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)',
      [newUsername.trim().toLowerCase(), hashedPw, 'admin']
    );
    res.json({ success: true, message: `User "${newUsername}" created successfully.` });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ success: false, message: 'Username already exists.' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==============================================
// Promotion Routes
// ==============================================
app.get('/api/promotions/all', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM promotions ORDER BY id ASC');
    res.json({ success: true, promotions: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/promotions/toggle', async (req, res) => {
  const { code, is_active } = req.body;
  try {
    await pool.query('UPDATE promotions SET is_active = $1 WHERE code = $2', [is_active, code]);
    io.emit('promoStateUpdated');
    res.json({ success: true, message: 'Promotion state updated.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/promotions/delete', verifyAdminToken, async (req, res) => {
  const { code } = req.body;
  try {
    const result = await pool.query('DELETE FROM promotions WHERE code = $1', [code]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Promotion code not found.' });
    }
    io.emit('promoStateUpdated');
    res.json({ success: true, message: `Promotion "${code}" deleted successfully.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/redeem', async (req, res) => {
  const { couponCode } = req.body;
  try {
    const result = await pool.query('SELECT * FROM promotions WHERE code = $1 AND is_active = true', [couponCode]);
    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid or expired coupon code.' });
    }

    await pool.query('INSERT INTO redemptions (coupon_code) VALUES ($1)', [couponCode]);
    res.json({ success: true, message: `Coupon "${couponCode}" redeemed successfully!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==============================================
// Announcement & Newsletter Routes
// ==============================================
app.get('/api/announcements', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM announcements WHERE is_active = true ORDER BY created_at DESC');
    res.json({ success: true, announcements: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/announcements', verifyAdminToken, async (req, res) => {
  const { title, message, type } = req.body;
  try {
    await pool.query(
      'INSERT INTO announcements (title, message, type) VALUES ($1, $2, $3)',
      [title, message, type || 'info']
    );
    io.emit('announcementsUpdated');
    res.json({ success: true, message: 'Announcement published to customer view.' });
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

// Socket.io Setup
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);
});

// Server Initialization
server.listen(PORT, async () => {
  await initDb();
  console.log(`Server running on port ${PORT}`);
});