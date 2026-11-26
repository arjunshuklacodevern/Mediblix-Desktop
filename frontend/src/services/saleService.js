import api from "./api";

const createSale = async (saleData) => {
  const response = await api.post("/sales", saleData);
  return response.data;
};

const getSales = async (params) => {
  const response = await api.get("/sales", { params });
  return response.data;
};

const generateInvoice = async (saleId) => {
  const response = await api.get(`/sales/${saleId}/invoice`, {
    responseType: "blob", // Important for handling PDF files
  });
  return response.data;
};

const processReturn = async (saleId, payload, legacyQty) => {
  let body;
  if (typeof payload === 'object' && payload !== null) {
    body = payload;
  } else {
    body = { itemId: payload, returnQuantity: legacyQty };
  }
  const response = await api.post(`/sales/${saleId}/return`, body);
  return response.data;
};

const modifyInvoice = async (saleId, modifyData) => {
  const response = await api.put(`/sales/${saleId}/modify`, modifyData);
  return response.data;
};

export default {
  createSale,
  getSales,
  generateInvoice,
  processReturn,
  modifyInvoice,
};
