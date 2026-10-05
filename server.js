const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const PORT = process.env.PORT || 3000;

// ==============================================
// Google Wallet Credentials & Configuration
// ==============================================
const ISSUER_ID = '3388000000023201282';
const CLASS_ID = `${ISSUER_ID}.smoke_n_chill_promo`;

// Smoke N Chill Store Location (Geofence: 0.25 miles)
const STORE_LAT = 30.406395250881655;
const STORE_LNG = -97.74632797629555;
const GEOFENCE_RADIUS_MILES = 0.25;

// ==============================================
// Service Account Loader (Supports Cloud ENV or Local File)
// ==============================================
let serviceAccount;

if (process.env.SERVICE_ACCOUNT_JSON) {
  // Cloud environment (Render)
  serviceAccount = typeof process.env.SERVICE_ACCOUNT_JSON === 'string'
    ? JSON.parse(process.env.SERVICE_ACCOUNT_JSON)
    : process.env.SERVICE_ACCOUNT_JSON;
} else if (fs.existsSync('./service-account.json')) {
  // Local development environment
  serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
} else {
  return res.status(500).json({ 
    success: false, 
    error: "Google service account credentials not configured." 
  });
}

// ==============================================
// PostgreSQL Connection
// ==============================================
const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    }
  : {
      user: process.env.PGUSER || 'postgres',
      host: process.env.PGHOST || 'localhost',
      database: process.env.PGDATABASE || 'geopromo_db',
      password: process.env.PGPASSWORD || 'admin',
      port: process.env.PGPORT || 5432,
    };

const pool = new Pool(poolConfig);

pool.connect()
  .then(() => console.log('[PostgreSQL] Connected to geopromo_db successfully'))
  .catch(err => console.error('[PostgreSQL] Connection error:', err.message));
// Automatic schema migration on boot
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promotions (
          id SERIAL PRIMARY KEY,
          code VARCHAR(50) UNIQUE NOT NULL,
          title VARCHAR(100) NOT NULL,
          discount_text VARCHAR(100) NOT NULL,
          expires_at TIMESTAMP NOT NULL,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE promotions ADD COLUMN IF NOT EXISTS code VARCHAR(50);
      ALTER TABLE promotions ADD COLUMN IF NOT EXISTS title VARCHAR(100);
      ALTER TABLE promotions ADD COLUMN IF NOT EXISTS discount_text VARCHAR(100);
      ALTER TABLE promotions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
      ALTER TABLE promotions ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
      ALTER TABLE promotions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

      INSERT INTO promotions (code, title, discount_text, expires_at, is_active)
      VALUES 
        ('SNC5OFF', '$5 Off Glassware & Water Pipes', '$5 OFF', '2026-12-31 23:59:59', true),
        ('CHILL20', '20% Off Vape Accessories', '20% OFF', '2026-12-31 23:59:59', true),
        ('SMOKE10', '10% Off Storewide Purchase', '10% OFF', '2026-12-31 23:59:59', true)
      ON CONFLICT (code) DO UPDATE 
      SET 
        title = EXCLUDED.title,
        discount_text = EXCLUDED.discount_text,
        expires_at = EXCLUDED.expires_at,
        is_active = EXCLUDED.is_active;
    `);
    console.log('[PostgreSQL] Database schema verified and migrated successfully.');
  } catch (err) {
    console.error('[PostgreSQL Migration Error]:', err.message);
  }
}

pool.connect()
  .then(() => {
    console.log('[PostgreSQL] Connected to geopromo_db successfully');
    initDb();
  })
  .catch(err => console.error('[PostgreSQL] Connection error:', err.message));

// ==============================================
// Express & Socket.io Setup
// ==============================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==============================================
// Helper Functions
// ==============================================

function getDistanceInMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function createGoogleWalletUrl(promo) {
  if (!serviceAccount) {
    throw new Error('service-account.json is missing on server.');
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
            defaultValue: { language: 'en-US', value: 'Smoke N Chill @Research' }
          },
          header: {
            defaultValue: { language: 'en-US', value: promo.discount_text }
          },
          subheader: {
            defaultValue: { language: 'en-US', value: promo.title }
          },
          logo: {
            sourceUri: { uri: 'https://i.imgur.com/vH9X9xX.png' },
            contentDescription: { defaultValue: { language: 'en-US', value: 'Smoke N Chill Logo' } }
          },
          heroImage: {
            sourceUri: { uri: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=1032&q=80' },
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
// Routes & Web Page Endpoints
// ==============================================

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/cashier.html', (req, res) => res.sendFile(path.join(__dirname, 'cashier.html')));

// Fetch active unexpired promotions
app.get('/api/promotions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM promotions WHERE is_active = true AND expires_at > NOW() ORDER BY id ASC`
    );
    res.json({ success: true, promotions: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Fetch all promotions (for cashier toggle panel)
app.get('/api/promotions/all', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM promotions ORDER BY id ASC`);
    res.json({ success: true, promotions: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Toggle promotion active/disabled status
app.post('/api/promotions/toggle', async (req, res) => {
  const { code, is_active } = req.body;
  try {
    await pool.query(`UPDATE promotions SET is_active = $1 WHERE code = $2`, [is_active, code]);
    
    // Broadcast state change to all connected customer clients in real time
    io.emit('promoStateUpdated', { code, is_active });

    res.json({ success: true, message: `Promo ${code} updated successfully.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Add or Update a Promotion from the Cashier Web Terminal
app.post('/api/promotions/create', async (req, res) => {
  const { code, title, discount_text, expires_at } = req.body;

  if (!code || !title || !discount_text || !expires_at) {
    return res.status(400).json({ 
      success: false, 
      message: 'All fields (Code, Title, Discount Text, Expiration) are required.' 
    });
  }

  try {
    const formattedCode = code.trim().toUpperCase().replace(/\s+/g, '');

    await pool.query(
      `INSERT INTO promotions (code, title, discount_text, expires_at, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (code) DO UPDATE 
       SET 
         title = EXCLUDED.title,
         discount_text = EXCLUDED.discount_text,
         expires_at = EXCLUDED.expires_at,
         is_active = true`,
      [formattedCode, title.trim(), discount_text.trim(), expires_at]
    );

    // Notify all customer devices in real-time that a new offer is available
    io.emit('promoStateUpdated');

    return res.json({ 
      success: true, 
      message: `Promotion "${formattedCode}" created & activated successfully!` 
    });
  } catch (err) {
    console.error('[Add Promo Error]:', err.message);
    return res.status(500).json({ success: false, message: 'Database error creating promotion.' });
  }
});

// Delete a Promotion
app.post('/api/promotions/delete', async (req, res) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ success: false, message: 'Promo code is required.' });
  }

  try {
    await pool.query('DELETE FROM promotions WHERE code = $1', [code]);

    // Instantly notify all customer phones and cashier screens to remove the offer
    io.emit('promoStateUpdated');

    return res.json({
      success: true,
      message: `Promotion "${code}" deleted successfully.`
    });
  } catch (err) {
    console.error('[Delete Promo Error]:', err.message);
    return res.status(500).json({ success: false, message: 'Database error deleting promotion.' });
  }
});

