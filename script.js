const POLYGONS_URL = "0301100100_UNITATS_ADM_POLIGONS.json";
const CSV_URL = "datos.csv";

const CATEGORY_COLORS = {
  1: "#B2182B",
  2: "#EF8A62",
  3: "#FDCC8A",
  4: "#AED581",
  5: "#7CB342",
  6: "#238443",
};

const FILTER_GROUPS = [
  {
    label: "Vulnerable:",
    className: "filter-row--vulnerable",
    items: [
      { valor: 1, label: "Alto estrés térmico" },
      { valor: 2, label: "Medio estrés térmico" },
      { valor: 3, label: "Bajo estrés térmico" },
    ],
  },
  {
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

function parseCSV(text) {
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
    } else if (char === ",") {
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

function loadBarrioData(csvText) {
  const rows = parseCSV(csvText.trim());
  const header = rows.shift();
  const barriIndex = header.indexOf("BARRI");
  const valorIndex = header.indexOf("VALOR");
  const categoriaIndex = header.indexOf("CATEGORIA");
  const dataByBarri = {};

  rows.forEach((row) => {
    const barri = row[barriIndex]?.trim();
    const valor = Number(row[valorIndex]);
    const categoria = row[categoriaIndex]?.trim();

    if (barri) {
      dataByBarri[barri] = { valor, categoria };
    }
  });

  return dataByBarri;
}

function getBarrioData(dataByBarri, nom) {
  return (
    dataByBarri[nom] ||
    dataByBarri[nom?.trim()] ||
    null
  );
}

function getCategoryStyle(valor, hovered = false) {
  return {
    color: "#FFFFFF",
    opacity: 1,
    weight: 1,
    fillColor: CATEGORY_COLORS[valor] || "#ddd",
    fillOpacity: hovered ? 0.9 : 0.75,
    interactive: true,
  };
}

function getHiddenStyle() {
  return {
    color: "#000",
    opacity: 0,
    weight: 0,
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
  if (currentCategoryFilter === "all") return true;
  return String(barrioData?.valor) === currentCategoryFilter;
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
  document.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.classList.toggle(
      "is-active",
      chip.dataset.category === currentCategoryFilter
    );
  });
}

function applyCategoryFilter() {
  if (!barriLayerRef) return;

  updateFilterUI();

  if (referenceLayerRef && mapRef) {
    if (currentCategoryFilter === "all") {
      mapRef.removeLayer(referenceLayerRef);
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
}

function buildCategoryFilter() {
  const filter = document.getElementById("filter");
  filter.innerHTML = "";

  FILTER_GROUPS.forEach((group) => {
    const row = document.createElement("div");
    row.className = `filter-row ${group.className}`;

    const label = document.createElement("div");
    label.className = "filter-row-label";
    label.textContent = group.label;
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

  return `<strong>${nom}</strong><br><span class="popup-category">${barrioData.categoria}</span>`;
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
      if (!response.ok) throw new Error("No se encontró datos.csv");
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
