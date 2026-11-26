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

function mapSale(saleRow, itemRows = [], db = null) {
  if (!saleRow) return null;
  const database = db || getDatabase();
  
  // Calculate total refunded amount from sale_items or sale_returns
  let totalRefunded = 0;
  let returnsList = [];
  let revisionsList = [];

  try {
    const returnRows = database.prepare(`
      SELECT * FROM sale_returns WHERE sale_id = ? ORDER BY created_at DESC
    `).all(saleRow.id);
    returnsList = returnRows.map(r => ({
      _id: r._id,
      id: r.id,
      totalRefundAmount: r.total_refund_amount,
      refundMethod: r.refund_method,
      reason: r.reason,
      createdAt: r.created_at
    }));
    totalRefunded = returnRows.reduce((sum, r) => sum + (Number(r.total_refund_amount) || 0), 0);
  } catch (_) {}

  // Fallback if returns table not yet populated or older records
  if (totalRefunded === 0 && itemRows.length > 0) {
    totalRefunded = itemRows.reduce((sum, row) => {
      const retQty = row.returned_quantity || 0;
      const effPrice = (row.price || 0) * (1 - (row.discount || 0) / 100);
      return sum + (retQty * effPrice);
    }, 0);
  }

  try {
    const revRows = database.prepare(`
      SELECT * FROM sale_revisions WHERE sale_id = ? ORDER BY created_at DESC
    `).all(saleRow.id);
    revisionsList = revRows.map(rev => ({
      _id: rev._id,
      id: rev.id,
      previousTotal: rev.previous_total,
      newTotal: rev.new_total,
      previousPaymentMethod: rev.previous_payment_method,
      newPaymentMethod: rev.new_payment_method,
      reason: rev.reason,
      itemsDiff: rev.items_diff_json ? JSON.parse(rev.items_diff_json) : null,
      createdAt: rev.created_at
    }));
  } catch (_) {}

  return {
    _id: saleRow._id,
    id: saleRow.id,
    organization: saleRow.organization_id,
    organizationId: saleRow.organization_id,
    customer: saleRow.customer_id ? customerRepository.findById(saleRow.customer_id) : { name: 'Cash Customer', mobile: 'N/A' },
    customerId: saleRow.customer_id,
    totalAmount: saleRow.total_amount,
    refundAmount: totalRefunded,
    netAmount: Math.max(0, saleRow.total_amount - totalRefunded),
    paymentMethod: saleRow.payment_method,
    invoiceNumber: saleRow.invoice_number,
    items: itemRows.map(mapSaleItem),
    returns: returnsList,
    revisions: revisionsList,
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
   * Supports both single-item return (legacy/simple) and multi-item return bill
   */
  processReturn({ saleId, itemId, returnQuantity, items, refundMethod, reason, orgId }) {
    return runInTransaction(() => {
      const db = getDatabase();
      const orgInternalId = resolveOrgInternalId(orgId);
      const sale = this.findById(saleId, orgInternalId);
      if (!sale) {
        const err = new Error('Sale not found');
        err.statusCode = 404;
        throw err;
      }

      // Normalise return operations list
      let returnOps = [];
      if (Array.isArray(items) && items.length > 0) {
        returnOps = items;
      } else if (itemId && returnQuantity !== undefined) {
        returnOps = [{ itemId, returnQuantity }];
      } else {
        const err = new Error('No items specified for return');
        err.statusCode = 400;
        throw err;
      }

      let totalRefund = 0;
      const validatedReturnItems = [];

      for (const op of returnOps) {
        const lineItem = sale.items.find(
          i => String(i._id) === String(op.itemId) || String(i.id) === String(op.itemId)
        );
        if (!lineItem) {
          const err = new Error(`Item ${op.itemId} not found in this sale`);
          err.statusCode = 404;
          throw err;
        }

        const qty = Number(op.returnQuantity);
        if (isNaN(qty) || qty <= 0 || !Number.isInteger(qty)) {
          const err = new Error(`Return quantity must be a positive whole number for ${lineItem.product?.name || 'item'}`);
          err.statusCode = 400;
          throw err;
        }

        const maxReturnable = lineItem.quantity - (lineItem.returnedQuantity || 0);
        if (qty > maxReturnable) {
          const err = new Error(
            `Cannot return ${qty} tablets of ${lineItem.product?.name || 'item'}. Maximum remaining returnable: ${maxReturnable}`
          );
          err.statusCode = 400;
          throw err;
        }

        const effPrice = lineItem.price * (1 - (lineItem.discount || 0) / 100);
        const itemRefund = qty * effPrice;
        totalRefund += itemRefund;

        validatedReturnItems.push({
          lineItem,
          qty,
          unitPrice: lineItem.price,
          discount: lineItem.discount || 0,
          refundAmount: itemRefund
        });
      }

      const now = new Date().toISOString();
      const returnRecordId = generateId();

      // 1. Insert into sale_returns audit table
      const retInsert = db.prepare(`
        INSERT INTO sale_returns (
          _id, sale_id, organization_id, customer_id, total_refund_amount, refund_method, reason, sync_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        returnRecordId,
        sale.id,
        orgInternalId,
        sale.customerId || null,
        totalRefund,
        refundMethod || sale.paymentMethod || 'Cash',
        reason || 'Customer return',
        now
      );

      const saleReturnRowId = retInsert.lastInsertRowid;

      // 2. Insert line items into sale_return_items and update sale_items & stock
      const insertReturnItem = db.prepare(`
        INSERT INTO sale_return_items (
          _id, sale_return_id, sale_item_id, product_id, quantity, unit_price, discount, refund_amount, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const updateSaleItem = db.prepare(`
        UPDATE sale_items
        SET returned_quantity = returned_quantity + ?
        WHERE id = ?
      `);

      for (const v of validatedReturnItems) {
        insertReturnItem.run(
          generateId(),
          saleReturnRowId,
          v.lineItem.id,
          v.lineItem.product.id,
          v.qty,
          v.unitPrice,
          v.discount,
          v.refundAmount,
          now
        );

        updateSaleItem.run(v.qty, v.lineItem.id);

        // Atomically increment inventory stock
        productRepository.incrementStock(v.lineItem.product.id, v.qty);
      }

      // 3. Mark sale as pending sync
      db.prepare(`
        UPDATE sales
        SET sync_status = 'pending', updated_at = datetime('now')
        WHERE id = ?
      `).run(sale.id);

      // 4. Adjust customer total purchases if customer attached
      if (sale.customerId && totalRefund > 0) {
        db.prepare(`
          UPDATE customers
          SET total_purchases = MAX(0, total_purchases - ?), updated_at = datetime('now')
          WHERE id = ?
        `).run(totalRefund, sale.customerId);
      }

      return this.findById(saleId, orgInternalId);
    });
  },

  /**
   * Modifies an existing invoice with full financial audit log & inventory reconciliation
   */
  modifyInvoice({ saleId, paymentMethod, items, reason, orgId }) {
    return runInTransaction(() => {
      const db = getDatabase();
      const orgInternalId = resolveOrgInternalId(orgId);
      const sale = this.findById(saleId, orgInternalId);
      if (!sale) {
        const err = new Error('Sale not found');
        err.statusCode = 404;
        throw err;
      }

      if (!Array.isArray(items) || items.length === 0) {
        const err = new Error('Invoice must contain at least one item');
        err.statusCode = 400;
        throw err;
      }

      // 1. Validate updated items and compute diffs
      let newCalculatedTotal = 0;
      const validatedNewItems = [];
      const itemDiffs = [];

      for (const item of items) {
        const lineItem = sale.items.find(
          i => String(i._id) === String(item.itemId) || String(i.id) === String(item.itemId)
        );

        if (!lineItem) {
          const err = new Error(`Item ${item.itemId} is not part of this invoice. Cannot add arbitrary items.`);
          err.statusCode = 400;
          throw err;
        }

        const newQty = Number(item.quantity);
        if (isNaN(newQty) || newQty <= 0 || !Number.isInteger(newQty)) {
          const err = new Error(`Quantity must be a positive integer for ${lineItem.product?.name}`);
          err.statusCode = 400;
          throw err;
        }

        // Must not reduce quantity below already returned quantity
        const alreadyReturned = lineItem.returnedQuantity || 0;
        if (newQty < alreadyReturned) {
          const err = new Error(
            `Quantity for ${lineItem.product?.name} cannot be less than already returned quantity (${alreadyReturned})`
          );
          err.statusCode = 400;
          throw err;
        }

        const newPrice = item.price !== undefined ? Number(item.price) : lineItem.price;
        if (isNaN(newPrice) || newPrice < 0) {
          const err = new Error(`Invalid price for ${lineItem.product?.name}`);
          err.statusCode = 400;
          throw err;
        }

        const newDiscount = item.discount !== undefined ? Number(item.discount) : lineItem.discount;
        if (isNaN(newDiscount) || newDiscount < 0 || newDiscount > 100) {
          const err = new Error(`Discount must be between 0% and 100% for ${lineItem.product?.name}`);
          err.statusCode = 400;
          throw err;
        }

        // Inventory delta: if quantity increased, check stock and decrement; if decreased, increment stock
        const deltaQty = newQty - lineItem.quantity;
        if (deltaQty > 0) {
          const currentProd = productRepository.findById(lineItem.product.id, orgInternalId);
          if (!currentProd || currentProd.quantity < deltaQty) {
            const available = currentProd ? currentProd.quantity : 0;
            const err = new Error(
              `Insufficient stock to increase quantity of ${lineItem.product?.name}. Available: ${available}, needed: ${deltaQty}`
            );
            err.statusCode = 400;
            throw err;
          }
        }

        const lineTotal = newPrice * newQty * (1 - newDiscount / 100);
        newCalculatedTotal += lineTotal;

        validatedNewItems.push({
          lineItem,
          newQty,
          newPrice,
          newDiscount,
          deltaQty,
          lineTotal
        });

        itemDiffs.push({
          productId: lineItem.product.id,
          productName: lineItem.product.name,
          oldQty: lineItem.quantity,
          newQty,
          oldPrice: lineItem.price,
          newPrice,
          oldDiscount: lineItem.discount,
          newDiscount
        });
      }

      const now = new Date().toISOString();
      const previousTotal = sale.totalAmount;
      const previousPayment = sale.paymentMethod;
      const newPayment = paymentMethod || previousPayment;

      // 2. Record revision in sale_revisions table
      db.prepare(`
        INSERT INTO sale_revisions (
          _id, sale_id, organization_id, previous_total, new_total, previous_payment_method, new_payment_method, reason, items_diff_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        generateId(),
        sale.id,
        orgInternalId,
        previousTotal,
        newCalculatedTotal,
        previousPayment,
        newPayment,
        reason || 'Administrative correction',
        JSON.stringify(itemDiffs),
        now
      );

      // 3. Update line items and adjust inventory stock
      const updateLineStmt = db.prepare(`
        UPDATE sale_items
        SET quantity = ?, price = ?, discount = ?
        WHERE id = ?
      `);

      for (const vi of validatedNewItems) {
        updateLineStmt.run(vi.newQty, vi.newPrice, vi.newDiscount, vi.lineItem.id);

        if (vi.deltaQty > 0) {
          productRepository.decrementStock(vi.lineItem.product.id, vi.deltaQty);
        } else if (vi.deltaQty < 0) {
          productRepository.incrementStock(vi.lineItem.product.id, Math.abs(vi.deltaQty));
        }
      }

      // 4. Update sales header
      db.prepare(`
        UPDATE sales
        SET total_amount = ?, payment_method = ?, sync_status = 'pending', updated_at = ?
        WHERE id = ?
      `).run(newCalculatedTotal, newPayment, now, sale.id);

      // 5. Update customer total purchases delta
      if (sale.customerId) {
        const netDifference = newCalculatedTotal - previousTotal;
        db.prepare(`
          UPDATE customers
          SET total_purchases = MAX(0, total_purchases + ?), updated_at = ?
          WHERE id = ?
        `).run(netDifference, now, sale.customerId);
      }

      return this.findById(saleId, orgInternalId);
    });
  }
};

module.exports = saleRepository;
