/**
 * Mediblix Desktop — SQLite Repositories Index
 */

const organizationRepository = require('./organizationRepository');
const userRepository = require('./userRepository');
const productRepository = require('./productRepository');
const customerRepository = require('./customerRepository');
const saleRepository = require('./saleRepository');
const supplierRepository = require('./supplierRepository');
const purchaseOrderRepository = require('./purchaseOrderRepository');
const importHistoryRepository = require('./importHistoryRepository');
const { getDatabase, runInTransaction, generateId } = require('./baseRepository');

module.exports = {
  organizationRepository,
  userRepository,
  productRepository,
  customerRepository,
  saleRepository,
  supplierRepository,
  purchaseOrderRepository,
  importHistoryRepository,
  getDatabase,
  runInTransaction,
  generateId
};
