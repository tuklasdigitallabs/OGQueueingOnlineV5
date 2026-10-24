/* Keep the offline display layout wired to online branch routing and recall events. */
(() => {
  const ui = window.DisplayUI;
  if (!ui) return;
  function setGuestQr() {
    const image = document.getElementById("guestQr");
    if (!image || image.dataset.ready === "1") return;
    const query = new URLSearchParams(location.search);
    const parts = location.pathname.split("/").filter(Boolean);
    const index = parts.findIndex(part => part.toLowerCase() === "b");
    const branchCode = String(query.get("branchCode") || (index >= 0 ? parts[index + 1] : "") || "").trim().toUpperCase();
    const url = window.appUrl("/qr/guest");
    image.src = branchCode ? `${url}?branchCode=${encodeURIComponent(branchCode)}` : url;
    image.dataset.ready = "1";
  }
  const render = ui.render;
  ui.render = function (...args) {
    setGuestQr();
    return render.apply(this, args);
  };
  ui.showRecalledCode = (code) => {
    const parts = String(code || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").split("-");
    const letters = document.getElementById("heroLetter");
    const number = document.getElementById("heroNum");
    const card = document.getElementById("calledGlobal");
    if (!letters || !number || !parts[0] || !parts[1]) return;
    letters.textContent = parts[0];
    number.textContent = parts[1];
    card?.classList.toggle("isPriorityCalled", parts[0].startsWith("P"));
  };
  setGuestQr();
})();
