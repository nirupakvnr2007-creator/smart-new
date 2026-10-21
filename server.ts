import express from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { MongoClient, Db } from 'mongodb';

interface DbSchema {
  shop: any | null;
  users: any[];
  products: any[];
  restockRequests: any[];
  transactions: any[];
  forumPosts: any[];
  reviews: any[];
}

const DB_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DB_DIR, 'smart_inventory_db.json');
const MONGO_CONFIG_FILE = path.join(DB_DIR, 'mongo_config.json');

// --- Standalone Persistent Database Engine ---
function ensureDbFile(): DbSchema {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  const defaultDb: DbSchema = {
    shop: null,
    users: [],
    products: [],
    restockRequests: [],
    transactions: [],
    forumPosts: [],
    reviews: []
  };

  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultDb, null, 2), 'utf-8');
    return defaultDb;
  }

  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      shop: parsed.shop || null,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      products: Array.isArray(parsed.products) ? parsed.products : [],
      restockRequests: Array.isArray(parsed.restockRequests) ? parsed.restockRequests : [],
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
      forumPosts: Array.isArray(parsed.forumPosts) ? parsed.forumPosts : [],
      reviews: Array.isArray(parsed.reviews) ? parsed.reviews : []
    };
  } catch (err) {
    console.error('Error reading DB_FILE, resetting to default', err);
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultDb, null, 2), 'utf-8');
    return defaultDb;
  }
}

function writeDbFile(data: DbSchema) {
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write database file', err);
  }
}

// --- MongoDB Manager ---
class MongoManager {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private uri: string = '';
  public isConnected: boolean = false;
  public lastError: string | null = null;

  constructor() {
    this.loadSavedUri();
  }

  private loadSavedUri() {
    if (process.env.MONGODB_URI) {
      this.uri = process.env.MONGODB_URI;
      return;
    }
    try {
      if (fs.existsSync(MONGO_CONFIG_FILE)) {
        const conf = JSON.parse(fs.readFileSync(MONGO_CONFIG_FILE, 'utf-8'));
        if (conf.uri) {
          this.uri = conf.uri;
          return;
        }
      }
    } catch {
      // ignore
    }
    // Offline default: connect directly to local MongoDB Compass on standard port 27017
    this.uri = 'mongodb://127.0.0.1:27017/smart_inventory';
  }

  public getUri(): string {
    return this.uri;
  }

  public getMaskedUri(): string {
    if (!this.uri) return '';
    return this.uri.replace(/:([^@]+)@/, ':****@');
  }

  public async connect(customUri?: string, silent: boolean = false): Promise<{ success: boolean; message: string }> {
    const primaryUri = customUri || this.uri;
    if (!primaryUri) {
      this.isConnected = false;
      this.lastError = 'No MongoDB URI configured';
      return { success: false, message: 'No MongoDB URI configured' };
    }

    const urisToTry = [primaryUri];
    if (primaryUri.includes('127.0.0.1')) {
      urisToTry.push(primaryUri.replace('127.0.0.1', 'localhost'));
    } else if (primaryUri.includes('localhost')) {
      urisToTry.push(primaryUri.replace('localhost', '127.0.0.1'));
    }

    let lastErr: any = null;

    for (const targetUri of urisToTry) {
      try {
        if (this.client) {
          await this.client.close().catch(() => {});
        }

        if (!silent) {
          console.log(`Checking MongoDB connection at ${targetUri}...`);
        }
        this.client = new MongoClient(targetUri, {
          serverSelectionTimeoutMS: 2000,
          connectTimeoutMS: 2000
        });

        await this.client.connect();
        this.db = this.client.db('smart_inventory');
        this.isConnected = true;
        this.uri = targetUri;
        this.lastError = null;

        try {
          if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
          fs.writeFileSync(MONGO_CONFIG_FILE, JSON.stringify({ uri: targetUri }, null, 2));
        } catch {}

        console.log(`[MongoDB] Connected successfully to database "smart_inventory" at ${targetUri}!`);
        await this.initializeTables();
        return { success: true, message: `Connected to MongoDB database smart_inventory successfully at ${targetUri}` };
      } catch (err: any) {
        lastErr = err;
      }
    }

    this.isConnected = false;
    this.lastError = lastErr?.message || 'MongoDB server not reachable';
    if (!silent) {
      console.log('[Database Engine] Local mirror active (smart_inventory_db.json). Ready for local MongoDB Compass on port 27017.');
    }
    return { success: false, message: this.lastError || 'Failed to connect to MongoDB' };
  }

