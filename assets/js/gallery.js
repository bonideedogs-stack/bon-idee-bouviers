// Bon Idee JSONP gallery loader
// Usage: loadDriveGallery({ key: 'bouviers', targetId: 'bouvierGallery', scriptUrl: 'YOUR_WEB_APP_URL' })

(function () {
  let cbCounter = 0;

  window.loadDriveGallery = function ({ key, targetId, scriptUrl, limit = 60 }) {
    const target = document.getElementById(targetId);
    if (!target) return;

    target.innerHTML = `<div class="gallery-loading">Loading photos…</div>`;

    const cbName = `__bonIdeeGalleryCB_${Date.now()}_${cbCounter++}`;
    window[cbName] = function (data) {
      try {
        if (!data || !data.ok) {
          target.innerHTML = `<div class="gallery-error">Gallery unavailable.</div>`;
          return;
        }
        renderGallery(target, data.items || []);
      } finally {
        delete window[cbName];
        script.remove();
      }
    };

    const url = new URL(scriptUrl);
    url.searchParams.set("key", key);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("callback", cbName);

    const script = document.createElement("script");
    script.src = url.toString();
    script.async = true;
    script.onerror = () => {
      target.innerHTML = `<div class="gallery-error">Failed to load photos.</div>`;
      delete window[cbName];
      script.remove();
    };

    document.body.appendChild(script);
  };

  function renderGallery(target, items) {
    if (!items.length) {
      target.innerHTML = `<div class="gallery-empty">No photos yet.</div>`;
      return;
    }

    // Newest-first is already handled server-side by createdDate desc.
    target.innerHTML = `
      <div class="gallery-grid">
        ${items.map(item => {
          const img = item.thumb || "";
          const href = item.view || "#";
          const alt = escapeHtml(item.name || "Bon Idee photo");
          return `
            <a class="gallery-item" href="${href}" target="_blank" rel="noopener">
              <img loading="lazy" src="${img}" alt="${alt}">
            </a>
          `;
        }).join("")}
      </div>
    `;
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();
