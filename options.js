const $ = (id) => document.getElementById(id);
const select = $("targetDistro");
const status = $("status");
let statusTimer;

for (const d of ROS2_DISTROS.filter((d) => d.docs).reverse()) {
  select.add(new Option(d.name, d.id));
}

function showModeHint(mode) {
  for (const p of document.querySelectorAll("[data-mode]")) p.hidden = p.dataset.mode !== mode;
}

function save(patch) {
  chrome.storage.sync.set(patch, () => {
    status.classList.add("show");
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => status.classList.remove("show"), 1200);
  });
}

chrome.storage.sync.get(DEFAULT_SETTINGS, (s) => {
  select.value = s.targetDistro;
  document.querySelector(`input[name=mode][value=${s.mode}]`).checked = true;
  showModeHint(s.mode);
  $("delaySeconds").value = s.delaySeconds;
  $("verifyExists").checked = s.verifyExists;
  $("redirectFromNewer").checked = s.redirectFromNewer;
});

select.addEventListener("change", () => save({ targetDistro: select.value }));

for (const radio of document.querySelectorAll("input[name=mode]")) {
  radio.addEventListener("change", () => {
    showModeHint(radio.value);
    save({ mode: radio.value });
  });
}

$("delaySeconds").addEventListener("change", (e) => {
  const v = Math.min(60, Math.max(1, Math.round(Number(e.target.value)) || DEFAULT_SETTINGS.delaySeconds));
  e.target.value = v;
  save({ delaySeconds: v });
});

for (const id of ["verifyExists", "redirectFromNewer"]) {
  $(id).addEventListener("change", (e) => save({ [id]: e.target.checked }));
}
