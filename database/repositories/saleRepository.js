/**
 * Mediblix Desktop — Sales & POS SQLite Repository
 *
 * Implements strict ACID transactional integrity:
 *  - Checks inventory stock before sale creation
 *  - Decrements product quantity in the same atomic transaction
 *  - Automatically rolls back if stock is insufficient or a power failure occurs
 *  - Atomically handles returns and restocking
 */

const { getDatabase, runInTransaction, generateId, resolveOrgInternalId } = require('./baseRepository');
const productRepository = require('./productRepository');
const customerRepository = require('./customerRepository');

function mapSaleItem(row) {
  if (!row) return null;
  return {
    _id: row._id,
    id: row.id,
    product: {
      _id: row.product_mongo_id || row.product_id,
      id: row.product_id,
      name: row.product_name,
      price: row.product_price,
      packaging: row.product_packaging || '10 Tablets / Strip',
      tabletsPerStrip: row.product_tablets_per_strip || 10
    },
    quantity: row.quantity,
    price: row.price,
    unit: row.unit || 'Tablet',
    discount: row.discount || 0,
    returnedQuantity: row.returned_quantity || 0,
    createdAt: row.created_at
  };
}

function mapSale(saleRow, itemRows = []) {
  if (!saleRow) return null;
  return {
    _id: saleRow._id,
    id: saleRow.id,
    organization: saleRow.organization_id,
    organizationId: saleRow.organization_id,
    customer: saleRow.customer_id ? customerRepository.findById(saleRow.customer_id) : { name: 'Cash Customer', mobile: 'N/A' },
    customerId: saleRow.customer_id,
    totalAmount: saleRow.total_amount,
    paymentMethod: saleRow.payment_method,
    invoiceNumber: saleRow.invoice_number,
    items: itemRows.map(mapSaleItem),
    createdAt: saleRow.created_at,
    updatedAt: saleRow.updated_at
  };
}