// Generate Wallet Pass link for a specific code
app.get('/api/wallet/google/:code', async (req, res) => {
  const code = req.params.code;
  try {
    const result = await pool.query(
      `SELECT * FROM promotions WHERE code = $1 AND is_active = true AND expires_at > NOW()`,
      [code]
    );

    if (result.rows.length === 0) {
      return res.status(400).send('This offer is no longer active or has expired.');
    }

    const walletUrl = createGoogleWalletUrl(result.rows[0]);
    return res.redirect(walletUrl);
  } catch (err) {
    console.error('[Google Wallet Error]:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Cashier Coupon Redemption Endpoint
app.post('/api/redeem', async (req, res) => {
  const { couponCode } = req.body;

  if (!couponCode) {
    return res.status(400).json({ success: false, message: 'Coupon code is required.' });
  }

  try {
    // 1. Check if promo exists and is active
    const promoCheck = await pool.query(
      `SELECT * FROM promotions WHERE code = $1 AND is_active = true AND expires_at > NOW()`,
      [couponCode]
    );

    if (promoCheck.rows.length === 0) {
      return res.json({ success: false, message: 'INVALID OR EXPIRED PROMO CODE' });
    }

    // 2. Check duplicate redemptions
    const checkResult = await pool.query(
      'SELECT * FROM redemptions WHERE coupon_code = $1',
      [couponCode]
    );

    if (checkResult.rows.length > 0) {
      const redeemedTime = new Date(checkResult.rows[0].redeemed_at).toLocaleString();
      return res.json({
        success: false,
        message: `ALREADY REDEEMED on ${redeemedTime}`
      });
    }

    // 3. Insert redemption record
    await pool.query('INSERT INTO redemptions (coupon_code) VALUES ($1)', [couponCode]);

    return res.json({
      success: true,
      message: `SUCCESS! ${promoCheck.rows[0].title} (${promoCheck.rows[0].discount_text}) APPLIED`
    });
  } catch (err) {
    console.error('[Redemption Error]:', err.message);
    return res.status(500).json({ success: false, message: 'Database error processing redemption.' });
  }
});

const bcrypt = require('bcryptjs');

// Auto-seed default Superadmin on startup if table is empty
async function seedDefaultAdmin() {
  try {
    const res = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(res.rows[0].count) === 0) {
      const defaultHash = await bcrypt.hash('admin123', 10);
      await pool.query(
        'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)',
        ['admin', defaultHash, 'admin']
      );
      console.log('✅ Default admin account created (Username: admin | Password: admin123)');
    }
  } catch (err) {
    console.error('Error seeding admin user:', err.message);
  }
}
seedDefaultAdmin();

// 1. Admin Login Endpoint
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password required.' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username.trim().toLowerCase()]);
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    }

    const user = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    }

    return res.json({
      success: true,
      username: user.username,
      role: user.role,
      token: `auth_${user.id}_${Date.now()}` // Simplified auth token
    });
  } catch (err) {
    console.error('[Login Error]:', err.message);
    return res.status(500).json({ success: false, message: 'Server error during login.' });
  }
});

