// server.ts
import express from "express";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { MongoClient } from "mongodb";
var DB_DIR = path.resolve(process.cwd(), "data");
var DB_FILE = path.join(DB_DIR, "smart_inventory_db.json");
var MONGO_CONFIG_FILE = path.join(DB_DIR, "mongo_config.json");
function ensureDbFile() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
  const defaultDb = {
    shop: null,
    users: [],
    products: [],
    restockRequests: [],
    transactions: [],
    forumPosts: [],
    reviews: []
  };
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultDb, null, 2), "utf-8");
    return defaultDb;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, "utf-8");
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
    console.error("Error reading DB_FILE, resetting to default", err);
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultDb, null, 2), "utf-8");
    return defaultDb;
  }
}
function writeDbFile(data) {
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to write database file", err);
  }
}
var MongoManager = class {
  constructor() {
    this.client = null;
    this.db = null;
    this.uri = "";
    this.isConnected = false;
    this.lastError = null;
    this.loadSavedUri();
  }
  loadSavedUri() {
    if (process.env.MONGODB_URI) {
      this.uri = process.env.MONGODB_URI;
      return;
    }
    try {
      if (fs.existsSync(MONGO_CONFIG_FILE)) {
        const conf = JSON.parse(fs.readFileSync(MONGO_CONFIG_FILE, "utf-8"));
        if (conf.uri) {
          this.uri = conf.uri;
          return;
        }
      }
    } catch {
    }
    this.uri = "mongodb://127.0.0.1:27017/smart_inventory";
  }
  getUri() {
    return this.uri;
  }
  getMaskedUri() {
    if (!this.uri) return "";
    return this.uri.replace(/:([^@]+)@/, ":****@");
  }
  async connect(customUri, silent = false) {
    const targetUri = customUri || this.uri;
    if (!targetUri) {
      this.isConnected = false;
      this.lastError = "No MongoDB URI configured";
      return { success: false, message: "No MongoDB URI configured" };
    }
    try {
      if (this.client) {
        await this.client.close().catch(() => {
        });
      }
      if (!silent) {
        console.log(`Checking MongoDB connection at ${this.getMaskedUri()}...`);
      }
      this.client = new MongoClient(targetUri, {
        serverSelectionTimeoutMS: 2e3,
        connectTimeoutMS: 2e3
      });
      await this.client.connect();
      this.db = this.client.db("smart_inventory");
      this.isConnected = true;
      this.uri = targetUri;
      this.lastError = null;
      try {
        if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
        fs.writeFileSync(MONGO_CONFIG_FILE, JSON.stringify({ uri: targetUri }, null, 2));
      } catch (e) {
        console.error("Failed to save mongo config", e);
      }
      console.log("MongoDB connected successfully to smart_inventory database!");
      await this.initializeTables();
      return { success: true, message: "Connected to MongoDB smart_inventory successfully!" };
    } catch (err) {
      this.isConnected = false;
      this.lastError = err?.message || "MongoDB server not reachable";
      if (!silent) {
        console.log("[Database Engine] Local storage active (smart_inventory_db.json). Ready for local MongoDB Compass on port 27017.");
      }
      return { success: false, message: this.lastError || "Failed to connect to MongoDB" };
    }
  }
  async initializeTables() {
    if (!this.isConnected || !this.db) {
      return {
        success: false,
        collections: [],
        counts: {},
        message: "MongoDB is not connected. Connect locally at mongodb://127.0.0.1:27017 or via connection string."
      };
    }
    try {
      const requiredCollections = [
        "products",
        "users",
        "shops",
        "transactions",
        "reviews",
        "restock_requests",
        "forum_posts"
      ];
      const existingCollections = await this.db.listCollections().toArray();
      const existingNames = new Set(existingCollections.map((c) => c.name));
      for (const name of requiredCollections) {
        if (!existingNames.has(name)) {
          await this.db.createCollection(name);
        }
      }
      await this.db.collection("products").createIndex({ sku: 1 }, { unique: true }).catch(() => {
      });
      await this.db.collection("users").createIndex({ email: 1 }, { unique: true }).catch(() => {
      });
      await this.db.collection("transactions").createIndex({ receiptNumber: 1 }).catch(() => {
      });
      await this.db.collection("transactions").createIndex({ customerPhone: 1 }).catch(() => {
      });
      await this.db.collection("reviews").createIndex({ productId: 1 }).catch(() => {
      });
      const fileDb = ensureDbFile();
      if (fileDb.products.length > 0) {
        for (const prod of fileDb.products) {
          await this.db.collection("products").updateOne(
            { sku: prod.sku },
            { $set: prod },
            { upsert: true }
          ).catch(() => {
          });
        }
      }
      if (fileDb.users.length > 0) {
        for (const user of fileDb.users) {
          await this.db.collection("users").updateOne(
            { email: user.email.toLowerCase() },
            { $set: user },
            { upsert: true }
          ).catch(() => {
          });
        }
      }
      if (fileDb.shop) {
        await this.db.collection("shops").deleteMany({}).catch(() => {
        });
        await this.db.collection("shops").insertOne(fileDb.shop).catch(() => {
        });
      }
      if (fileDb.restockRequests.length > 0) {
        for (const req of fileDb.restockRequests) {
          await this.db.collection("restock_requests").updateOne(
            { id: req.id },
            { $set: req },
            { upsert: true }
          ).catch(() => {
          });
        }
      }
      if (fileDb.transactions.length > 0) {
        for (const txn of fileDb.transactions) {
          await this.db.collection("transactions").updateOne(
            { receiptNumber: txn.receiptNumber },
            { $set: txn },
            { upsert: true }
          ).catch(() => {
          });
        }
      }
      if (fileDb.reviews.length > 0) {
        for (const rev of fileDb.reviews) {
          await this.db.collection("reviews").updateOne(
            { id: rev.id },
            { $set: rev },
            { upsert: true }
          ).catch(() => {
          });
        }
      }
      if (fileDb.forumPosts.length > 0) {
        for (const post of fileDb.forumPosts) {
          await this.db.collection("forum_posts").updateOne(
            { id: post.id },
            { $set: post },
            { upsert: true }
          ).catch(() => {
          });
        }
      }
      const counts = {};
      for (const col of requiredCollections) {
        counts[col] = await this.db.collection(col).countDocuments().catch(() => 0);
      }
      return {
        success: true,
        collections: requiredCollections,
        counts,
        message: "All 7 tables (collections) created and synchronized with MongoDB Compass successfully!"
      };
    } catch (err) {
      return {
        success: false,
        collections: [],
        counts: {},
        message: `Failed to initialize tables: ${err?.message || "Unknown error"}`
      };
    }
  }
  getDb() {
    return this.isConnected ? this.db : null;
  }
};
var mongoManager = new MongoManager();
async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || "3000", 10);
  app.use(express.json({ limit: "10mb" }));
  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    if (_req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });
  mongoManager.connect(void 0, true).catch(() => {
  });
  setInterval(() => {
    if (!mongoManager.isConnected) {
      mongoManager.connect(void 0, true).catch(() => {
      });
    }
  }, 3e4);
  app.get("/api/data", async (_req, res) => {
    const fileDb = ensureDbFile();
    const db = mongoManager.getDb();
    if (db) {
      try {
        const [products, users, shops, restockRequests, transactions, forumPosts, reviews] = await Promise.all([
          db.collection("products").find({}).toArray(),
          db.collection("users").find({}).toArray(),
          db.collection("shops").find({}).toArray(),
          db.collection("restock_requests").find({}).toArray(),
          db.collection("transactions").find({}).toArray(),
          db.collection("forum_posts").find({}).toArray(),
          db.collection("reviews").find({}).toArray()
        ]);
        const mongoData = {
          shop: shops[0] ? (({ _id, ...s }) => s)(shops[0]) : fileDb.shop || null,
          users: users.map(({ _id, ...u }) => u),
          products: products.map(({ _id, ...p }) => p),
          restockRequests: restockRequests.map(({ _id, ...r }) => r),
          transactions: transactions.map(({ _id, ...t }) => t),
          forumPosts: forumPosts.map(({ _id, ...f }) => f),
          reviews: reviews.map(({ _id, ...r }) => r)
        };
        writeDbFile(mongoData);
        return res.json(mongoData);
      } catch (err) {
        console.error("Error querying MongoDB, using local mirror", err);
      }
    }
    res.json(fileDb);
  });
  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password required" });
    }
    const trimmedEmail = email.trim().toLowerCase();
    const cleanPassword = password.trim();
    const db = mongoManager.getDb();
    if (db) {
      try {
        const user = await db.collection("users").findOne({
          email: { $regex: new RegExp(`^${trimmedEmail}$`, "i") },
          password: cleanPassword
        });
        if (user) {
          const { _id, ...userWithoutMongoId } = user;
          return res.json({ success: true, user: userWithoutMongoId });
        }
      } catch (err) {
        console.error("MongoDB auth error, querying local database", err);
      }
    }
    const fileDb = ensureDbFile();
    const matchedUser = fileDb.users.find(
      (u) => (u.email || "").toLowerCase() === trimmedEmail && (u.password || "").trim() === cleanPassword
    );
    if (matchedUser) {
      return res.json({ success: true, user: matchedUser });
    }
    return res.status(401).json({
      success: false,
      message: "Invalid email or password. Please verify your credentials or ask the Shop Owner."
    });
  });
  app.post("/api/shop", async (req, res) => {
    const shop = req.body;
    const fileDb = ensureDbFile();
    fileDb.shop = shop;
    writeDbFile(fileDb);
    const db = mongoManager.getDb();
    if (db) {
      try {
        await db.collection("shops").deleteMany({});
        await db.collection("shops").insertOne(shop);
      } catch (e) {
        console.error("MongoDB shop write error:", e);
      }
    }
    res.json({ success: true, shop });
  });
  app.post("/api/users", async (req, res) => {
    const newUser = req.body;
    const fileDb = ensureDbFile();
    const existingIndex = fileDb.users.findIndex(
      (u) => u.id === newUser.id || (u.email || "").toLowerCase() === (newUser.email || "").toLowerCase()
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
        await db.collection("users").updateOne(
          { email: newUser.email.toLowerCase() },
          { $set: newUser },
          { upsert: true }
        );
      } catch (e) {
        console.error("MongoDB user write error:", e);
      }
    }
    res.json({ success: true, users: fileDb.users });
  });
  app.delete("/api/users/:id", async (req, res) => {
    const fileDb = ensureDbFile();
    fileDb.users = fileDb.users.filter((u) => u.id !== req.params.id);
    writeDbFile(fileDb);
    const db = mongoManager.getDb();
    if (db) {
      try {
        await db.collection("users").deleteOne({ id: req.params.id });
      } catch (e) {
        console.error("MongoDB user delete error:", e);
      }
    }
    res.json({ success: true, users: fileDb.users });
  });
  app.post("/api/products", async (req, res) => {
    const product = req.body;
    const fileDb = ensureDbFile();
    const existingIndex = fileDb.products.findIndex((p) => p.id === product.id);
    if (existingIndex >= 0) {
      fileDb.products[existingIndex] = product;
    } else {
      fileDb.products.unshift(product);
    }
    if (product.availableStock <= product.minThreshold) {
      const hasPending = fileDb.restockRequests.some(
        (r) => r.productId === product.id && r.status === "Pending"
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
          status: "Pending",
          createdAt: (/* @__PURE__ */ new Date()).toISOString()
        });
      }
    }
    writeDbFile(fileDb);
    const db = mongoManager.getDb();
    if (db) {
      try {
        await db.collection("products").updateOne(
          { id: product.id },
          { $set: product },
          { upsert: true }
        );
        if (fileDb.restockRequests.length > 0) {
          const pending = fileDb.restockRequests[0];
          await db.collection("restock_requests").updateOne(
            { id: pending.id },
            { $set: pending },
            { upsert: true }
          );
        }
      } catch (e) {
        console.error("MongoDB product write error:", e);
      }
    }
    res.json({ success: true, products: fileDb.products, restockRequests: fileDb.restockRequests });
  });
  app.put("/api/products/:id/stock", async (req, res) => {
    const fileDb = ensureDbFile();
    const { newStock } = req.body;
    const product = fileDb.products.find((p) => p.id === req.params.id);
    if (product) {
      product.availableStock = Math.max(0, parseInt(newStock, 10) || 0);
      if (product.availableStock > product.minThreshold) {
        fileDb.restockRequests = fileDb.restockRequests.map(
          (r) => r.productId === product.id && r.status === "Pending" ? { ...r, status: "Approved" } : r
        );
      } else {
        const hasPending = fileDb.restockRequests.some(
          (r) => r.productId === product.id && r.status === "Pending"
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
            status: "Pending",
            createdAt: (/* @__PURE__ */ new Date()).toISOString()
          });
        }
      }
      writeDbFile(fileDb);
      const db = mongoManager.getDb();
      if (db) {
        try {
          await db.collection("products").updateOne(
            { id: product.id },
            { $set: { availableStock: product.availableStock } }
          );
          for (const req2 of fileDb.restockRequests) {
            await db.collection("restock_requests").updateOne(
              { id: req2.id },
              { $set: req2 },
              { upsert: true }
            ).catch(() => {
            });
          }
        } catch (e) {
          console.error("MongoDB update stock error:", e);
        }
      }
      res.json({ success: true, product, products: fileDb.products, restockRequests: fileDb.restockRequests });
    } else {
      res.status(404).json({ error: "Product not found" });
    }
  });
  app.delete("/api/products/:id", async (req, res) => {
    const fileDb = ensureDbFile();
    fileDb.products = fileDb.products.filter((p) => p.id !== req.params.id);
    fileDb.restockRequests = fileDb.restockRequests.filter((r) => r.productId !== req.params.id);
    writeDbFile(fileDb);
    const db = mongoManager.getDb();
    if (db) {
      try {
        await db.collection("products").deleteOne({ id: req.params.id });
        await db.collection("restock_requests").deleteMany({ productId: req.params.id });
      } catch (e) {
        console.error("MongoDB product delete error:", e);
      }
    }
    res.json({ success: true, products: fileDb.products });
  });
  app.put("/api/restock/:id", async (req, res) => {
    const fileDb = ensureDbFile();
    const { status } = req.body;
    fileDb.restockRequests = fileDb.restockRequests.map(
      (r) => r.id === req.params.id ? { ...r, status: status || "Approved" } : r
    );
    writeDbFile(fileDb);
    const db = mongoManager.getDb();
    if (db) {
      try {
        await db.collection("restock_requests").updateOne(
          { id: req.params.id },
          { $set: { status: status || "Approved" } }
        );
      } catch (e) {
        console.error("MongoDB restock update error:", e);
      }
    }
    res.json({ success: true, restockRequests: fileDb.restockRequests });
  });
  app.post("/api/transactions", async (req, res) => {
    const fileDb = ensureDbFile();
    const txn = req.body;
    fileDb.transactions.unshift(txn);
    if (Array.isArray(txn.items)) {
      txn.items.forEach((item) => {
        const product = fileDb.products.find((p) => p.id === item.productId || p.sku === item.sku);
        if (product) {
          product.availableStock = Math.max(0, product.availableStock - (item.quantity || 1));
          if (product.availableStock <= product.minThreshold) {
            const hasPending = fileDb.restockRequests.some(
              (r) => r.productId === product.id && r.status === "Pending"
            );
            if (!hasPending) {
              fileDb.restockRequests.unshift({
                id: `req-${Date.now()}-${Math.floor(Math.random() * 1e3)}`,
                productId: product.id,
                productName: product.name,
                brand: product.brand,
                currentStock: product.availableStock,
                minThreshold: product.minThreshold,
                requestedQuantity: product.minThreshold,
                supplierName: product.supplierName,
                supplierEmail: product.supplierEmail,
                supplierPhone: product.supplierPhone,
                status: "Pending",
                createdAt: (/* @__PURE__ */ new Date()).toISOString()
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
        await db.collection("transactions").insertOne(txn);
        for (const item of txn.items || []) {
          const product = fileDb.products.find((p) => p.id === item.productId || p.sku === item.sku);
          if (product) {
            await db.collection("products").updateOne(
              { id: product.id },
              { $set: { availableStock: product.availableStock } }
            );
          }
        }
        for (const req2 of fileDb.restockRequests) {
          await db.collection("restock_requests").updateOne(
            { id: req2.id },
            { $set: req2 },
            { upsert: true }
          ).catch(() => {
          });
        }
      } catch (e) {
        console.error("MongoDB transaction write error:", e);
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
  app.post("/api/verify-purchase", (req, res) => {
    const { productId, customerPhone } = req.body;
    if (!productId || !customerPhone) {
      return res.status(400).json({ verified: false, message: "Product ID and customer phone required" });
    }
    const cleanInputPhone = customerPhone.replace(/\D/g, "");
    const fileDb = ensureDbFile();
    const matchedTxn = fileDb.transactions.find((txn) => {
      const cleanTxnPhone = (txn.customerPhone || "").replace(/\D/g, "");
      const phoneMatches = cleanTxnPhone.length >= 6 && (cleanTxnPhone.includes(cleanInputPhone) || cleanInputPhone.includes(cleanTxnPhone));
      const hasProduct = txn.items?.some((i) => i.productId === productId);
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
        message: "No purchase record found for this mobile number for this product."
      });
    }
  });
  app.post("/api/reviews", async (req, res) => {
    const fileDb = ensureDbFile();
    const review = req.body;
    fileDb.reviews.unshift(review);
    writeDbFile(fileDb);
    const db = mongoManager.getDb();
    if (db) {
      try {
        await db.collection("reviews").insertOne(review);
      } catch (e) {
        console.error("MongoDB review write error:", e);
      }
    }
    res.json({ success: true, reviews: fileDb.reviews });
  });
  app.post("/api/forum", async (req, res) => {
    const fileDb = ensureDbFile();
    const post = req.body;
    fileDb.forumPosts.unshift(post);
    writeDbFile(fileDb);
    const db = mongoManager.getDb();
    if (db) {
      try {
        await db.collection("forum_posts").insertOne(post);
      } catch (e) {
        console.error("MongoDB forum post error:", e);
      }
    }
    res.json({ success: true, forumPosts: fileDb.forumPosts });
  });
  app.post("/api/forum/:id/replies", async (req, res) => {
    const fileDb = ensureDbFile();
    const reply = req.body;
    fileDb.forumPosts = fileDb.forumPosts.map((p) => {
      if (p.id === req.params.id) {
        return {
          ...p,
          replies: [...p.replies || [], reply]
        };
      }
      return p;
    });
    writeDbFile(fileDb);
    const db = mongoManager.getDb();
    if (db) {
      try {
        await db.collection("forum_posts").updateOne(
          { id: req.params.id },
          { $push: { replies: reply } }
        );
      } catch (e) {
        console.error("MongoDB reply write error:", e);
      }
    }
    res.json({ success: true, forumPosts: fileDb.forumPosts });
  });
  app.get("/api/mongodb/status", async (_req, res) => {
    const isConnected = mongoManager.isConnected;
    const db = mongoManager.getDb();
    let counts = {};
    if (isConnected && db) {
      try {
        const collections = ["products", "users", "shops", "transactions", "reviews", "restock_requests", "forum_posts"];
        for (const col of collections) {
          counts[col] = await db.collection(col).countDocuments().catch(() => 0);
        }
      } catch {
      }
    }
    res.json({
      connected: isConnected,
      uriMasked: mongoManager.getMaskedUri(),
      databaseName: "smart_inventory",
      counts,
      lastError: mongoManager.lastError
    });
  });
  app.post("/api/mongodb/config", async (req, res) => {
    const { uri } = req.body;
    if (!uri) {
      return res.status(400).json({ success: false, message: "URI is required" });
    }
    const result = await mongoManager.connect(uri.trim());
    if (result.success) {
      const db = mongoManager.getDb();
      if (db) {
        const fileDb = ensureDbFile();
        const pCount = await db.collection("products").countDocuments();
        if (pCount === 0 && fileDb.products.length > 0) {
          await db.collection("products").insertMany(fileDb.products);
        }
        const uCount = await db.collection("users").countDocuments();
        if (uCount === 0 && fileDb.users.length > 0) {
          await db.collection("users").insertMany(fileDb.users);
        }
      }
    }
    res.json(result);
  });
  app.post("/api/mongodb/init-tables", async (_req, res) => {
    const result = await mongoManager.initializeTables();
    res.json(result);
  });
  app.post("/api/mongodb/import-compass", async (req, res) => {
    const { collection, documents } = req.body;
    if (!collection || !Array.isArray(documents)) {
      return res.status(400).json({ success: false, message: "collection and documents array required" });
    }
    const fileDb = ensureDbFile();
    const db = mongoManager.getDb();
    const cleanedDocs = documents.map((doc) => {
      const copy = { ...doc };
      if (copy._id && typeof copy._id === "object" && copy._id.$oid) {
        copy._id = copy._id.$oid;
      }
      if (!copy.id) {
        copy.id = String(copy._id || copy.sku || `item-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
      }
      return copy;
    });
    if (collection === "products") {
      cleanedDocs.forEach((newP) => {
        const existingIdx = fileDb.products.findIndex(
          (p) => p.id === newP.id || p.sku === newP.sku
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
          await db.collection("products").updateOne(
            { sku: doc.sku },
            { $set: doc },
            { upsert: true }
          ).catch(() => {
          });
        }
      }
    }
    res.json({ success: true, count: cleanedDocs.length, products: fileDb.products });
  });
  if (fs.existsSync(path.resolve("dist")) && process.env.VITE_DEV !== "true") {
    app.use(express.static("dist"));
    app.get("*", (_req, res) => {
      res.sendFile(path.resolve("dist", "index.html"));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  }
  app.listen(PORT, "0.0.0.0", () => {
    const url = `http://localhost:${PORT}`;
    console.log(`===================================================`);
    console.log(`  Mepco Retail Hub running on ${url}`);
    console.log(`  Target Database: MongoDB smart_inventory`);
    console.log(`===================================================`);
    if (process.env.AUTO_OPEN !== "false" && !process.env.K_SERVICE) {
      setTimeout(() => {
        const openCmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
        exec(openCmd, () => {
        });
      }, 500);
    }
  });
}
startServer();