const saleRepository = {
  findAll(query = {}) {
    const db = getDatabase();
    const orgInternalId = resolveOrgInternalId(query.organization || query.organizationId);
    let salesQuery = 'SELECT * FROM sales';
    const params = [];
    const conditions = [];

    if (orgInternalId) {
      conditions.push('organization_id = ?');
      params.push(orgInternalId);
    }

    if (query.customer) {
      conditions.push('(customer_id = ? OR customer_id = (SELECT id FROM customers WHERE _id = ?))');
      params.push(String(query.customer), String(query.customer));
    }

    if (conditions.length > 0) {
      salesQuery += ' WHERE ' + conditions.join(' AND ');
    }

    salesQuery += ' ORDER BY created_at DESC';

    const saleRows = db.prepare(salesQuery).all(...params);
    return saleRows.map(sRow => {
      const itemRows = db.prepare(`
        SELECT si.*, p._id as product_mongo_id, p.name as product_name, p.price as product_price,
               p.packaging as product_packaging, p.tablets_per_strip as product_tablets_per_strip
        FROM sale_items si
        JOIN products p ON si.product_id = p.id
        WHERE si.sale_id = ?
      `).all(sRow.id);
      return mapSale(sRow, itemRows);
    });
  },

  findById(idOrIdStr, orgId) {
    if (!idOrIdStr) return null;
    const db = getDatabase();
    const orgInternalId = resolveOrgInternalId(orgId);
    let sRow;
    if (orgInternalId) {
      sRow = db.prepare('SELECT * FROM sales WHERE (_id = ? OR id = ?) AND organization_id = ?').get(String(idOrIdStr), String(idOrIdStr), orgInternalId);
    } else {
      sRow = db.prepare('SELECT * FROM sales WHERE _id = ? OR id = ?').get(String(idOrIdStr), String(idOrIdStr));
    }

    if (!sRow) return null;

    const itemRows = db.prepare(`
      SELECT si.*, p._id as product_mongo_id, p.name as product_name, p.price as product_price,
             p.packaging as product_packaging, p.tablets_per_strip as product_tablets_per_strip
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      WHERE si.sale_id = ?
    `).all(sRow.id);

    return mapSale(sRow, itemRows);
  },

  /**
   * Executes atomic sale creation with guaranteed inventory decrement
   */
  createSale({ orgId, customerId, items, paymentMethod, invoiceNumber }) {
    return runInTransaction(() => {
      const db = getDatabase();
      const orgInternalId = resolveOrgInternalId(orgId);

      let custInternalId = null;
      if (customerId) {
        const cust = customerRepository.findById(customerId, orgInternalId);
        if (!cust) {
          const err = new Error(`Customer not found: ${customerId}`);
          err.statusCode = 404;
          throw err;
        }
        custInternalId = cust.id;
      }

      // 1. Generate Invoice Number if not provided
      let finalInvoice = invoiceNumber;
      if (!finalInvoice || !String(finalInvoice).trim()) {
        const lastSale = db.prepare(`
          SELECT invoice_number FROM sales WHERE organization_id = ? ORDER BY id DESC LIMIT 1
        `).get(orgInternalId);
        let nextNum = 1;
        if (lastSale && lastSale.invoice_number) {
          const match = lastSale.invoice_number.match(/Inv-(\d+)/i);
          if (match) nextNum = parseInt(match[1], 10) + 1;
        }
        finalInvoice = `Inv-${String(nextNum).padStart(4, '0')}`;
        while (db.prepare('SELECT id FROM sales WHERE invoice_number = ? AND organization_id = ?').get(finalInvoice, orgInternalId)) {
          nextNum++;
          finalInvoice = `Inv-${String(nextNum).padStart(4, '0')}`;
        }
      } else {
        finalInvoice = String(finalInvoice).trim();
        const exists = db.prepare('SELECT id FROM sales WHERE invoice_number = ? AND organization_id = ?').get(finalInvoice, orgInternalId);
        if (exists) {
          const err = new Error('Invoice number already exists');
          err.statusCode = 400;
          throw err;
        }
      }

      // 2. Validate all items and stock
      let calculatedTotal = 0;
      const validatedItems = [];

      for (const item of items) {
        const prod = productRepository.findById(item.product, orgInternalId);
        if (!prod) {
          const err = new Error(`Product not found: ${item.product}`);
          err.statusCode = 404;
          throw err;
        }

        const qty = Number(item.quantity);
        if (qty <= 0) {
          const err = new Error(`Invalid quantity for ${prod.name}`);
          err.statusCode = 400;
          throw err;
        }

        if (prod.quantity < qty) {
          const err = new Error(`Insufficient stock for ${prod.name}. Available: ${prod.quantity}, requested: ${qty}`);
          err.statusCode = 400;
          throw err;
        }

        const unitPrice = item.price !== undefined ? Number(item.price) : prod.price;
        const discount = Number(item.discount) || 0;
        const lineTotal = unitPrice * qty * (1 - discount / 100);

        validatedItems.push({
          productId: prod.id,
          quantity: qty,
          price: unitPrice,
          unit: item.unit || 'Tablet',
          discount,
          lineTotal
        });

        calculatedTotal += lineTotal;
      }

      // 3. Insert Sale Header
      const sale_id = generateId();
      const now = new Date().toISOString();
      const saleRes = db.prepare(`
        INSERT INTO sales (
          _id, organization_id, customer_id, total_amount, payment_method, invoice_number, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sale_id,
        orgInternalId,
        custInternalId,
        calculatedTotal,
        paymentMethod || 'Cash',
        finalInvoice,
        now,
        now
      );

      const insertedSaleId = saleRes.lastInsertRowid;

      // 4. Insert Items & Decrement Stock atomically
      const insertItemStmt = db.prepare(`
        INSERT INTO sale_items (
          _id, sale_id, product_id, quantity, price, unit, discount, returned_quantity, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
      `);

      for (const vi of validatedItems) {
        insertItemStmt.run(generateId(), insertedSaleId, vi.productId, vi.quantity, vi.price, vi.unit, vi.discount, now);
        const decremented = productRepository.decrementStock(vi.productId, vi.quantity);
        if (!decremented) {
          throw new Error('Stock decrement conflict occurred mid-transaction. Rollback triggered.');
        }
      }

      // 5. Update customer total purchases if customer exists
      if (custInternalId) {
        db.prepare('UPDATE customers SET total_purchases = total_purchases + ? WHERE id = ?').run(calculatedTotal, custInternalId);
      }

      return this.findById(insertedSaleId, orgInternalId);
    });
  },

  /**
   * Processes item return and atomically restocks inventory
   */
  processReturn({ saleId, itemId, returnQuantity, orgId }) {
    return runInTransaction(() => {
      const db = getDatabase();
      const orgInternalId = resolveOrgInternalId(orgId);
      const sale = this.findById(saleId, orgInternalId);
      if (!sale) {
        const err = new Error('Sale not found');
        err.statusCode = 404;
        throw err;
      }

      const item = sale.items.find(i => String(i._id) === String(itemId) || String(i.id) === String(itemId));
      if (!item) {
        const err = new Error('Item not found in this sale');
        err.statusCode = 404;
        throw err;
      }

      const returnQty = Number(returnQuantity);
      const maxReturnable = item.quantity - (item.returnedQuantity || 0);
      if (returnQty <= 0 || returnQty > maxReturnable) {
        const err = new Error(`Invalid return quantity. Max returnable: ${maxReturnable} tablets.`);
        err.statusCode = 400;
        throw err;
      }

      // 1. Update returned quantity on item
      db.prepare(`
        UPDATE sale_items
        SET returned_quantity = returned_quantity + ?
        WHERE _id = ? OR id = ?
      `).run(returnQty, String(itemId), String(itemId));

      // 2. Atomically increment stock back into inventory
      productRepository.incrementStock(item.product.id, returnQty);

      // 3. Adjust customer total purchases if customer attached
      if (sale.customerId) {
        const itemEffectivePrice = item.price * (1 - (item.discount || 0) / 100);
        const refundValue = returnQty * itemEffectivePrice;
        db.prepare(`
          UPDATE customers
          SET total_purchases = MAX(0, total_purchases - ?)
          WHERE id = ?
        `).run(refundValue, sale.customerId);
      }

      return this.findById(saleId, orgInternalId);
    });
  }
};

module.exports = saleRepository;
