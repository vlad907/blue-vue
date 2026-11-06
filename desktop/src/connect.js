const $ = (id) => document.getElementById(id);
const host = (url) => url.replace(/^https?:\/\//, "");

function showError(message) {
  $("error").textContent = message ?? "";
  $("error").hidden = !message;
}

async function connect(address, button) {
  showError();
  const label = button?.innerHTML;
  if (button) {
    button.disabled = true;
    if (button.id === "go") button.textContent = "Connecting…";
  }
  try {
    await window.bluevue.connect(address);
  } catch (err) {
    showError(err.message);
    if (button) {
      button.disabled = false;
      button.innerHTML = label;
    }
  }
}

/** One clickable server row. */
function row(server, { forget } = {}) {
  const b = document.createElement("button");
  b.className = "server";
  b.innerHTML = `<span class="grow"><div class="name"></div><div class="meta"></div></span>`;
  b.querySelector(".name").textContent = server.name || host(server.url);
  b.querySelector(".meta").textContent = `${host(server.url)}${server.version ? ` · v${server.version}` : ""}`;
  b.addEventListener("click", () => connect(server.url, b));
  if (forget) {
    const x = document.createElement("span");
    x.className = "x";
    x.title = "Forget this server";
    x.textContent = "✕";
    x.addEventListener("click", async (e) => {
      e.stopPropagation();
      renderRecent(await window.bluevue.forget(server.url));
    });
    b.append(x);
  }
  return b;
}

function renderRecent(servers) {
  $("recent").replaceChildren(...servers.map((s) => row(s, { forget: true })));
  $("recent-section").hidden = !servers.length;
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  connect($("address").value, $("go"));
});

$("scan").addEventListener("click", async () => {
  $("scan").disabled = true;
  $("scan-status").textContent = "Looking…";
  $("found").replaceChildren();
  try {
    const { found, networks } = await window.bluevue.scan();
    $("found").replaceChildren(...found.map((s) => row(s)));
    $("scan-status").textContent = !networks.length
      ? "This Mac isn't on a local network."
      : found.length
        ? `Searched ${networks.join(", ")}.`
        : `No Blue Vue server answered on ${networks.join(", ")}. Check the server is running and port 8080 is open in its firewall, or type its address above.`;
  } catch (err) {
    $("scan-status").textContent = err.message;
  } finally {
    $("scan").disabled = false;
  }
});

showError(new URLSearchParams(location.search).get("error"));
window.bluevue.servers().then(renderRecent);
