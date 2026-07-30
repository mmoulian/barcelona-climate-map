const POLYGONS_URL = "0301100100_UNITATS_ADM_POLIGONS.json";
const CSV_URL = "datos2.csv?v=6";

const CATEGORY_COLORS = {
  1: "#E53935",
  2: "#EF5350",
  3: "#EF9A9A",
  4: "#FB8C00",
  5: "#FFA726",
  6: "#FFCC80",
};

const FILTER_GROUPS = [
  {
    id: "vulnerable",
    label: "Vulnerable:",
    className: "filter-row--vulnerable",
    items: [
      { valor: 1, label: "Alto estrés térmico" },
      { valor: 2, label: "Medio estrés térmico" },
      { valor: 3, label: "Bajo estrés térmico" },
    ],
  },
  {
    id: "no-vulnerable",
    label: "No vulnerable:",
    className: "filter-row--no-vulnerable",
    items: [
      { valor: 4, label: "Alto estrés térmico" },
      { valor: 5, label: "Medio estrés térmico" },
      { valor: 6, label: "Bajo estrés térmico" },
    ],
  },
];

let currentCategoryFilter = "all";
let barriLayerRef = null;
let referenceLayerRef = null;
let mapRef = null;
let mapResizeObserver = null;
let mapRefreshTimer = null;

proj4.defs(
  "EPSG:25831",
  "+proj=utm +zone=31 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"
);

function parseCSV(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }

  return rows;
}

function detectCsvDelimiter(text) {
  const header = text.trim().split(/\r?\n/)[0] || "";
  return header.includes(";") ? ";" : ",";
}

function normalizeBarriName(name) {
  return (
    name
      ?.trim()
      .toLocaleLowerCase("ca")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[-·]/g, " ")
      .replace(/\s+/g, " ") || ""
  );
}

function categoriaToValor(categoria) {
  const text = categoria?.trim().toLocaleLowerCase("ca") || "";
  const isVulnerable = text.includes("vulnerable") && !text.includes("no vulnerable");
  const isNoVulnerable = text.includes("no vulnerable");

  let nivel = 0;
  if (text.includes("alto") || text.includes("alt ")) nivel = 1;
  else if (text.includes("medio")) nivel = 2;
  else if (text.includes("bajo")) nivel = 3;

  if (isVulnerable && nivel) return nivel;
  if (isNoVulnerable && nivel) return nivel + 3;

  const valor = Number(text);
  return Number.isFinite(valor) && valor >= 1 && valor <= 6 ? valor : NaN;
}

function loadBarrioData(csvText) {
  const delimiter = detectCsvDelimiter(csvText);
  const rows = parseCSV(csvText.trim(), delimiter);
  const header = rows.shift();
  const barriIndex = header.indexOf("BARRI");
  const valorIndex = header.indexOf("VALOR");
  const categoriaIndex = header.indexOf("CATEGORIA");
  const codigoIndex = header.findIndex((column) =>
    /^CODIGO(\s+POSTAL)?$/i.test(column.trim())
  );
  const dataByBarri = {};

  rows.forEach((row) => {
    const barri = row[barriIndex]?.trim();
    const categoria = row[categoriaIndex]?.trim();
    const codigo = codigoIndex >= 0 ? row[codigoIndex]?.trim() : "";
    const valorFromColumn =
      valorIndex >= 0 ? Number(row[valorIndex]) : categoriaToValor(categoria);
    const valor = Number.isFinite(valorFromColumn)
      ? valorFromColumn
      : categoriaToValor(categoria);

    if (barri && Number.isFinite(valor)) {
      dataByBarri[normalizeBarriName(barri)] = {
        valor,
        categoria,
        codigo,
        barri,
      };
    }
  });

  return dataByBarri;
}

function getBarrioData(dataByBarri, nom) {
  return dataByBarri[normalizeBarriName(nom)] || null;
}

