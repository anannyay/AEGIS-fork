/* AEGIS-Care interface effects.
 *
 * Vanilla re-implementations of a few React Bits-style patterns, sized for this
 * console and written so app.js never has to know they exist:
 *
 *   ContainmentField  canvas lineage graph: a seed turns, contamination travels
 *                     along derivation edges, a repair wave rebuilds the
 *                     descendants and a shield closes around them. This is the
 *                     product's own story, used as the hero instead of stock art.
 *   Spotlight         pointer-follow glow on cards (CSS variables only).
 *   CountUp           numbers in the evidence readouts count up once on reveal.
 *   SplitReveal       hero headlines settle in word by word on first paint.
 *   TabIndicator      a sliding underline for the console tabs.
 *
 * Every effect checks reduced motion (system setting or the app's own display
 * preference) and degrades to a static frame.
 */
(() => {
  "use strict";

  const root = document.documentElement;
  const sysReduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const reduced = () => sysReduce.matches || root.dataset.motion === "reduce";
  const css = (name, fallback) =>
    getComputedStyle(root).getPropertyValue(name).trim() || fallback;

  /* ================================================================
   * ContainmentField
   * ================================================================ */
  class ContainmentField {
    constructor(host, opts = {}) {
      this.host = host;
      this.opts = Object.assign({ layers: 5, perLayer: [1, 3, 4, 5, 4], fadeLeft: 0.28, fadeRight: 0.05, period: 11 }, opts);
      this.canvas = document.createElement("canvas");
      this.canvas.className = "fx-field";
      this.canvas.setAttribute("aria-hidden", "true");
      host.appendChild(this.canvas);
      this.ctx = this.canvas.getContext("2d");
      this.t0 = performance.now();
      this.visible = true;
      this.raf = 0;
      this.build();
      this.resize();
      new ResizeObserver(() => this.resize()).observe(host);
      new IntersectionObserver(([e]) => {
        this.visible = e.isIntersecting;
        if (this.visible) this.loop(); else cancelAnimationFrame(this.raf);
      }).observe(host);
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) cancelAnimationFrame(this.raf); else this.loop();
      });
      this.loop();
    }

    /* A layered derivation graph: layer 0 holds the seed, later layers are
     * handovers, summaries and aggregates. Some nodes are true descendants,
     * the rest are clean neighbours that must survive recovery. */
    build() {
      let s = 7;
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const nodes = [];
      const { layers, perLayer } = this.opts;
      for (let l = 0; l < layers; l++) {
        const n = perLayer[l] || 3;
        for (let i = 0; i < n; i++) {
          nodes.push({
            l, i,
            x: (l + 0.5) / layers + (rnd() - 0.5) * 0.06,
            y: n === 1 ? 0.52 : 0.18 + (i / (n - 1)) * 0.66 + (rnd() - 0.5) * 0.07,
            phase: rnd() * Math.PI * 2,
            bad: false,
          });
        }
      }
      const edges = [];
      const byLayer = (l) => nodes.filter((n) => n.l === l);
      for (let l = 1; l < layers; l++) {
        byLayer(l).forEach((child) => {
          const parents = byLayer(l - 1).sort((a, b) => Math.abs(a.y - child.y) - Math.abs(b.y - child.y));
          parents.slice(0, l === 1 ? 1 : 1 + (rnd() > 0.55 ? 1 : 0)).forEach((p) => edges.push({ a: p, b: child }));
        });
      }
      // Contamination: everything reachable from the seed through a subset of edges.
      const seed = nodes[0];
      seed.bad = true;
      seed.at = 0;
      edges.forEach((e) => { e.hot = false; });
      for (let l = 1; l < layers; l++) {
        edges.filter((e) => e.b.l === l && e.a.bad).forEach((e, k) => {
          if (l === 1 || rnd() > 0.35 || k === 0) {
            e.hot = true;
            if (!e.b.bad) { e.b.bad = true; e.b.at = l; }
          }
        });
      }
      this.nodes = nodes;
      this.edges = edges;
      this.seed = seed;
    }

    resize() {
      const r = this.host.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = Math.max(1, r.width);
      this.h = Math.max(1, r.height);
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
      this.canvas.style.width = `${this.w}px`;
      this.canvas.style.height = `${this.h}px`;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reduced()) this.draw(this.opts.period * 0.78);
    }

    loop() {
      cancelAnimationFrame(this.raf);
      if (reduced()) { this.draw(this.opts.period * 0.78); return; }
      const tick = (now) => {
        if (!this.visible || document.hidden) return;
        this.draw(((now - this.t0) / 1000) % this.opts.period);
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }

    /* Timeline (seconds within one period):
     *   0.0-1.0 calm   1.0-4.6 contamination spreads layer by layer
     *   5.0-7.6 repair wave rebuilds descendants   7.6-10.4 shield holds
     *   10.4-11 fade back to calm */
    draw(t) {
      const { ctx, w, h } = this;
      const L = this.opts.layers;
      const pad = { l: w * this.opts.fadeLeft, r: w * this.opts.fadeRight, t: h * 0.08, b: h * 0.12 };
      const X = (n) => pad.l + n.x * (w - pad.l - pad.r);
      const Y = (n, tt) => pad.t + (n.y + Math.sin(tt * 0.6 + n.phase) * 0.008) * (h - pad.t - pad.b);
      const aqua = css("--fx-aqua", "#5fe3d8");
      const coral = css("--fx-coral", "#ff7a6b");
      const mint = css("--fx-mint", "#8ef0b6");
      const dim = css("--fx-dim", "rgba(190,225,220,.22)");

      const spreadStart = 1.0, perHop = 0.9;
      const infected = (n) => n.bad && t >= spreadStart + n.at * perHop && t < 10.6;
      const waveX = t < 5 ? -1 : (t - 5) / 2.6;                 // 0..1 across the field
      const repaired = (n) => n.bad && n !== this.seed && waveX >= n.x;
      const fade = t > 10.4 ? 1 - (t - 10.4) / 0.6 : 1;

      ctx.clearRect(0, 0, w, h);

      // Repair wave: a soft vertical band of light sweeping the graph.
      if (waveX >= 0 && waveX <= 1.15) {
        const wx = pad.l + Math.min(waveX, 1) * (w - pad.l - pad.r);
        const g = ctx.createLinearGradient(wx - 140, 0, wx + 40, 0);
        g.addColorStop(0, "rgba(0,0,0,0)");
        g.addColorStop(0.8, hexA(aqua, 0.10));
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(wx - 140, 0, 180, h);
        ctx.strokeStyle = hexA(aqua, 0.35);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(wx, pad.t * 0.5); ctx.lineTo(wx, h - pad.b * 0.5); ctx.stroke();
      }

      // Edges.
      this.edges.forEach((e) => {
        const ax = X(e.a), ay = Y(e.a, t), bx = X(e.b), by = Y(e.b, t);
        const hot = e.hot && infected(e.b);
        const fixed = e.hot && repaired(e.b);
        ctx.lineWidth = hot ? 1.6 : 1;
        ctx.strokeStyle = fixed ? hexA(mint, 0.55 * fade) : hot ? hexA(coral, 0.7 * fade) : dim;
        ctx.beginPath();
        const mx = (ax + bx) / 2;
        ctx.moveTo(ax, ay);
        ctx.bezierCurveTo(mx, ay, mx, by, bx, by);
        ctx.stroke();

        // Contamination pulse travelling along the edge while the hop is active.
        if (e.hot && !fixed) {
          const start = spreadStart + (e.b.at - 1) * perHop;
          const p = (t - start) / perHop;
          if (p > 0 && p < 1) {
            const pt = bez(ax, ay, mx, ay, mx, by, bx, by, p);
            glow(ctx, pt[0], pt[1], 3.2, coral, 14);
          }
        }
      });

      // Nodes.
      this.nodes.forEach((n) => {
        const x = X(n), y = Y(n, t);
        let color = hexA(aqua, 0.75), r = 4.2, halo = 0;
        if (n === this.seed && infected(n)) {
          color = t > 7.6 ? hexA(coral, 0.35 * fade) : coral; r = 6.2; halo = 18;
        } else if (repaired(n) && t < 10.6) {
          color = mint; r = 5; halo = 12;
        } else if (infected(n)) {
          color = coral; r = 5; halo = 14;
        }
        if (halo) glow(ctx, x, y, r, color, halo);
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();

        // Withdrawn seed is struck through once the shield holds.
        if (n === this.seed && t > 7.6 && t < 10.6) {
          ctx.strokeStyle = hexA(coral, 0.8 * fade);
          ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.moveTo(x - 9, y - 9); ctx.lineTo(x + 9, y + 9); ctx.stroke();
        }
      });

      // Shield: a ring that closes around the repaired set.
      if (t > 7.6 && t < 10.6) {
        const k = Math.min(1, (t - 7.6) / 0.9) * fade;
        const bad = this.nodes.filter((n) => n.bad && n !== this.seed);
        const xs = bad.map(X), ys = bad.map((n) => Y(n, t));
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const rx = (Math.max(...xs) - Math.min(...xs)) / 2 + 46;
        const ry = (Math.max(...ys) - Math.min(...ys)) / 2 + 40;
        ctx.strokeStyle = hexA(mint, 0.5 * k);
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 7]);
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  function bez(x0, y0, x1, y1, x2, y2, x3, y3, p) {
    const u = 1 - p;
    return [
      u * u * u * x0 + 3 * u * u * p * x1 + 3 * u * p * p * x2 + p * p * p * x3,
      u * u * u * y0 + 3 * u * u * p * y1 + 3 * u * p * p * y2 + p * p * p * y3,
    ];
  }
  function glow(ctx, x, y, r, color, blur) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function hexA(color, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(color);
    if (!m) return color;
    const v = parseInt(m[1], 16);
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
  }

  /* ================================================================
   * Spotlight: pointer-follow glow, driven purely by CSS variables.
   * ================================================================ */
  const SPOT = ".role-card, .stage, .proof-ribbon .metric, .patient-row, .outcome-card, .queue-card, .operator-case, .change-card, .accessibility-card";
  function initSpotlight() {
    document.addEventListener("pointermove", (e) => {
      const card = e.target.closest && e.target.closest(SPOT);
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
      card.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
    }, { passive: true });
  }

  /* ================================================================
   * CountUp: numeric readouts count up once when first revealed.
   * ================================================================ */
  const COUNT = "#overview-stats .metric .value, .hero-readout strong, .record-stat strong, .rollup-figure";
  const counted = new WeakMap();
  function countUp(node) {
    const raw = node.textContent.trim();
    if (!/^-?\d+(\.\d+)?$/.test(raw) || counted.get(node) === raw) return;
    counted.set(node, raw);
    const target = parseFloat(raw);
    const decimals = (raw.split(".")[1] || "").length;
    if (reduced() || target === 0) return;
    const start = performance.now();
    const dur = Math.min(1400, 500 + Math.log10(Math.abs(target) + 1) * 300);
    node.classList.add("fx-counting");
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 4);
      const val = (target * eased).toFixed(decimals);
      node.textContent = val;
      counted.set(node, val);
      if (p < 1) requestAnimationFrame(step);
      else { node.textContent = raw; counted.set(node, raw); node.classList.remove("fx-counting"); }
    };
    requestAnimationFrame(step);
  }
  function initCountUp() {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { countUp(e.target); io.unobserve(e.target); } });
    }, { threshold: 0.4 });
    const scan = () => document.querySelectorAll(COUNT).forEach((n) => {
      if (n.classList.contains("fx-counting")) return;
      const raw = n.textContent.trim();
      if (counted.get(n) !== raw) io.observe(n);
    });
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; scan(); });
    }).observe(document.getElementById("main") || document.body, { childList: true, subtree: true, characterData: true });
    scan();
  }

  /* ================================================================
   * SplitReveal: headline words settle in once, on first paint only.
   * ================================================================ */
  function splitReveal(heading) {
    if (!heading || heading.dataset.fxSplit || reduced()) return;
    heading.dataset.fxSplit = "1";
    let i = 0;
    const walk = (node) => {
      [...node.childNodes].forEach((child) => {
        if (child.nodeType === 3) {
          const frag = document.createDocumentFragment();
          child.textContent.split(/(\s+)/).forEach((part) => {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
            const s = document.createElement("span");
            s.className = "fx-word";
            s.style.setProperty("--i", i++);
            s.textContent = part;
            frag.appendChild(s);
          });
          child.replaceWith(frag);
        } else if (child.nodeType === 1 && child.tagName !== "BR") {
          walk(child);
        }
      });
    };
    walk(heading);
    heading.classList.add("fx-split");
  }

  /* ================================================================
   * TabIndicator: one sliding underline under the active console tab.
   * ================================================================ */
  function initTabIndicator() {
    const nav = document.getElementById("tabs");
    if (!nav) return;
    const bar = document.createElement("span");
    bar.className = "fx-tab-bar";
    bar.setAttribute("aria-hidden", "true");
    const place = () => {
      const active = nav.querySelector("button.active");
      if (!active) { bar.style.opacity = "0"; return; }
      if (bar.parentNode !== nav) nav.appendChild(bar);
      bar.style.opacity = "1";
      bar.style.width = `${active.offsetWidth}px`;
      bar.style.transform = `translateX(${active.offsetLeft}px)`;
    };
    new MutationObserver(place).observe(nav, { subtree: true, attributes: true, attributeFilter: ["class"], childList: true });
    window.addEventListener("resize", place);
    place();
  }

  /* ================================================================ */
  function mountFields() {
    const hero = document.querySelector("#overview-hero");
    if (hero && !hero.querySelector(".fx-field")) {
      const host = document.createElement("div");
      host.className = "fx-field-host";
      hero.insertBefore(host, hero.firstChild);
      new ContainmentField(host, { fadeLeft: 0.42 });
      const legend = document.createElement("ul");
      legend.className = "fx-legend";
      legend.setAttribute("aria-label", "Animation legend");
      legend.innerHTML = '<li><i></i>Memory</li><li class="is-bad"><i></i>Contaminated</li>' +
        '<li class="is-fixed"><i></i>Rebuilt</li><li class="is-wall"><i></i>Enforcement boundary</li>';
      hero.appendChild(legend);
    }
    const login = document.querySelector(".login-hero");
    if (login && !login.querySelector(".fx-field")) {
      const host = document.createElement("div");
      host.className = "fx-field-host";
      login.insertBefore(host, login.firstChild);
      new ContainmentField(host, { fadeLeft: 0.56, fadeRight: 0.25, perLayer: [1, 2, 3, 3, 2] });
    }
  }

  function init() {
    root.classList.add("fx-ready");
    mountFields();
    initSpotlight();
    initCountUp();
    initTabIndicator();
    document.querySelectorAll(".hero-copy h2, .login-hero h1").forEach(splitReveal);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
