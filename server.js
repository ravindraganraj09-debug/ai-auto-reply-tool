async function connectDatabase() {
  try {
    usersCollection = db.collection("users");

    await usersCollection.createIndex({ email: 1 }, { unique: true });
    console.log("MongoDB connected");
  } catch (error) {
    usersCollection = null;
    console.error("MongoDB connection failed:", error.message);
  }
}

connectDatabase();

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

function getUserIdFromToken(req) {
  try {
    const token = getBearerToken(req);
    if (!token) return null;
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.id;
  } catch (error) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const userId = getUserIdFromToken(req);
  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  req.authUserId = userId;
  next();
}

async function generateAiReply(message, business) {
  try {
    const prompt = business
      ? `Generate a professional reply for the following customer message for a ${business} business: "${message}"`
      : `Generate a professional reply for the following customer message: "${message}"`;

    const models = ["gemini-1.5-flash", "gemini-1.5-pro"];
    for (const model of models) {
      const requestUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const requestHeaders = {
        "Content-Type": "application/json",
      };

      const aiResponse = await fetch(requestUrl, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
              ],
            },
          ],
        }),
      });

      if (!aiResponse.ok) {
        const errorText = await aiResponse.text();
        console.error(`Gemini API error (${model}):`, aiResponse.status, errorText);
        continue;
      }

      const aiData = await aiResponse.json();
      const generatedText = aiData?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (generatedText) {
        return generatedText;
      }
    }

    return business
      ? `Smart reply for "${message}" (${business})`
      : `Smart reply for "${message}"`;
  } catch (_error) {
    return business
      ? `Smart reply for "${message}" (${business})`
      : `Smart reply for "${message}"`;
  }
}

// Signup
app.post("/signup", async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ success: false, message: "Database unavailable. Try again." });
    }

    const { email, password } = req.body;

    const strongPassword = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;
    if (!strongPassword.test(password || "")) {
      return res.status(400).json({ success: false, message: "Password must be 8+ chars with upper, lower, number, and special character." });
    }

    const existingUser = await usersCollection.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ success: false, message: "Email already registered" });
    }

    const hashed = await bcrypt.hash(password, 10);
    await usersCollection.insertOne({
      email,
      password: hashed,
      usage: 0,
      premium: false,
      replyHistory: [],
    });

    res.status(201).json({ success: true, message: "User created successfully. Please login." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// Login
app.post("/login", async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const { email, password } = req.body;

    const user = await usersCollection.findOne({ email });
    if (!user) return res.json({ message: "User not found" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.json({ message: "Wrong password" });

    const token = jwt.sign({ id: user._id.toString() }, JWT_SECRET, { expiresIn: "7d" });

    res.json({ token, user: toPublicUser(user) });
  } catch (error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/me", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const user = await usersCollection.findOne({ _id: new ObjectId(req.authUserId) });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json({ user: toPublicUser(user) });
  } catch (error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/history", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const user = await usersCollection.findOne(
      { _id: new ObjectId(req.authUserId) },
      { projection: { replyHistory: 1 } }
    );

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const history = (user.replyHistory || []).slice().reverse();
    res.json({ history });
  } catch (error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/change-password", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Current and new password are required." });
    }

    const strongPassword = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;
    if (!strongPassword.test(newPassword || "")) {
      return res.status(400).json({ message: "New password must be 8+ chars with upper, lower, number, and special character." });
    }

    const user = await usersCollection.findOne({ _id: new ObjectId(req.authUserId) });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Current password is incorrect." });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await usersCollection.updateOne(
      { _id: user._id },
      { $set: { password: hashedPassword } }
    );

    res.json({ message: "Password updated successfully." });
  } catch (error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/api/reply", requireAuth, async (req, res) => {
  try {
    const { message, business } = req.body;
    const targetUserId = req.authUserId;
    if (!isDatabaseReady()) {
      return res.status(503).json({ reply: "Database unavailable. Try again." });
    }

    if (!ObjectId.isValid(targetUserId)) {
      return res.status(400).json({ reply: "Invalid userId." });
    }

    if (!message || !String(message).trim()) {
      return res.status(400).json({ reply: "Message is required." });
    }

    const user = await usersCollection.findOne({ _id: new ObjectId(targetUserId) });

    if (!user) {
      return res.status(404).json({ reply: "User not found." });
    }

    if (!user.premium && user.usage >= 5) {
      return res.json({ reply: "Limit reached! Upgrade to premium." });
    }

    const reply = await generateAiReply(message, business);

    await usersCollection.updateOne(
      { _id: user._id },
      {
        $inc: { usage: 1 },
        $push: {
          replyHistory: {
            message,
            business: business || "",
            reply,
            createdAt: new Date(),
          },
        },
      }
    );

    res.json({ reply });
  } catch (error) {
    res.status(500).json({ reply: "Internal server error." });
  }
});

app.post("/create-order", requireAuth, async (req, res) => {
  try {
    const targetUserId = req.authUserId;
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    if (!ObjectId.isValid(targetUserId)) {
      return res.status(400).json({ message: "Invalid userId." });
    }

    const user = await usersCollection.findOne({ _id: new ObjectId(targetUserId) });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const order = await razorpay.orders.create({
      amount: premiumPlan.amount,
      currency: premiumPlan.currency,
      receipt: `p_${Date.now()}`,
      notes: {
        userId: targetUserId,
      },
    });

    await usersCollection.updateOne(
      { _id: user._id },
      {
        $set: {
          pendingOrderId: order.id,
        },
      }
    );

    res.json({
      key: paymentConfig.key_id,
      amount: order.amount,
      currency: order.currency,
      orderId: order.id,
    });
  } catch (error) {
    console.error("Create order failed:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/verify-payment", requireAuth, async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body || {};
    const targetUserId = req.authUserId;
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    if (!ObjectId.isValid(targetUserId)) {
      return res.status(400).json({ message: "Invalid userId." });
    }

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: "Payment verification data is required." });
    }

    const expectedSignature = crypto
      .createHmac("sha256", paymentConfig.key_secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ message: "Invalid payment signature." });
    }

    const result = await usersCollection.updateOne(
      {
        _id: new ObjectId(targetUserId),
        pendingOrderId: razorpay_order_id,
      },
      {
        $set: {
          premium: true,
          planName: "Premium",
          lastPaymentId: razorpay_payment_id,
          lastOrderId: razorpay_order_id,
          premiumActivatedAt: new Date(),
          premiumExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        },
        $unset: {
          pendingOrderId: "",
        },
      }
    );

    if (!result.matchedCount) {
      return res.status(404).json({ message: "User not found or order mismatch." });
    }

    res.json({ message: "Premium activated successfully." });
  } catch (error) {
    console.error("Verify payment failed:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});