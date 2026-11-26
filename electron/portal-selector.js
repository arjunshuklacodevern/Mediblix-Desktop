document.getElementById('btn-pharmacy').addEventListener('click', () => {
  window.electronAPI.openPharmacyPortal();
});

document.getElementById('btn-admin').addEventListener('click', () => {
  window.electronAPI.openAdminPortal();
});