// 2. Add New Admin/User Endpoint (Requires existing Admin Auth Header)
app.post('/api/admin/add-user', async (req, res) => {
  const { newUsername, newPassword } = req.body;
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(403).json({ success: false, message: 'Admin authentication required.' });
  }

  if (!newUsername || !newPassword) {
    return res.status(400).json({ success: false, message: 'New username and password required.' });
  }

  try {
    const hashedPassword = await bcrypt.hash(newPassword.trim(), 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)',
      [newUsername.trim().toLowerCase(), hashedPassword, 'admin']
    );

    return res.json({ success: true, message: `User "${newUsername}" created successfully!` });
  } catch (err) {
    if (err.code === '23505') { // Postgres unique violation code
      return res.status(400).json({ success: false, message: 'Username already exists.' });
    }
    console.error('[Add User Error]:', err.message);
    return res.status(500).json({ success: false, message: 'Database error creating user.' });
  }
});

// 3. Updated Protected Create Promo Endpoint
app.post('/api/promotions/create', async (req, res) => {
  const { code, title, discount_text, expires_at } = req.body;
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(403).json({ success: false, message: 'Admin login required to publish promos.' });
  }

  if (!code || !title || !discount_text || !expires_at) {
    return res.status(400).json({ 
      success: false, 
      message: 'All fields (Code, Title, Discount Text, Expiration) are required.' 
    });
  }

  try {
    const formattedCode = code.trim().toUpperCase().replace(/\s+/g, '');

    await pool.query(
      `INSERT INTO promotions (code, title, discount_text, expires_at, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (code) DO UPDATE 
       SET 
         title = EXCLUDED.title,
         discount_text = EXCLUDED.discount_text,
         expires_at = EXCLUDED.expires_at,
         is_active = true`,
      [formattedCode, title.trim(), discount_text.trim(), expires_at]
    );

    io.emit('promoStateUpdated');

    return res.json({ 
      success: true, 
      message: `Promotion "${formattedCode}" created & activated successfully!` 
    });
  } catch (err) {
    console.error('[Add Promo Error]:', err.message);
    return res.status(500).json({ success: false, message: 'Database error creating promotion.' });
  }
});
// ==============================================
// Socket.io Real-Time Handler
// ==============================================
io.on('connection', (socket) => {
  socket.on('checkLocation', async (data) => {
    const { latitude, longitude } = data;
    if (!latitude || !longitude) {
      socket.emit('locationResult', { inside: false, message: 'Invalid GPS.' });
      return;
    }

    const distance = getDistanceInMiles(latitude, longitude, STORE_LAT, STORE_LNG);
    const isInside = distance <= GEOFENCE_RADIUS_MILES;

    let availablePromos = [];
    if (isInside) {
      const result = await pool.query(
        `SELECT * FROM promotions WHERE is_active = true AND expires_at > NOW() ORDER BY id ASC`
      );
      availablePromos = result.rows;
    }

    socket.emit('locationResult', {
      inside: isInside,
      distanceMiles: distance.toFixed(2),
      promotions: availablePromos
    });
  });
});

// ==============================================
// Start Server
// ==============================================
server.listen(PORT, () => {
  console.log('==============================================');
  console.log(' Smoke N Chill @ Research - Multi-Promo Engine Running');
  console.log(` Local: http://127.0.0.1:${PORT}`);
  console.log('==============================================');
});