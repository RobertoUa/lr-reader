// Run on languagereactor.com while logged in: reads the site's own Firebase login, asks Language
// Reactor for the account's diocoToken and offers it for LR Reader. Nothing is sent anywhere else.
(async () => {
  if (!/languagereactor\.com$/.test(location.hostname)) {
    alert("Open languagereactor.com, log in, then tap this bookmark there.");
    return void (location.href = "https://www.languagereactor.com/");
  }
  try {
    const req = (q) => new Promise((r, j) => ((q.onsuccess = () => r(q.result)), (q.onerror = () => j(q.error))));
    const db = await req(indexedDB.open("firebaseLocalStorageDb"));
    const rows = await req(db.transaction("firebaseLocalStorage").objectStore("firebaseLocalStorage").getAll());
    const row = rows.find((x) => String(x.fbase_key).startsWith("firebase:authUser:"));
    if (!row) return void alert("Log in to Language Reactor first, then tap the bookmark again.");
    const sts = row.value.stsTokenManager;
    let idToken = sts.accessToken;
    if (sts.expirationTime < Date.now() + 60000) {
      const apiKey = row.fbase_key.split(":")[2];
      const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(sts.refreshToken),
      });
      idToken = (await r.json()).id_token;
    }
    const r = await fetch("https://us-central1-nlle-b0128.cloudfunctions.net/getUserData_3", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + idToken },
      body: '{"data":{}}',
    });
    const d = (await r.json()).result || {};
    if (!d.diocoToken) return void alert(`Language Reactor did not return a token (HTTP ${r.status}).`);
    const text = JSON.stringify({ lrReader: 1, email: d.googleEmail || row.value.email || "", token: d.diocoToken });
    const box = document.createElement("div");
    box.id = "lrr-token";
    box.style.cssText = "position:fixed;z-index:2147483647;left:10px;right:10px;top:10px;padding:16px;background:#fff;color:#000;border:3px solid #f80;border-radius:12px;font:16px -apple-system,sans-serif";
    box.innerHTML = "<b>Language Reactor login for LR Reader</b><div style='margin:8px 0'>Email: <span></span></div><button style='font-size:18px;padding:10px 16px'>Copy for LR Reader</button> <button style='font-size:18px;padding:10px 16px'>Close</button><div style='margin-top:8px;font-size:13px'>Then in LR Reader: Settings, Paste Language Reactor login.</div>";
    box.querySelector("span").textContent = JSON.parse(text).email;
    const [copy, close] = box.querySelectorAll("button");
    copy.onclick = () => navigator.clipboard.writeText(text).then(() => (copy.textContent = "Copied"), () => prompt("Copy this:", text));
    close.onclick = () => box.remove();
    document.body.append(box);
  } catch (e) {
    alert("LR Reader bookmarklet: " + (e && e.message ? e.message : e));
  }
})();
