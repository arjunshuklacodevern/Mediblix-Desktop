import repositories from "../../../database/repositories/index.js";

const { getDatabase, productRepository } = repositories;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Clinical OTC Knowledge Base for Common Ailments
// ─────────────────────────────────────────────────────────────────────────────
export const OTC_CLINICAL_KNOWLEDGE = [
  {
    condition: "Mild Fever and Headache",
    severity: "mild",
    keywords: ["fever", "headache", "body ache", "body pain", "pyrexia", "temperature", "dolo", "paracetamol"],
    medicines: [
      {
        genericName: "Paracetamol 650mg",
        commonBrandNames: ["Dolo 650", "Calpol 650", "Pacimol 650"],
        category: "Analgesics & Antipyretics",
        dosageGuideline: "1 tablet after meals every 6-8 hours as needed. Maximum 3000mg/day.",
        precaution: "Do not exceed maximum daily dosage. Avoid alcohol consumption.",
      },
      {
        genericName: "Paracetamol 500mg",
        commonBrandNames: ["Crocin 500", "Calpol 500", "Metacin"],
        category: "Analgesics & Antipyretics",
        dosageGuideline: "1 tablet every 4-6 hours after meals as required.",
        precaution: "Consult physician if fever persists beyond 3 days.",
      },
    ],
    generalAdvice: "Stay well hydrated with warm fluids and take adequate rest. Monitor body temperature regularly.",
  },
  {
    condition: "Common Cold and Allergic Rhinitis",
    severity: "mild",
    keywords: ["cold", "cough", "runny nose", "sneezing", "nasal congestion", "sore throat", "flu"],
    medicines: [
      {
        genericName: "Levocetirizine 5mg",
        commonBrandNames: ["Levocet", "Vozet", "1-AL"],
        category: "Respiratory",
        dosageGuideline: "1 tablet at bedtime with water.",
        precaution: "May cause drowsiness; avoid driving or operating machinery.",
      },
      {
        genericName: "Cetirizine 10mg",
        commonBrandNames: ["Cetzine", "Zyrtec", "Alerid"],
        category: "Respiratory",
        dosageGuideline: "1 tablet once daily, preferably in the evening.",
        precaution: "Avoid concurrent use with sedatives or alcohol.",
      },
      {
        genericName: "Dextromethorphan + Chlorpheniramine Syrup",
        commonBrandNames: ["Benadryl DR", "Ascoril D", "Grilinctus"],
        category: "Respiratory",
        dosageGuideline: "5-10 ml twice or thrice daily after food.",
        precaution: "Do not exceed recommended dose. Not for chronic smokers cough.",
      },
    ],
    generalAdvice: "Inhale steam twice daily, drink warm water or herbal tea, and avoid exposure to sudden temperature changes.",
  },
  {
    condition: "Acidity, Heartburn & Indigestion",
    severity: "mild",
    keywords: ["acidity", "heartburn", "gas", "indigestion", "gerd", "bloating", "acid reflux", "stomach burn"],
    medicines: [
      {
        genericName: "Pantoprazole 40mg",
        commonBrandNames: ["Pan 40", "Pantocid 40", "Pantodac"],
        category: "Gastrointestinal",
        dosageGuideline: "1 tablet in the morning 30 minutes before breakfast.",
        precaution: "Swallow whole, do not crush or chew. Take on an empty stomach.",
      },
      {
        genericName: "Rabeprazole 20mg",
        commonBrandNames: ["Razo 20", "Happi 20", "Rablet"],
        category: "Gastrointestinal",
        dosageGuideline: "1 tablet once daily before morning meal.",
        precaution: "Inform doctor if severe abdominal pain or persistent vomiting occurs.",
      },
      {
        genericName: "Aluminium Hydroxide + Magnesium Hydroxide Gel",
        commonBrandNames: ["Digene Gel", "Gelusil", "Mucaine"],
        category: "Gastrointestinal",
        dosageGuideline: "10 ml (2 teaspoons) 30 minutes after meals and before bedtime.",
        precaution: "Shake well before use. Do not take other oral medicines within 2 hours.",
      },
    ],
    generalAdvice: "Eat small, frequent meals. Avoid spicy, oily, or fried foods and avoid lying down immediately after eating.",
  },
  {
    condition: "Acute Diarrhea & Dehydration",
    severity: "moderate",
    keywords: ["diarrhea", "loose motions", "loose stools", "dehydration", "ors", "stomach upset", "dysentery"],
    medicines: [
      {
        genericName: "Oral Rehydration Salts (ORS IP Formula)",
        commonBrandNames: ["Electral", "Prolyte ORS", "Walyte"],
        category: "Gastrointestinal",
        dosageGuideline: "Dissolve entire 21.8g packet in exactly 1 litre of clean drinking water. Sip continuously throughout the day.",
        precaution: "Discard any unused solution after 24 hours. Do not boil prepared solution.",
      },
      {
        genericName: "Lactic Acid Bacillus / Probiotic Capsules",
        commonBrandNames: ["Darolac", "Econorm", "Sporlac"],
        category: "Gastrointestinal",
        dosageGuideline: "1 capsule twice daily after meals.",
        precaution: "Store in a cool dry place below 25°C.",
      },
      {
        genericName: "Zinc Gluconate 20mg",
        commonBrandNames: ["Zincovit", "Zinconia"],
        category: "Vitamins & Supplements",
        dosageGuideline: "1 tablet once daily for 14 days.",
        precaution: "Take with food to minimize gastric irritation.",
      },
    ],
    generalAdvice: "Maintain hydration with ORS and tender coconut water. Avoid milk products and high-sugar drinks. Seek medical help if blood appears in stools.",
  },
  {
    condition: "Allergic Skin Rash & Itching",
    severity: "mild",
    keywords: ["allergy", "rash", "itching", "hives", "urticaria", "skin irritation", "pruritus"],
    medicines: [
      {
        genericName: "Cetirizine 10mg",
        commonBrandNames: ["Cetzine", "Zyrtec", "Alerid"],
        category: "Dermatology",
        dosageGuideline: "1 tablet once daily at bedtime.",
        precaution: "May cause drowsiness. Drink plenty of water.",
      },
      {
        genericName: "Calamine Lotion",
        commonBrandNames: ["Caladryl", "Lacto Calamine"],
        category: "Dermatology",
        dosageGuideline: "Apply gently to affected area 2-3 times daily.",
        precaution: "For external use only. Avoid contact with eyes or open wounds.",
      },
    ],
    generalAdvice: "Wear loose cotton clothing and avoid hot baths or harsh perfumed soaps.",
  },
  {
    condition: "Muscle Pain, Sprain & Joint Ache",
    severity: "mild",
    keywords: ["muscle pain", "joint pain", "sprain", "back pain", "body ache", "swelling", "knee pain"],
    medicines: [
      {
        genericName: "Aceclofenac 100mg + Paracetamol 325mg",
        commonBrandNames: ["Zerodol-P", "Hifenac-P", "Aceclo-Plus"],
        category: "Analgesics & Antipyretics",
        dosageGuideline: "1 tablet twice daily after meals.",
        precaution: "Take with or after food. Contraindicated in patients with active peptic ulcers.",
      },
      {
        genericName: "Diclofenac Diethylamine Gel 1.16%",
        commonBrandNames: ["Volini Gel", "Omnigel", "Moov"],
        category: "Analgesics & Antipyretics",
        dosageGuideline: "Apply a small quantity to the affected area 3 to 4 times daily with gentle massage.",
        precaution: "Wash hands after application. Do not apply on broken skin or burns.",
      },
    ],
    generalAdvice: "Apply cold ice pack for acute swelling within 24 hours, then switch to warm compression and rest the affected area.",
  },
  {
    condition: "Nausea & Motion Sickness",
    severity: "mild",
    keywords: ["nausea", "vomiting", "motion sickness", "travel sickness", "vomit"],
    medicines: [
      {
        genericName: "Ondansetron 4mg (MD / Dispersible)",
        commonBrandNames: ["Emeset 4", "Ondem 4", "Vomikind 4"],
        category: "Gastrointestinal",
        dosageGuideline: "1 tablet placed on tongue 30 minutes before travel or food.",
        precaution: "May cause mild headache or constipation.",
      },
      {
        genericName: "Domperidone 10mg",
        commonBrandNames: ["Domstal", "Motinorm"],
        category: "Gastrointestinal",
        dosageGuideline: "1 tablet 15-30 minutes before meals.",
        precaution: "Do not exceed prescribed duration without doctor evaluation.",
      },
    ],
    generalAdvice: "Sip small amounts of chilled water or ginger tea. Avoid large greasy meals before travel.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 2. Emergency Symptoms (Triage Rules)
// ─────────────────────────────────────────────────────────────────────────────
const EMERGENCY_SYMPTOMS = [
  "chest pain",
  "heart attack",
  "difficulty breathing",
  "breathlessness",
  "shortness of breath",
  "severe bleeding",
  "unconscious",
  "fainting",
  "coughing blood",
  "vomiting blood",
  "seizure",
  "convulsion",
  "stroke",
  "paralysis",
  "head injury",
  "high fever >104",
];

export const checkEmergencyTriage = (message) => {
  const lower = message.toLowerCase();
  for (const s of EMERGENCY_SYMPTOMS) {
    if (lower.includes(s)) {
      return {
        isEmergency: true,
        matchedSymptom: s,
      };
    }
  }
  return { isEmergency: false };
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. Application Guidance & FAQ Knowledge Base
// ─────────────────────────────────────────────────────────────────────────────
export const APP_GUIDANCE_FAQ = [
  {
    patterns: ["add product", "new product", "create product", "register medicine", "stock item"],
    title: "Add New Product",
    navigateTo: "/inventory",
    message: "To register a new medicine or inventory item:",
    steps: [
      "1. Navigate to the Inventory page from the sidebar (or Dashboard Quick Actions).",
      "2. Click the 'Add Product' button in the top right corner.",
      "3. Enter the Product Name, SKU / Batch number, Category, Price, and Stock Quantity.",
      "4. Provide Expiry Date and Manufacturing Date if applicable.",
      "5. Click 'Save Product' to commit the item to your local SQLite database.",
    ],
  },
  {
    patterns: ["create bill", "new bill", "billing", "checkout", "pos", "sell", "sale invoice"],
    title: "Point of Sale (POS) Billing",
    navigateTo: "/billing",
    message: "To generate a customer bill or process a sale:",
    steps: [
      "1. Open the Billing page (/billing) — the cursor will auto-focus on the search bar.",
      "2. Scan a barcode or type a product name / SKU, then press Enter to add to the cart.",
      "3. Adjust item quantities or enter customer phone number to attach customer records.",
      "4. Apply discounts or taxes if required.",
      "5. Select the payment method (Cash, Card, UPI, etc.) and click 'Complete Sale'.",
      "6. A sequential invoice will be generated and stock is atomically decremented.",
    ],
  },
  {
    patterns: ["low stock", "out of stock", "check stock", "stock alerts", "reorder alert"],
    title: "Stock & Inventory Alerts",
    navigateTo: "/stock",
    message: "To monitor low stock and inventory alerts:",
    steps: [
      "1. Go to the Dashboard (/stock) where real-time attention cards display critical inventory status.",
      "2. The 'Low Stock' attention card counts items below threshold (≤10 units) and out-of-stock items.",
      "3. Click on the attention banner or navigate to '/inventory' and filter by 'Low Stock' or 'Out of Stock'.",
      "4. Create a Purchase Order directly to replenish inventory from suppliers.",
    ],
  },
  {
    patterns: ["purchase order", "po", "order from supplier", "restock", "distributor order"],
    title: "Purchase Orders",
    navigateTo: "/orders",
    message: "To order new stock from a distributor/supplier:",
    steps: [
      "1. Navigate to the Orders page (/orders).",
      "2. Click 'Create Purchase Order'.",
      "3. Select a supplier from your directory, select items to purchase, and enter ordered quantities.",
      "4. Submit the purchase order with 'Pending' status.",
      "5. When the supplier delivers the goods, update the order status to 'Delivered' — inventory is automatically restocked into SQLite!",
    ],
  },
  {
    patterns: ["import", "ai import", "upload invoice", "scan invoice", "csv import", "ocr"],
    title: "AI & Bulk Import",
    navigateTo: "/ai-import",
    message: "To import products in bulk from invoices or files:",
    steps: [
      "1. Go to the AI Import page (/ai-import).",
      "2. For online mode: Upload invoice photos (JPG/PNG), PDF, or record audio notes for automatic extraction.",
      "3. For offline mode: Use the CSV / Excel template import to load large catalogs without internet.",
      "4. Review and adjust extracted columns, batch numbers, and prices in the interactive table.",
      "5. Click 'Import All' to save records to your local database.",
    ],
  },
  {
    patterns: ["add customer", "new customer", "customer history", "customer directory", "customer details", "client record", "customer database"],
    title: "Customer Directory",
    navigateTo: "/customers",
    message: "To view and manage customer records:",
    steps: [
      "1. Go to the Customers page (/customers).",
      "2. Search by customer name or 10-digit mobile number.",
      "3. Click any customer row to view their complete transaction and bill history.",
      "4. Add new customer contacts manually or let the POS link them during checkout.",
    ],
  },
  {
    patterns: ["add supplier", "new supplier", "supplier list", "distributor directory", "vendor list"],
    title: "Suppliers & Vendors",
    navigateTo: "/suppliers",
    message: "To manage your pharmaceutical distributors and suppliers:",
    steps: [
      "1. Go to the Suppliers page (/suppliers).",
      "2. View contact information, pending orders, and delivery history for each supplier.",
      "3. Click 'Add Supplier' to register a new vendor with contact details and address.",
    ],
  },
  {
    patterns: ["report", "analytics report", "export", "download pdf", "download excel", "audit"],
    title: "Analytics & Reports",
    navigateTo: "/audits?tab=reports",
    message: "To export audit reports or inventory summaries:",
    steps: [
      "1. Open the Audits page and switch to the 'Reports' tab (or Quick Actions -> Ai Analytics Report).",
      "2. Select the report type (Stock Summary, Expiry Report, Sales Ledger, Purchase Summary).",
      "3. Select format: PDF, Excel, or CSV.",
      "4. Filter by date range or specific columns as needed.",
      "5. Click 'Generate & Download' to save the report to your machine.",
    ],
  },
  {
    patterns: ["calendar", "activity", "movements", "daily audit"],
    title: "Activity Calendar & Stock Audit",
    navigateTo: "/audits?tab=activity-calendar",
    message: "To track daily stock adjustments and operations:",
    steps: [
      "1. Go to the Calendar / Audits page (/audits?tab=activity-calendar).",
      "2. View stock movements, checkout transactions, and restocking entries mapped across the calendar days.",
      "3. Inspect daily operational audit trails.",
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 4. Intent Classification Engine (Rule-based & Heuristic)
// ─────────────────────────────────────────────────────────────────────────────
export const classifyIntentLocal = (message) => {
  const lower = message.toLowerCase().trim();

  // Emergency or Symptom Query
  const triage = checkEmergencyTriage(lower);
  if (triage.isEmergency) {
    return "emergency_triage";
  }

  // Inventory insights & analytics intent
  if (
    lower.includes("inventory insight") ||
    lower.includes("stock summary") ||
    lower.includes("stock status") ||
    lower.includes("how much stock") ||
    lower.includes("valuation") ||
    lower.includes("expiring medicine") ||
    lower.includes("what is low") ||
    lower.includes("burn rate") ||
    lower.includes("reorder advice")
  ) {
    return "inventory_insights";
  }

  // Symptom Query (Check symptoms before navigation)
  for (const item of OTC_CLINICAL_KNOWLEDGE) {
    for (const kw of item.keywords) {
      if (lower.includes(kw)) {
        return "symptom_query";
      }
    }
  }

  // App Guidance / Navigation
  for (const faq of APP_GUIDANCE_FAQ) {
    for (const pat of faq.patterns) {
      if (lower.includes(pat)) {
        return "app_guidance";
      }
    }
  }

  // General Chat
  if (
    lower.includes("hi") ||
    lower.includes("hello") ||
    lower.includes("hey") ||
    lower.includes("thank") ||
    lower.includes("who are you") ||
    lower.includes("what can you do") ||
    lower.includes("help")
  ) {
    return "general_chat";
  }

  return "general_chat";
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. Cross-reference Clinical Medicines with Local SQLite Inventory
// ─────────────────────────────────────────────────────────────────────────────
export const crossReferenceWithSqlite = (clinicalMeds, orgId) => {
  const allProducts = productRepository.findAll(orgId);
  const now = new Date();

  return clinicalMeds.map((med) => {
    const searchTerms = [
      med.genericName?.toLowerCase(),
      ...(med.commonBrandNames || []).map((b) => b.toLowerCase()),
    ].filter(Boolean);

    let bestMatch = null;
    let bestScore = 0;

    for (const product of allProducts) {
      const productName = product.name.toLowerCase();
      for (const term of searchTerms) {
        if (productName === term) {
          bestMatch = product;
          bestScore = 100;
          break;
        }
        if (productName.includes(term) || term.includes(productName)) {
          const score =
            (Math.min(productName.length, term.length) /
              Math.max(productName.length, term.length)) *
            80;
          if (score > bestScore) {
            bestMatch = product;
            bestScore = score;
          }
        }
        const productWords = productName.split(/\s+/);
        const termWords = term.split(/\s+/);
        const overlap = productWords.filter((w) =>
          termWords.some((tw) => tw.includes(w) || w.includes(tw))
        );
        if (overlap.length > 0) {
          const score =
            (overlap.length / Math.max(productWords.length, termWords.length)) * 60;
          if (score > bestScore) {
            bestMatch = product;
            bestScore = score;
          }
        }
      }
      if (bestScore === 100) break;
    }

    if (bestMatch && bestScore >= 30) {
      const isExpired = bestMatch.expiryDate && new Date(bestMatch.expiryDate) < now;
      return {
        ...med,
        inventory: {
          available: !isExpired && bestMatch.status !== "Out of Stock",
          matchedProduct: bestMatch.name,
          productId: bestMatch._id,
          currentStock: bestMatch.quantity,
          stockStatus: isExpired ? "Expired" : bestMatch.status,
          pricePerUnit: bestMatch.price,
          expiryDate: bestMatch.expiryDate,
        },
      };
    }

    return {
      ...med,
      inventory: {
        available: false,
        matchedProduct: null,
        productId: null,
        currentStock: 0,
        stockStatus: "Not in Inventory",
        pricePerUnit: null,
        expiryDate: null,
      },
    };
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. Find In-Stock Alternatives in Local SQLite
// ─────────────────────────────────────────────────────────────────────────────
export const findSqliteAlternatives = (category, medicineNameToExclude, orgId, limit = 5) => {
  const db = getDatabase();
  const orgInternalId = repositories.organizationRepository.findById(orgId)?.id;
  if (!orgInternalId) return [];

  const now = new Date().toISOString();
  let query = `
    SELECT * FROM products
    WHERE organization_id = ?
      AND status != 'Out of Stock'
      AND (expiry_date IS NULL OR expiry_date > ?)
  `;
  const params = [orgInternalId, now];

  if (category && category !== "General") {
    query += " AND category LIKE ?";
    params.push(`%${category}%`);
  }

  if (medicineNameToExclude) {
    query += " AND LOWER(name) NOT LIKE ?";
    params.push(`%${medicineNameToExclude.toLowerCase()}%`);
  }

  query += ` ORDER BY quantity DESC LIMIT ${limit}`;

  const rows = db.prepare(query).all(...params);
  return rows.map((r) => productRepository.findById(r.id));
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. Local SQLite Inventory Insights & Strategic Forecasting
// ─────────────────────────────────────────────────────────────────────────────
export const getOfflineInventoryInsights = (orgId) => {
  const db = getDatabase();
  const orgInternalId = repositories.organizationRepository.findById(orgId)?.id;
  if (!orgInternalId) {
    return {
      summary: "Organization not found.",
      metrics: null,
    };
  }

  // 1. Product aggregates
  const productStats = db
    .prepare(
      `
    SELECT
      COUNT(*) AS totalProducts,
      COALESCE(SUM(quantity), 0) AS totalUnits,
      COALESCE(SUM(quantity * price), 0) AS totalValuation,
      COUNT(CASE WHEN status = 'Out of Stock' OR quantity = 0 THEN 1 END) AS outOfStockCount,
      COUNT(CASE WHEN quantity > 0 AND quantity <= 10 THEN 1 END) AS lowStockCount,
      COUNT(CASE WHEN expiry_date IS NOT NULL AND expiry_date < datetime('now') THEN 1 END) AS expiredCount,
      COUNT(CASE WHEN expiry_date IS NOT NULL AND expiry_date BETWEEN datetime('now') AND datetime('now', '+30 days') THEN 1 END) AS expiringSoonCount
    FROM products
    WHERE organization_id = ?
  `
    )
    .get(orgInternalId);

  // 2. Critical reorder candidates
  const criticalItems = db
    .prepare(
      `
    SELECT name, sku, category, quantity, price, status
    FROM products
    WHERE organization_id = ? AND (quantity <= 10 OR status = 'Out of Stock')
    ORDER BY quantity ASC
    LIMIT 6
  `
    )
    .all(orgInternalId);

  // 3. Expiring items (within 30 days)
  const expiringItems = db
    .prepare(
      `
    SELECT name, sku, category, quantity, expiry_date
    FROM products
    WHERE organization_id = ? 
      AND expiry_date IS NOT NULL 
      AND expiry_date <= datetime('now', '+30 days')
    ORDER BY expiry_date ASC
    LIMIT 6
  `
    )
    .all(orgInternalId);

  // 4. Top selling items (from sales in last 30 days)
  const topSales = db
    .prepare(
      `
    SELECT 
      p.name AS productName,
      SUM(si.quantity) as unitsSold,
      SUM(si.quantity * si.price) as totalRevenue
    FROM sale_items si
    JOIN sales s ON si.sale_id = s.id
    JOIN products p ON si.product_id = p.id
    WHERE s.organization_id = ?
      AND s.created_at >= datetime('now', '-30 days')
    GROUP BY p.name
    ORDER BY unitsSold DESC
    LIMIT 5
  `
    )
    .all(orgInternalId);

  return {
    mode: "offline",
    provider: "local-sqlite",
    metrics: {
      totalProducts: productStats.totalProducts,
      totalUnits: productStats.totalUnits,
      totalValuation: Math.round(productStats.totalValuation * 100) / 100,
      outOfStockCount: productStats.outOfStockCount,
      lowStockCount: productStats.lowStockCount,
      expiredCount: productStats.expiredCount,
      expiringSoonCount: productStats.expiringSoonCount,
    },
    criticalReorders: criticalItems.map((item) => ({
      name: item.name,
      sku: item.sku,
      category: item.category,
      quantity: item.quantity,
      price: item.price,
      status: item.status,
    })),
    expiringAlerts: expiringItems.map((item) => ({
      name: item.name,
      sku: item.sku,
      category: item.category,
      quantity: item.quantity,
      expiryDate: item.expiry_date,
    })),
    topSellingProducts: topSales,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. Offline Chat Processor (Main Local Execution Path)
// ─────────────────────────────────────────────────────────────────────────────
export const processOfflineChat = async (message, orgId) => {
  const intent = classifyIntentLocal(message);

  // 1. Emergency Triage
  if (intent === "emergency_triage") {
    return {
      mode: "offline",
      provider: "local-rules",
      type: "medicine_suggestion",
      condition: "Critical / Emergency Symptoms Detected",
      severity: "severe",
      doctorConsultRequired: true,
      message:
        "⚠️ URGENT: The symptoms described may indicate a serious medical emergency. Please advise the patient to immediately consult an emergency medical physician or visit the nearest hospital emergency department.",
      medicines: [],
      alternatives: [],
      generalAdvice:
        "Do not dispense OTC medications without immediate professional medical assessment in emergency conditions.",
    };
  }

  // 2. Inventory Insights
  if (intent === "inventory_insights") {
    const insights = getOfflineInventoryInsights(orgId);
    const m = insights.metrics || {};
    let msg = `📊 **Local Inventory Insights & Stock Health**:\n\n`;
    msg += `• Total Catalog: **${m.totalProducts || 0} products** (${m.totalUnits || 0} units in stock)\n`;
    msg += `• Inventory Valuation: **₹${(m.totalValuation || 0).toLocaleString()}**\n`;
    msg += `• Low Stock Items: **${m.lowStockCount || 0}** | Out of Stock: **${m.outOfStockCount || 0}**\n`;
    msg += `• Expiring within 30 days: **${m.expiringSoonCount || 0}** | Expired: **${m.expiredCount || 0}**\n\n`;

    if (insights.criticalReorders && insights.criticalReorders.length > 0) {
      msg += `⚠️ **Critical Items to Reorder:**\n`;
      insights.criticalReorders.forEach((it) => {
        msg += `  - ${it.name} (${it.category || "General"}): only ${it.quantity} left\n`;
      });
    }

    return {
      mode: "offline",
      provider: "local-sqlite",
      type: "general",
      message: msg,
      insightsData: insights,
    };
  }

  // 3. App Guidance & FAQ
  if (intent === "app_guidance") {
    const lower = message.toLowerCase();
    let bestFaq = APP_GUIDANCE_FAQ[0];
    let maxMatch = 0;

    for (const faq of APP_GUIDANCE_FAQ) {
      for (const pat of faq.patterns) {
        if (lower.includes(pat) && pat.length > maxMatch) {
          maxMatch = pat.length;
          bestFaq = faq;
        }
      }
    }

    return {
      mode: "offline",
      provider: "local-rules",
      type: "app_guidance",
      message: `${bestFaq.message}`,
      steps: bestFaq.steps,
      navigateTo: bestFaq.navigateTo,
      pageTitle: bestFaq.title,
    };
  }

  // 4. Alternative Request
  if (intent === "alternative_request") {
    const lower = message.toLowerCase();
    let extractedName = message.replace(/(find|alternative|substitute|for|need|show|me|please)/gi, "").trim();
    if (!extractedName) extractedName = "General";

    // Query matched products
    const matchedProducts = productRepository.search(extractedName, orgId);
    const product = matchedProducts[0] || null;
    const category = product?.category || "General";

    const alts = findSqliteAlternatives(category, extractedName, orgId, 5);

    if (alts.length > 0) {
      return {
        mode: "offline",
        provider: "local-sqlite",
        type: "alternative",
        originalMedicine: extractedName,
        message: `[Offline Local Engine] Available in-stock alternatives for "${extractedName}":`,
        alternatives: alts.map((a) => ({
          productId: a._id,
          name: a.name,
          category: a.category,
          currentStock: a.quantity,
          stockStatus: a.status,
          price: a.price,
          expiryDate: a.expiryDate,
          suitabilityNote: `Matching ${a.category} category with ${a.quantity} units in stock`,
        })),
      };
    }

    return {
      mode: "offline",
      provider: "local-sqlite",
      type: "alternative",
      originalMedicine: extractedName,
      message: `No active in-stock alternatives found for "${extractedName}" in your current local inventory. You can create a Purchase Order to restock.`,
      alternatives: [],
    };
  }

  // 5. Symptom Query
  if (intent === "symptom_query") {
    const lower = message.toLowerCase();
    let matchedCondition = null;
    let highestScore = 0;

    for (const item of OTC_CLINICAL_KNOWLEDGE) {
      let score = 0;
      for (const kw of item.keywords) {
        if (lower.includes(kw)) {
          score += kw.length;
        }
      }
      if (score > highestScore) {
        highestScore = score;
        matchedCondition = item;
      }
    }

    if (!matchedCondition) {
      matchedCondition = OTC_CLINICAL_KNOWLEDGE[0];
    }

    // Cross-reference with shop's SQLite stock
    const medicines = crossReferenceWithSqlite(matchedCondition.medicines, orgId);
    const alternatives = [];

    // For any out of stock, find local alternatives in SQLite
    const outOfStock = medicines.filter(
      (m) => !m.inventory.available && m.inventory.stockStatus !== "Expired"
    );

    for (const med of outOfStock) {
      const alts = findSqliteAlternatives(med.category, null, orgId, 3);
      if (alts.length > 0) {
        alternatives.push({
          forMedicine: med.genericName,
          alternatives: alts.map((a) => ({
            productId: a._id,
            name: a.name,
            category: a.category,
            currentStock: a.quantity,
            stockStatus: a.status,
            price: a.price,
            expiryDate: a.expiryDate,
          })),
        });
      }
    }

    return {
      mode: "offline",
      provider: "local-rules",
      type: "medicine_suggestion",
      condition: matchedCondition.condition,
      severity: matchedCondition.severity,
      doctorConsultRequired: false,
      message: `[Offline Local Mode] Symptoms appear commonly associated with ${matchedCondition.condition}. Here are recommended OTC options cross-referenced with your local inventory:`,
      medicines,
      alternatives,
      generalAdvice: matchedCondition.generalAdvice,
    };
  }

  // 6. General Chat Fallback
  return {
    mode: "offline",
    provider: "local-rules",
    type: "general",
    message:
      "Hello! I'm MedAgent in Local Offline Mode. I can assist you directly from your local SQLite database without requiring an internet connection.\n\nTry asking:\n• \"Headache & fever\" or \"Acidity\" (OTC guidance cross-referenced with stock)\n• \"Need Dolo 650\" (Find in-stock substitutes)\n• \"Stock summary\" (Instant inventory valuation & reorder alerts)\n• \"How to add product?\" (Step-by-step app navigation)",
  };
};

export default {
  OTC_CLINICAL_KNOWLEDGE,
  APP_GUIDANCE_FAQ,
  checkEmergencyTriage,
  classifyIntentLocal,
  crossReferenceWithSqlite,
  findSqliteAlternatives,
  getOfflineInventoryInsights,
  processOfflineChat,
};
