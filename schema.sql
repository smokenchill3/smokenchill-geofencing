-- Drop existing tables if re-running script
DROP TABLE IF EXISTS redemptions;
DROP TABLE IF EXISTS promotions;
DROP TABLE IF EXISTS stores;

-- 1. Create Stores Table
CREATE TABLE stores (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    latitude NUMERIC(10, 7) NOT NULL,
    longitude NUMERIC(10, 7) NOT NULL,
    geofence_radius_miles NUMERIC(4, 2) DEFAULT 5.00
);

-- 2. Create Promotions Table
CREATE TABLE promotions (
    id SERIAL PRIMARY KEY,
    store_id INT REFERENCES stores(id) ON DELETE CASCADE,
    title VARCHAR(150) NOT NULL,
    code VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    in_stock BOOLEAN DEFAULT TRUE,
    is_active BOOLEAN DEFAULT TRUE,
    requires_21_plus BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Create Redemptions Tracking Table
CREATE TABLE redemptions (
    id SERIAL PRIMARY KEY,
    promotion_id INT REFERENCES promotions(id) ON DELETE CASCADE,
    customer_id VARCHAR(100) NOT NULL,
    cashier_id VARCHAR(100),
    redeemed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(promotion_id, customer_id)
);

-- 4. Seed Initial Sample Data
INSERT INTO stores (name, latitude, longitude, geofence_radius_miles)
VALUES ('Smoke N Chill #3 at Research', 30.2672, -97.7431, 5.00);

INSERT INTO promotions (store_id, title, code, description, in_stock, requires_21_plus) VALUES
(1, '$5 Off Any Premium D9 Gummies Mix & Match $40+', 'D9THC5-782', 'Get $5 off Any D9 Gummies Mix & Match.', TRUE, TRUE),
(1, '20% Off Any D9 Flower from 5.2gm to 7Gm', 'D9FL20-419', 'Special weekend store discount for D9 THC Flower.', TRUE, TRUE),
(1, 'Buy 1 Get 1 50% Off Selected Disposables', 'DISP-902', 'Applies to equal or lesser value Flavor Beast.', FALSE, TRUE);