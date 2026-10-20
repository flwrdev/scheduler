// Delivery fee checker — one input, debounced lookup, inline result.
//
// Talks to /apps/schedule-rules/coverage (App Proxy, same origin as the
// storefront, so Shopify signs the request for us — no key in the theme).
// The fee math itself lives server-side in delivery-coverage.server.ts, the
// same lookup FlowerBot uses.
(function () {
  "use strict";

  var ENDPOINT = "/apps/schedule-rules/coverage";
  var DEBOUNCE_MS = 400;
  var MIN_CHARS = 3;

  function peso(amount) {
    return "\u20B1" + Number(amount).toLocaleString("en-PH");
  }

  function render(root, html) {
    var target = root.querySelector("[data-fc-fee-result]");
    if (target) target.innerHTML = html;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }

  function renderResult(root, data) {
    if (!data || data.ok !== true) {
      render(root, '<p class="fc-fee-checker__msg">' + escapeHtml((data && data.error) || "Pakisubukan ulit.") + "</p>");
      return;
    }

    if (data.covered !== true) {
      render(
        root,
        '<p class="fc-fee-checker__msg fc-fee-checker__msg--miss">' +
          escapeHtml(data.note || "Wala pa po kami sa area na iyan.") +
          " Message us — baka may maisip kaming paraan. \uD83C\uDF38</p>",
      );
      return;
    }

    var disclaimer = root.getAttribute("data-disclaimer") || "";
    var rows = data.areas
      .map(function (area) {
        // "mula sa" (starting at), never a bare number: the courier adds
        // surge for rush hour / bad weather / peak season, which this
        // estimate has no way to model. A bare peso figure would read as a
        // promise the checkout cannot keep.
        var fee = area.feePhp == null ? "Message us" : "mula sa " + peso(area.feePhp);
        return (
          '<li class="fc-fee-checker__row">' +
          '<span class="fc-fee-checker__place">' +
          escapeHtml(area.label) +
          "</span>" +
          '<span class="fc-fee-checker__fee">' +
          fee +
          "</span>" +
          "</li>"
        );
      })
      .join("");

    var html = '<ul class="fc-fee-checker__list">' + rows + "</ul>";

    if (data.provincialNote) {
      html += '<p class="fc-fee-checker__note">' + escapeHtml(data.provincialNote) + "</p>";
    }
    if (data.freeShippingAbovePhp) {
      html +=
        '<p class="fc-fee-checker__free">FREE delivery on orders ' +
        peso(data.freeShippingAbovePhp) +
        " and up. \uD83C\uDF89</p>";
    }
    if (disclaimer) {
      html += '<p class="fc-fee-checker__disclaimer">' + escapeHtml(disclaimer) + "</p>";
    }

    render(root, html);
  }

  function setBusy(root, busy) {
    var spinner = root.querySelector("[data-fc-fee-spinner]");
    if (spinner) spinner.hidden = !busy;
  }

  function init(root) {
    if (root.dataset.fcFeeReady === "1") return;
    root.dataset.fcFeeReady = "1";

    var accent = root.getAttribute("data-accent");
    if (accent) root.style.setProperty("--fc-fee-accent", accent);

    var input = root.querySelector("[data-fc-fee-input]");
    if (!input) return;

    var timer = null;
    // Monotonic token: a slow early response must never overwrite the result
    // of a later keystroke.
    var latest = 0;

    function lookup() {
      var query = input.value.trim();
      if (query.length < MIN_CHARS) {
        render(root, "");
        return;
      }

      var token = ++latest;
      setBusy(root, true);

      fetch(ENDPOINT + "?q=" + encodeURIComponent(query), {
        headers: { Accept: "application/json" },
      })
        .then(function (response) {
          return response.json();
        })
        .then(function (data) {
          if (token !== latest) return;
          setBusy(root, false);
          renderResult(root, data);
        })
        .catch(function () {
          if (token !== latest) return;
          setBusy(root, false);
          render(
            root,
            '<p class="fc-fee-checker__msg">Hindi ma-check ngayon. Pakisubukan ulit maya-maya.</p>',
          );
        });
    }

    input.addEventListener("input", function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(lookup, DEBOUNCE_MS);
    });

    input.addEventListener("keydown", function (event) {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (timer) clearTimeout(timer);
      lookup();
    });
  }

  function boot() {
    document.querySelectorAll("[data-fc-fee-checker]").forEach(init);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // Theme editor re-renders sections without a page load.
  document.addEventListener("shopify:section:load", boot);
})();