function lightenColor(hex, mix = 0.22) {
  const color = hex.replace("#", "");
  if (color.length !== 6) return hex;

  const value = Number.parseInt(color, 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  const toChannel = (channel) =>
    Math.round(channel + (255 - channel) * mix);

  return `#${[toChannel(red), toChannel(green), toChannel(blue)]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function getCategoryStyle(valor, hovered = false) {
  const baseColor = CATEGORY_COLORS[valor] || "#ddd";

  return {
    stroke: true,
    fill: true,
    color: "#FFFFFF",
    opacity: 1,
    weight: 1,
    fillColor: hovered ? lightenColor(baseColor) : baseColor,
    fillOpacity: 1,
    interactive: true,
  };
}

function getHiddenStyle() {
  return {
    stroke: true,
    fill: true,
    color: "#FFFFFF",
    opacity: 0,
    weight: 0,
    fillColor: "#fafafa",
    fillOpacity: 0,
    interactive: false,
  };
}

function getReferenceStyle() {
  return {
    color: "#FFFFFF",
    opacity: 1,
    weight: 1,
    fillColor: "#E0E0E0",
    fillOpacity: 1,
    interactive: false,
  };
}

function isLayerVisible(barrioData) {
  const valor = Number(barrioData?.valor);
  if (!Number.isFinite(valor)) return false;

  if (currentCategoryFilter === "all") return true;
  if (currentCategoryFilter === "vulnerable") return valor >= 1 && valor <= 3;
  if (currentCategoryFilter === "no-vulnerable") return valor >= 4 && valor <= 6;

  return String(valor) === currentCategoryFilter;
}

function applyLayerStyle(layer, hovered = false) {
  const barrioData = layer.barrioData;

  if (!isLayerVisible(barrioData)) {
    layer.setStyle(getHiddenStyle());
    return;
  }

  layer.setStyle(getCategoryStyle(barrioData?.valor, hovered));
}

function updateFilterUI() {
  document.querySelectorAll(".filter-group-btn").forEach((button) => {
    button.classList.toggle(
      "is-active",
      button.dataset.group === currentCategoryFilter
    );
  });

  document.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.classList.toggle(
      "is-active",
      chip.dataset.category === currentCategoryFilter
    );
  });

  document.getElementById("reset-filter")?.classList.toggle(
    "is-active",
    currentCategoryFilter !== "all"
  );
}

function applyCategoryFilter() {
  if (!barriLayerRef) return;

  updateFilterUI();

  if (referenceLayerRef && mapRef) {
    if (currentCategoryFilter === "all") {
      mapRef.removeLayer(referenceLayerRef);
      barriLayerRef.bringToFront();
    } else {
      if (!mapRef.hasLayer(referenceLayerRef)) {
        referenceLayerRef.addTo(mapRef);
      }
      barriLayerRef.bringToFront();
    }
  }

  barriLayerRef.eachLayer((layer) => {
    applyLayerStyle(layer);
  });

  scheduleMapRefresh();
}

function buildCategoryFilter() {
  const filter = document.getElementById("filter");
  filter.innerHTML = "";

  FILTER_GROUPS.forEach((group) => {
    const row = document.createElement("div");
    row.className = `filter-row ${group.className}`;

    const label = document.createElement("button");
    label.type = "button";
    label.className = "filter-group-btn";
    label.dataset.group = group.id;
    label.innerHTML = `<span class="filter-group-btn-label">${group.label}</span>`;
    label.addEventListener("click", () => {
      currentCategoryFilter =
        currentCategoryFilter === group.id ? "all" : group.id;
      applyCategoryFilter();
    });
    row.appendChild(label);

    group.items.forEach((item) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "filter-chip";
      chip.dataset.category = String(item.valor);
      chip.innerHTML = `
        <span class="filter-chip-dot" style="background:${CATEGORY_COLORS[item.valor]}"></span>
        <span class="filter-chip-label">${item.label}</span>
      `;

      chip.addEventListener("click", () => {
        const category = String(item.valor);
        currentCategoryFilter =
          currentCategoryFilter === category ? "all" : category;
        applyCategoryFilter();
      });

      row.appendChild(chip);
    });

    filter.appendChild(row);
  });
}

function initResetFilter() {
  document.getElementById("reset-filter").addEventListener("click", () => {
    currentCategoryFilter = "all";
    applyCategoryFilter();
  });
}

function buildPopupContent(nom, barrioData) {
  if (!barrioData) {
    return `<strong>${nom}</strong><br><span class="popup-missing">Sin datos</span>`;
  }

  const codigoHtml = barrioData.codigo
    ? `<span class="popup-postal">${barrioData.codigo}</span><br>`
    : "";

  return `<strong>${nom}</strong><br>${codigoHtml}<span class="popup-category">${barrioData.categoria}</span>`;
}

function reprojectCoords(coords) {
  if (typeof coords[0] === "number") {
    return proj4("EPSG:25831", "EPSG:4326", coords);
  }
  return coords.map(reprojectCoords);
}

function reprojectFeature(feature) {
  return {
    type: "Feature",
    properties: feature.properties,
    geometry: {
      type: feature.geometry.type,
      coordinates: reprojectCoords(feature.geometry.coordinates),
    },
  };
}

function filterBarrios(data) {
  return {
    type: "FeatureCollection",
    features: data.features
      .filter((feature) => feature.properties.TIPUS_UA === "BARRI")
      .map(reprojectFeature),
  };
}

function hideLoading() {
  document.getElementById("loading").classList.add("hidden");
}

function refreshMapLayout() {
  if (!mapRef || !barriLayerRef) return;

  mapRef.invalidateSize();
  mapRef.fitBounds(barriLayerRef.getBounds(), { padding: [20, 20] });
}

function scheduleMapRefresh() {
  clearTimeout(mapRefreshTimer);
  mapRefreshTimer = setTimeout(() => {
    requestAnimationFrame(refreshMapLayout);
  }, 100);
}

function initMapResizeHandling() {
  const appElement = document.getElementById("app");
  const filterPanel = document.getElementById("filter-panel");
  const mainElement = document.getElementById("main");
  const mapElement = document.getElementById("map");

  window.addEventListener("resize", scheduleMapRefresh);
  window.addEventListener("orientationchange", scheduleMapRefresh);

  if (typeof ResizeObserver !== "undefined") {
    mapResizeObserver = new ResizeObserver(scheduleMapRefresh);
    mapResizeObserver.observe(appElement);
    mapResizeObserver.observe(filterPanel);
    mapResizeObserver.observe(mainElement);
    mapResizeObserver.observe(mapElement);
  }
}

function initMap() {
  if (typeof L === "undefined" || typeof proj4 === "undefined") {
    document.getElementById("loading").textContent =
      "No se pudieron cargar las librerías del mapa. Comprueba tu conexión a internet.";
    return;
  }

  const map = L.map("map", {
    zoomControl: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
    boxZoom: false,
    keyboard: false,
    dragging: false,
    attributionControl: false,
  }).setView([41.387, 2.17], 12);

  mapRef = map;

  Promise.all([
    fetch(POLYGONS_URL).then((response) => {
      if (!response.ok) throw new Error("No se encontró el archivo de polígonos");
      return response.json();
    }),
    fetch(CSV_URL).then((response) => {
      if (!response.ok) throw new Error("No se encontró datos2.csv");
      return response.text();
    }),
  ])
    .then(([polygonsData, csvText]) => {
      const dataByBarri = loadBarrioData(csvText);
      const barriPolygons = filterBarrios(polygonsData);

      buildCategoryFilter();
      initResetFilter();

      referenceLayerRef = L.geoJSON(barriPolygons, {
        style: getReferenceStyle,
        interactive: false,
      });

      barriLayerRef = L.geoJSON(barriPolygons, {
        style(feature) {
          const barrioData = getBarrioData(dataByBarri, feature.properties.NOM);
          return isLayerVisible(barrioData)
            ? getCategoryStyle(barrioData?.valor)
            : getHiddenStyle();
        },
        onEachFeature(feature, layer) {
          const nom = feature.properties.NOM || "Barrio";
          const barrioData = getBarrioData(dataByBarri, nom);

          layer.barrioData = barrioData;
          layer.bindPopup(buildPopupContent(nom, barrioData));

          layer.on("mouseover", () => {
            if (!isLayerVisible(barrioData)) return;
            applyLayerStyle(layer, true);
          });

          layer.on("mouseout", () => {
            applyLayerStyle(layer);
          });
        },
      }).addTo(map);

      initMapResizeHandling();
      hideLoading();
      refreshMapLayout();
    })
    .catch((error) => {
      document.getElementById("loading").textContent =
        "Error al cargar los datos: " +
        error.message +
        ". Abre la página con un servidor local (no con doble clic).";
      console.error(error);
    });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initMap);
} else {
  initMap();
}