  public async initializeTables(): Promise<{
    success: boolean;
    collections: string[];
    counts: Record<string, number>;
    message: string;
  }> {
    if (!this.isConnected || !this.db) {
      return {
        success: false,
        collections: [],
        counts: {},
        message: 'MongoDB is not connected. Connect locally at mongodb://127.0.0.1:27017 or via connection string.'
      };
    }

    try {
      const requiredCollections = [
        'products',
        'users',
        'shops',
        'transactions',
        'reviews',
        'restock_requests',
        'forum_posts'
      ];

      const existingCollections = await this.db.listCollections().toArray();
      const existingNames = new Set(existingCollections.map((c) => c.name));

      for (const name of requiredCollections) {
        if (!existingNames.has(name)) {
          await this.db.createCollection(name);
        }
      }

      // Ensure indexes for fast search and unique integrity
      await this.db.collection('products').createIndex({ sku: 1 }, { unique: true }).catch(() => {});
      await this.db.collection('users').createIndex({ email: 1 }, { unique: true }).catch(() => {});
      await this.db.collection('transactions').createIndex({ receiptNumber: 1 }).catch(() => {});
      await this.db.collection('transactions').createIndex({ customerPhone: 1 }).catch(() => {});
      await this.db.collection('reviews').createIndex({ productId: 1 }).catch(() => {});

      // Only seed collections if they are currently empty in MongoDB so existing Compass records are preserved
      const fileDb = ensureDbFile();

      const prodCount = await this.db.collection('products').countDocuments();
      if (prodCount === 0 && fileDb.products.length > 0) {
        await this.db.collection('products').insertMany(fileDb.products).catch(() => {});
      }

      const userCount = await this.db.collection('users').countDocuments();
      if (userCount === 0 && fileDb.users.length > 0) {
        await this.db.collection('users').insertMany(fileDb.users).catch(() => {});
      }

      const shopCount = await this.db.collection('shops').countDocuments();
      if (shopCount === 0 && fileDb.shop) {
        await this.db.collection('shops').insertOne(fileDb.shop).catch(() => {});
      }

      const reqCount = await this.db.collection('restock_requests').countDocuments();
      if (reqCount === 0 && fileDb.restockRequests.length > 0) {
        await this.db.collection('restock_requests').insertMany(fileDb.restockRequests).catch(() => {});
      }

      const txnCount = await this.db.collection('transactions').countDocuments();
      if (txnCount === 0 && fileDb.transactions.length > 0) {
        await this.db.collection('transactions').insertMany(fileDb.transactions).catch(() => {});
      }

      const revCount = await this.db.collection('reviews').countDocuments();
      if (revCount === 0 && fileDb.reviews.length > 0) {
        await this.db.collection('reviews').insertMany(fileDb.reviews).catch(() => {});
      }

      const forumCount = await this.db.collection('forum_posts').countDocuments();
      if (forumCount === 0 && fileDb.forumPosts.length > 0) {
        await this.db.collection('forum_posts').insertMany(fileDb.forumPosts).catch(() => {});
      }

      // Collect counts
      const counts: Record<string, number> = {};
      for (const col of requiredCollections) {
        counts[col] = await this.db.collection(col).countDocuments().catch(() => 0);
      }

      return {
        success: true,
        collections: requiredCollections,
        counts,
        message: 'All 7 tables (collections) created and synchronized with MongoDB Compass successfully!'
      };
    } catch (err: any) {
      return {
        success: false,
        collections: [],
        counts: {},
        message: `Failed to initialize tables: ${err?.message || 'Unknown error'}`
      };
    }
  }

