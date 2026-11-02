"use strict";
window.FeatheralTraffic = {
  async load(container, endpoint, hostname, header) {
    return this.loadSites([{ container, hostname }], endpoint, header);
  },
  control(header) {
    const previous = header?.querySelector(".traffic-timeframe")?.value || "hourly";
    const select = document.createElement("select");
    select.className = "traffic-timeframe";
    select.setAttribute("aria-label", "Chart interval for all charts");
    for (const [value, text] of [["minutely", "Minute · 60 minutes"], ["hourly", "Hourly · 24 hours"], ["daily", "Daily · 30 days"]]) {
      const option = document.createElement("option"); option.value = value; option.textContent = text; select.append(option);
    }
    select.value = previous;
    if (header) header.replaceChildren(select);
    return select;
  },
  async loadSites(targets, endpoint, header) {
    for (const { container } of targets) container.textContent = "Loading traffic…";
    try {
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error(`Traffic HTTP ${response.status}`);
      const report = await response.json();
      const control = this.control(header);
      for (const { container, hostname, aggregate } of targets) {
        if (aggregate) { container.replaceChildren(); container.append(this.panel(report, null, control)); }
        else this.render(container, report, hostname, control);
      }
    } catch (error) {
      for (const { container } of targets) container.textContent = error.message;
      console.error(error);
    }
  },
  render(container, report, hostname, control) {
    container.replaceChildren();
    if (!control) { control = this.control(); container.append(control); }
    if (!hostname) {
      container.append(this.panel(report, null, control));
      const grid = document.createElement("div");
      grid.className = "traffic-grid";
      for (const site of report.sites) grid.append(this.panel(report, site, control));
      container.append(grid);
    } else {
      for (const site of report.sites.filter(site => site.hostname === hostname)) container.append(this.panel(report, site, control));
    }
  },
  totals(sites, period) {
    const buckets = new Map();
    for (const site of sites) for (const row of site[period]) buckets.set(row.at, (buckets.get(row.at) || 0) + row.views);
    return [...buckets].sort((a, b) => a[0] - b[0]).map(([at, views]) => ({ at, views }));
  },
  panel(report, site, select) {
    const periods = ["minutely", "hourly", "daily"];
    const aggregate = !site;
    const max = aggregate
      ? Math.max(1, ...periods.flatMap(period => this.totals(report.sites, period).map(row => row.views)))
      : Math.max(1, ...report.sites.flatMap(site => periods.flatMap(period => site[period].map(row => row.views))));
    const panel = document.createElement("section");
    panel.className = `traffic-site${aggregate ? " traffic-aggregate" : ""}`;
    const heading = document.createElement("h3");
    const title = document.createElement("span");
    title.textContent = aggregate ? "All sites · total page views" : site.hostname;
    if (site) {
      const icon = document.createElement("img");
      icon.src = site.favicon || "/shared/logo.svg"; icon.alt = ""; icon.width = 28; icon.height = 28;
      heading.append(icon);
    }
    heading.append(title);
    const legend = document.createElement("div"); legend.className = "traffic-legend";
    const chart = document.createElement("div"); chart.className = "traffic-chart"; chart.setAttribute("role", "img");
    const labels = document.createElement("div"); labels.className = "traffic-labels traffic-ranges";
    const scale = document.createElement("p"); scale.className = "traffic-labels traffic-scale";
    const metric = document.createElement("div"); metric.className = "traffic-total";
    const draw = () => {
      const period = select.value;
      const rows = aggregate ? this.totals(report.sites, period) : site[period];
      const total = rows.reduce((sum, row) => sum + row.views, 0);
      metric.textContent = aggregate ? `${total.toLocaleString()} page views · ${report.sites.length} sites` : `${total.toLocaleString()} page views`;
      legend.replaceChildren(); chart.replaceChildren(); labels.replaceChildren();
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 1000 200"); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("aria-hidden", "true");
      const series = aggregate ? report.sites : [site];
      const addLine = (rows, color, name, totalLine = false) => {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        path.setAttribute("points", rows.map((row, index) => `${index / Math.max(1, rows.length - 1) * 1000},${200 - row.views / max * 200}`).join(" "));
        path.setAttribute("fill", "none"); path.setAttribute("stroke", color);
        path.setAttribute("stroke-width", totalLine ? "3" : "2");
        path.setAttribute("vector-effect", "non-scaling-stroke");
        path.setAttribute("data-series", name);
        const tooltip = document.createElementNS("http://www.w3.org/2000/svg", "title");
        tooltip.textContent = `${name}: ${rows.map(row => `${new Date(row.at).toISOString()}: ${row.views} page views`).join("; ")}`;
        path.append(tooltip); svg.append(path);
      };
      for (const source of series) {
        addLine(source[period], source.color || "#64748b", source.hostname);
        const key = document.createElement("span"); key.className = "traffic-key";
        key.style.color = source.color || "#64748b";
        if (aggregate) {
          const icon = document.createElement("img");
          icon.src = source.favicon || "/shared/logo.svg"; icon.alt = ""; icon.width = 22; icon.height = 22;
          key.append(icon);
        }
        const text = document.createElement("span");
        text.textContent = aggregate ? source.hostname : `${period === "hourly" ? "Hourly" : period === "daily" ? "Daily" : "Minute"} · ${total.toLocaleString()} views`;
        key.append(text); legend.append(key);
      }
      if (aggregate) {
        addLine(rows, "currentColor", "All sites", true);
        const key = document.createElement("span"); key.className = "traffic-key"; key.textContent = "All sites"; legend.append(key);
      }
      chart.append(svg);
      const axis = document.createElement("div");
      axis.className = "traffic-y-axis";
      axis.setAttribute("aria-hidden", "true");
      for (const fraction of [1, .75, .5, .25, 0]) {
        const tick = document.createElement("span");
        tick.textContent = Number((max * fraction).toFixed(2)).toLocaleString();
        axis.append(tick);
      }
      chart.append(axis);
      const format = at => new Date(at).toISOString().slice(5, period === "daily" ? 10 : 16).replace("T", " ");
      if (rows.length) for (const fraction of [0, .25, .5, .75, 1]) {
        const tick = document.createElement("span");
        const at = rows[Math.round(fraction * (rows.length - 1))].at;
        tick.textContent = period === "daily" ? format(at) : new Date(at).toISOString().slice(11, 16);
        tick.title = new Date(at).toISOString();
        labels.append(tick);
      } else labels.textContent = "No traffic data";
      chart.dataset.scaleMax = String(max);
      chart.setAttribute("aria-label", `${site?.hostname || "All sites"}: ${total} page views, ${period}, ${aggregate ? "aggregate" : "shared"} scale 0–${max} page views, UTC.`);
      scale.textContent = `UTC · ${aggregate ? "aggregate" : "shared"} scale: 0–${max.toLocaleString()} views per bucket`;
    };
    select.addEventListener("change", draw); draw();
    panel.append(heading, metric, legend, chart, labels, scale);
    return panel;
  }
};