  public getDb(): Db | null {
    return this.isConnected ? this.db : null;
  }
}

const mongoManager = new MongoManager();

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  app.use(express.json({ limit: '10mb' }));

  // Enable CORS for offline network scanning and cross-device access
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (_req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // Initialize MongoDB connection check silently with local JSON storage as primary active engine
  mongoManager.connect(undefined, true).catch(() => {});

  // Gentle background reconnect if user launches MongoDB locally or via start-offline.bat
  setInterval(() => {
    if (!mongoManager.isConnected) {
      mongoManager.connect(undefined, true).catch(() => {});
    }
  }, 30000);

  // 1. GET ALL DATA
  app.get('/api/data', async (_req, res) => {
    const fileDb = ensureDbFile();
    const db = mongoManager.getDb();

    if (db) {
      try {
        const [products, users, shops, restockRequests, transactions, forumPosts, reviews] = await Promise.all([
          db.collection('products').find({}).toArray(),
          db.collection('users').find({}).toArray(),
          db.collection('shops').find({}).toArray(),
          db.collection('restock_requests').find({}).toArray(),
          db.collection('transactions').find({}).toArray(),
          db.collection('forum_posts').find({}).toArray(),
          db.collection('reviews').find({}).toArray()
        ]);

        const mongoData: DbSchema = {
          shop: shops[0] ? (({ _id, ...s }) => s)(shops[0]) : (fileDb.shop || null),
          users: users.map(({ _id, ...u }) => u),
          products: products.map(({ _id, ...p }) => p),
          restockRequests: restockRequests.map(({ _id, ...r }) => r),
          transactions: transactions.map(({ _id, ...t }) => t),
          forumPosts: forumPosts.map(({ _id, ...f }) => f),
          reviews: reviews.map(({ _id, ...r }) => r)
        };

        // Keep local mirror updated
        writeDbFile(mongoData);
        return res.json(mongoData);
      } catch (err) {
        console.error('Error querying MongoDB, using local mirror', err);
      }
    }

    res.json(fileDb);
  });

  // 2. AUTH LOGIN ENDPOINT (Supports multi-device / multi-browser login)
  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const cleanPassword = password.trim();

    // Check MongoDB if connected
    const db = mongoManager.getDb();
    if (db) {
      try {
        const user = await db.collection('users').findOne({
          email: { $regex: new RegExp(`^${trimmedEmail}$`, 'i') },
          password: cleanPassword
        });
        if (user) {
          const { _id, ...userWithoutMongoId } = user;
          return res.json({ success: true, user: userWithoutMongoId });
        }
      } catch (err) {
        console.error('MongoDB auth error, querying local database', err);
      }
    }

    // Check local file DB
    const fileDb = ensureDbFile();
    const matchedUser = fileDb.users.find(
      (u: any) =>
        (u.email || '').toLowerCase() === trimmedEmail &&
        (u.password || '').trim() === cleanPassword
    );

    if (matchedUser) {
      return res.json({ success: true, user: matchedUser });
    }

    return res.status(401).json({
      success: false,
      message: 'Invalid email or password. Please verify your credentials or ask the Shop Owner.'
    });
  });

  // 3. SHOP ENDPOINT
  app.post('/api/shop', async (req, res) => {
    const shop = req.body;
    const fileDb = ensureDbFile();
    fileDb.shop = shop;
    writeDbFile(fileDb);

    const db = mongoManager.getDb();
    if (db) {
      try {
        await db.collection('shops').deleteMany({});
        await db.collection('shops').insertOne(shop);
      } catch (e) {
        console.error('MongoDB shop write error:', e);
      }
    }

    res.json({ success: true, shop });
  });

  // 4. USERS ENDPOINTS
  app.post('/api/users', async (req, res) => {
    const newUser = req.body;
    const fileDb = ensureDbFile();
    const existingIndex = fileDb.users.findIndex(
      (u: any) => u.id === newUser.id || (u.email || '').toLowerCase() === (newUser.email || '').toLowerCase()
    );
    if (existingIndex >= 0) {
      fileDb.users[existingIndex] = newUser;
    } else {
      fileDb.users.unshift(newUser);
    }
    writeDbFile(fileDb);

    const db = mongoManager.getDb();
    if (db) {
      try {
        await db.collection('users').updateOne(
          { email: newUser.email.toLowerCase() },
          { $set: newUser },
          { upsert: true }
        );
      } catch (e) {
        console.error('MongoDB user write error:', e);
      }
    }

    res.json({ success: true, users: fileDb.users });
  });

  app.delete('/api/users/:id', async (req, res) => {
    const fileDb = ensureDbFile();
    fileDb.users = fileDb.users.filter((u: any) => u.id !== req.params.id);
    writeDbFile(fileDb);

    const db = mongoManager.getDb();
    if (db) {
      try {
        await db.collection('users').deleteOne({ id: req.params.id });
      } catch (e) {
        console.error('MongoDB user delete error:', e);
      }
    }

    res.json({ success: true, users: fileDb.users });
  });

  // 5. PRODUCTS ENDPOINTS (Add, Edit, Remove, Restock trigger)
  app.post('/api/products', async (req, res) => {
    const product = req.body;
    const fileDb = ensureDbFile();
    const existingIndex = fileDb.products.findIndex((p: any) => p.id === product.id);
    if (existingIndex >= 0) {
      fileDb.products[existingIndex] = product;
    } else {
      fileDb.products.unshift(product);
    }

    // Auto-generate restock request if stock is below or equal to threshold
    if (product.availableStock <= product.minThreshold) {
      const hasPending = fileDb.restockRequests.some(
        (r: any) => r.productId === product.id && r.status === 'Pending'
      );
      if (!hasPending) {
        fileDb.restockRequests.unshift({
          id: `req-${Date.now()}`,
          productId: product.id,
          productName: product.name,
          brand: product.brand,
          currentStock: product.availableStock,
          minThreshold: product.minThreshold,
          requestedQuantity: product.minThreshold,
          supplierName: product.supplierName,
          supplierEmail: product.supplierEmail,
          supplierPhone: product.supplierPhone,
          status: 'Pending',
          createdAt: new Date().toISOString()
        });
      }
    }

    writeDbFile(fileDb);

    const db = mongoManager.getDb();
    if (db) {
      try {
        await db.collection('products').updateOne(
          { id: product.id },
          { $set: product },
          { upsert: true }
        );
        // Also sync restock requests
        if (fileDb.restockRequests.length > 0) {
          const pending = fileDb.restockRequests[0];
          await db.collection('restock_requests').updateOne(
            { id: pending.id },
            { $set: pending },
            { upsert: true }
          );
        }
      } catch (e) {
        console.error('MongoDB product write error:', e);
      }
    }

    res.json({ success: true, products: fileDb.products, restockRequests: fileDb.restockRequests });
  });

  // Manager Edit Stock Endpoint
  app.put('/api/products/:id/stock', async (req, res) => {
    const fileDb = ensureDbFile();
    const { newStock } = req.body;
    const product = fileDb.products.find((p: any) => p.id === req.params.id);
    if (product) {
      product.availableStock = Math.max(0, parseInt(newStock, 10) || 0);

      if (product.availableStock > product.minThreshold) {
        fileDb.restockRequests = fileDb.restockRequests.map((r: any) =>
          r.productId === product.id && r.status === 'Pending'
            ? { ...r, status: 'Approved' }
            : r
        );
      } else {
        const hasPending = fileDb.restockRequests.some(
          (r: any) => r.productId === product.id && r.status === 'Pending'
        );
        if (!hasPending) {
          fileDb.restockRequests.unshift({
            id: `req-${Date.now()}`,
            productId: product.id,
            productName: product.name,
            brand: product.brand,
            currentStock: product.availableStock,
            minThreshold: product.minThreshold,
            requestedQuantity: product.minThreshold,
            supplierName: product.supplierName,
            supplierEmail: product.supplierEmail,
            supplierPhone: product.supplierPhone,
            status: 'Pending',
            createdAt: new Date().toISOString()
          });
        }
      }
      writeDbFile(fileDb);

      const db = mongoManager.getDb();
      if (db) {
        try {
          await db.collection('products').updateOne(
            { id: product.id },
            { $set: { availableStock: product.availableStock } }
          );
          for (const req of fileDb.restockRequests) {
            await db.collection('restock_requests').updateOne(
              { id: req.id },
              { $set: req },
              { upsert: true }
            ).catch(() => {});
          }
        } catch (e) {
          console.error('MongoDB update stock error:', e);
        }
      }

      res.json({ success: true, product, products: fileDb.products, restockRequests: fileDb.restockRequests });
    } else {
      res.status(404).json({ error: 'Product not found' });
    }
  });

  app.delete('/api/products/:id', async (req, res) => {
    const fileDb = ensureDbFile();
    fileDb.products = fileDb.products.filter((p: any) => p.id !== req.params.id);
    fileDb.restockRequests = fileDb.restockRequests.filter((r: any) => r.productId !== req.params.id);
    writeDbFile(fileDb);

    const db = mongoManager.getDb();
    if (db) {
      try {
        await db.collection('products').deleteOne({ id: req.params.id });
        await db.collection('restock_requests').deleteMany({ productId: req.params.id });
      } catch (e) {
        console.error('MongoDB product delete error:', e);
      }
    }

    res.json({ success: true, products: fileDb.products });
  });

  // 6. RESTOCK REQUESTS ENDPOINTS
  app.put('/api/restock/:id', async (req, res) => {
    const fileDb = ensureDbFile();
    const { status } = req.body;
    fileDb.restockRequests = fileDb.restockRequests.map((r: any) =>
      r.id === req.params.id ? { ...r, status: status || 'Approved' } : r
    );
    writeDbFile(fileDb);

    const db = mongoManager.getDb();
    if (db) {
      try {
        await db.collection('restock_requests').updateOne(
          { id: req.params.id },
          { $set: { status: status || 'Approved' } }
        );
      } catch (e) {
        console.error('MongoDB restock update error:', e);
      }
    }

    res.json({ success: true, restockRequests: fileDb.restockRequests });
  });

  // 7. TRANSACTIONS / BILLING (WITH CUSTOMER PHONE NUMBER & STOCK DECREMENT)
  app.post('/api/transactions', async (req, res) => {
    const fileDb = ensureDbFile();
    const txn = req.body;

    fileDb.transactions.unshift(txn);

    if (Array.isArray(txn.items)) {
      txn.items.forEach((item: any) => {
        const product = fileDb.products.find((p: any) => p.id === item.productId || p.sku === item.sku);
        if (product) {
          product.availableStock = Math.max(0, product.availableStock - (item.quantity || 1));

          if (product.availableStock <= product.minThreshold) {
            const hasPending = fileDb.restockRequests.some(
              (r: any) => r.productId === product.id && r.status === 'Pending'
            );
            if (!hasPending) {
              fileDb.restockRequests.unshift({
                id: `req-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                productId: product.id,
                productName: product.name,
                brand: product.brand,
                currentStock: product.availableStock,
                minThreshold: product.minThreshold,
                requestedQuantity: product.minThreshold,
                supplierName: product.supplierName,
                supplierEmail: product.supplierEmail,
                supplierPhone: product.supplierPhone,
                status: 'Pending',
                createdAt: new Date().toISOString()
              });
            }
          }
        }
      });
    }

    writeDbFile(fileDb);

    const db = mongoManager.getDb();
    if (db) {
      try {
        await db.collection('transactions').insertOne(txn);
        for (const item of txn.items || []) {
          const product = fileDb.products.find((p: any) => p.id === item.productId || p.sku === item.sku);
          if (product) {
            await db.collection('products').updateOne(
              { id: product.id },
              { $set: { availableStock: product.availableStock } }
            );
          }
        }
        for (const req of fileDb.restockRequests) {
          await db.collection('restock_requests').updateOne(
            { id: req.id },
            { $set: req },
            { upsert: true }
          ).catch(() => {});
        }
      } catch (e) {
        console.error('MongoDB transaction write error:', e);
      }
    }

    res.json({
      success: true,
      transaction: txn,
      products: fileDb.products,
      restockRequests: fileDb.restockRequests,
      transactions: fileDb.transactions
    });
  });

  // 8. VERIFY CUSTOMER PURCHASE FOR FEEDBACK
  app.post('/api/verify-purchase', (req, res) => {
    const { productId, customerPhone } = req.body;
    if (!productId || !customerPhone) {
      return res.status(400).json({ verified: false, message: 'Product ID and customer phone required' });
    }

    const cleanInputPhone = customerPhone.replace(/\D/g, '');
    const fileDb = ensureDbFile();

    const matchedTxn = fileDb.transactions.find((txn: any) => {
      const cleanTxnPhone = (txn.customerPhone || '').replace(/\D/g, '');
      const phoneMatches =
        cleanTxnPhone.length >= 6 &&
        (cleanTxnPhone.includes(cleanInputPhone) || cleanInputPhone.includes(cleanTxnPhone));

      const hasProduct = txn.items?.some((i: any) => i.productId === productId);
      return phoneMatches && hasProduct;
    });

    if (matchedTxn) {
      res.json({
        verified: true,
        receiptNumber: matchedTxn.receiptNumber,
        timestamp: matchedTxn.timestamp,
        customerPhone
      });
    } else {
      res.json({
        verified: false,
        message: 'No purchase record found for this mobile number for this product.'
      });
    }
  });

  // 9. REVIEWS ENDPOINT
  app.post('/api/reviews', async (req, res) => {
    const fileDb = ensureDbFile();
    const review = req.body;
    fileDb.reviews.unshift(review);
    writeDbFile(fileDb);

    const db = mongoManager.getDb();
    if (db) {
      try {
        await db.collection('reviews').insertOne(review);
      } catch (e) {
        console.error('MongoDB review write error:', e);
      }
    }

    res.json({ success: true, reviews: fileDb.reviews });
  });

  // 10. FORUM ENDPOINTS
  app.post('/api/forum', async (req, res) => {
    const fileDb = ensureDbFile();
    const post = req.body;
    fileDb.forumPosts.unshift(post);
    writeDbFile(fileDb);

    const db = mongoManager.getDb();
    if (db) {
      try {
        await db.collection('forum_posts').insertOne(post);
      } catch (e) {
        console.error('MongoDB forum post error:', e);
      }
    }

    res.json({ success: true, forumPosts: fileDb.forumPosts });
  });

  app.post('/api/forum/:id/replies', async (req, res) => {
    const fileDb = ensureDbFile();
    const reply = req.body;
    fileDb.forumPosts = fileDb.forumPosts.map((p: any) => {
      if (p.id === req.params.id) {
        return {
          ...p,
          replies: [...(p.replies || []), reply]
        };
      }
      return p;
    });
    writeDbFile(fileDb);

    const db = mongoManager.getDb();
    if (db) {
      try {
        await db.collection('forum_posts').updateOne(
          { id: req.params.id },
          { $push: { replies: reply } as any }
        );
      } catch (e) {
        console.error('MongoDB reply write error:', e);
      }
    }

    res.json({ success: true, forumPosts: fileDb.forumPosts });
  });

  // 11. MONGODB MANAGEMENT & COMPASS SYNC ENDPOINTS
  app.get('/api/mongodb/status', async (_req, res) => {
    const isConnected = mongoManager.isConnected;
    const db = mongoManager.getDb();
    let counts: Record<string, number> = {};

    if (isConnected && db) {
      try {
        const collections = ['products', 'users', 'shops', 'transactions', 'reviews', 'restock_requests', 'forum_posts'];
        for (const col of collections) {
          counts[col] = await db.collection(col).countDocuments().catch(() => 0);
        }
      } catch {
        // ignore count error
      }
    }

    res.json({
      connected: isConnected,
      uriMasked: mongoManager.getMaskedUri(),
      databaseName: 'smart_inventory',
      counts,
      lastError: mongoManager.lastError
    });
  });

  app.post('/api/mongodb/config', async (req, res) => {
    const { uri } = req.body;
    if (!uri) {
      return res.status(400).json({ success: false, message: 'URI is required' });
    }

    const result = await mongoManager.connect(uri.trim());
    if (result.success) {
      // Sync local data to MongoDB if MongoDB is empty
      const db = mongoManager.getDb();
      if (db) {
        const fileDb = ensureDbFile();
        const pCount = await db.collection('products').countDocuments();
        if (pCount === 0 && fileDb.products.length > 0) {
          await db.collection('products').insertMany(fileDb.products);
        }
        const uCount = await db.collection('users').countDocuments();
        if (uCount === 0 && fileDb.users.length > 0) {
          await db.collection('users').insertMany(fileDb.users);
        }
      }
    }

    res.json(result);
  });

  // Explicit Table / Collection Initializer & Synchronizer
  app.post('/api/mongodb/init-tables', async (_req, res) => {
    const result = await mongoManager.initializeTables();
    res.json(result);
  });
  app.post('/api/mongodb/import-compass', async (req, res) => {
    const { collection, documents } = req.body;
    if (!collection || !Array.isArray(documents)) {
      return res.status(400).json({ success: false, message: 'collection and documents array required' });
    }

    const fileDb = ensureDbFile();
    const db = mongoManager.getDb();

    // Map Compass documents (strip or translate _id)
    const cleanedDocs = documents.map((doc: any) => {
      const copy = { ...doc };
      if (copy._id && typeof copy._id === 'object' && copy._id.$oid) {
        copy._id = copy._id.$oid;
      }
      if (!copy.id) {
        copy.id = String(copy._id || copy.sku || `item-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
      }
      return copy;
    });

    if (collection === 'products') {
      // Merge or update products
      cleanedDocs.forEach((newP: any) => {
        const existingIdx = fileDb.products.findIndex(
          (p: any) => p.id === newP.id || p.sku === newP.sku
        );
        if (existingIdx >= 0) {
          fileDb.products[existingIdx] = { ...fileDb.products[existingIdx], ...newP };
        } else {
          fileDb.products.push(newP);
        }
      });
      writeDbFile(fileDb);

      if (db) {
        for (const doc of cleanedDocs) {
          await db.collection('products').updateOne(
            { sku: doc.sku },
            { $set: doc },
            { upsert: true }
          ).catch(() => {});
        }
      }
    }

    res.json({ success: true, count: cleanedDocs.length, products: fileDb.products });
  });

  // 12. Mount Vite or static dist
  if (fs.existsSync(path.resolve('dist')) && process.env.VITE_DEV !== 'true') {
    app.use(express.static('dist'));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve('dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    const url = `http://localhost:${PORT}`;
    console.log(`===================================================`);
    console.log(`  Mepco Retail Hub running on ${url}`);
    console.log(`  Target Database: MongoDB smart_inventory`);
    console.log(`===================================================`);

    // Auto-open browser on local desktop environments
    if (process.env.AUTO_OPEN !== 'false' && !process.env.K_SERVICE) {
      setTimeout(() => {
        const openCmd =
          process.platform === 'win32'
            ? `start "" "${url}"`
            : process.platform === 'darwin'
            ? `open "${url}"`
            : `xdg-open "${url}"`;
        exec(openCmd, () => {});
      }, 500);
    }
  });
}

startServer();
