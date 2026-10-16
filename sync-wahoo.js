const axios = require("axios");
const { Client } = require("@notionhq/client");
const fs = require("fs");
const path = require("path");

// Configuración de Wahoo
const WAHOO_CLIENT_ID = process.env.WAHOO_CLIENT_ID;
const WAHOO_CLIENT_SECRET = process.env.WAHOO_CLIENT_SECRET;
const wahooUrl = "https://api.wahooligan.com/v1/workouts";

// Cargar refresh token desde el archivo tokens.json o fallback a variables de entorno
const tokenFilePath = path.join(__dirname, "tokens.json");
let currentRefreshToken = process.env.WAHOO_REFRESH_TOKEN;

if (fs.existsSync(tokenFilePath)) {
  try {
    const fileData = JSON.parse(fs.readFileSync(tokenFilePath, "utf8"));
    if (fileData.refresh_token) {
      currentRefreshToken = fileData.refresh_token;
    }
  } catch (e) {
    console.log("No se pudo leer tokens.json, usando variable de entorno.");
  }
}

let WAHOO_ACCESS_TOKEN = "";

// Configuración de Notion
const notion = new Client({ auth: process.env.NOTION_INTEGRATION_TOKEN });
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Función para renovar el token y guardar el nuevo refresh_token
async function refreshAccessToken() {
  try {
    const params = new URLSearchParams();
    params.append("client_id", WAHOO_CLIENT_ID);
    params.append("client_secret", WAHOO_CLIENT_SECRET);
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", currentRefreshToken);

    console.log("Iniciando renovación del token de acceso de Wahoo...");

    const response = await axios.post(
      "https://api.wahooligan.com/oauth/token",
      params,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    WAHOO_ACCESS_TOKEN = response.data.access_token;
    
    // Si Wahoo devuelve un nuevo refresh_token, lo actualizamos localmente
    if (response.data.refresh_token) {
      currentRefreshToken = response.data.refresh_token;
      fs.writeFileSync(
        tokenFilePath,
        JSON.stringify({ refresh_token: currentRefreshToken }, null, 2)
      );
      console.log("✅ Nuevo refresh_token guardado en tokens.json para el próximo ciclo.");
    }

    console.log("✅ Nuevo token de acceso de Wahoo obtenido con éxito.");
    return WAHOO_ACCESS_TOKEN;
  } catch (error) {
    console.error("❌ ERROR AL RENOVAR TOKEN:", JSON.stringify(error.response?.data || error.message, null, 2));
    throw error;
  }
}

// Función principal de sincronización
async function getActivities() {
  try {
    // Renovar token obligatoriamente al inicio de cada ejecución (evita caducidades de 2h)
    await refreshAccessToken();

    const response = await axios.get(wahooUrl, {
      headers: { Authorization: `Bearer ${WAHOO_ACCESS_TOKEN}` },
    });

    const workouts = response.data.workouts || response.data;

    if (!workouts || workouts.length === 0) {
      console.log("No se encontraron entrenamientos en tu cuenta de Wahoo.");
      return;
    }

    console.log(`🚴‍♂️ Procesando ${workouts.length} entrenamientos...`);

    for (const item of workouts) {
      const summary = item.workout_summary || item;
      if (!summary || !summary.id) continue;

      const workoutId = summary.id.toString();
      const rawDistance = parseFloat(summary.distance_accum || 0);
      const rawDuration = parseFloat(summary.duration_active_accum || summary.duration_total_accum || 0);
      const rawSpeed = parseFloat(summary.speed_avg || 0);

      const distanceInKm = parseFloat((rawDistance / 1000).toFixed(2));
      const elapsedTimeInHours = parseFloat((rawDuration / 3600).toFixed(2));
      const averageSpeedKmH = parseFloat((rawSpeed * 3.6).toFixed(2));

      const startDate = summary.started_at || summary.created_at;
      const workoutName = summary.name || `Cycling (${startDate ? startDate.split("T")[0] : ""})`;

      // Buscar si el entrenamiento ya existe en Notion
      const existingPage = await notion.databases.query({
        database_id: NOTION_DATABASE_ID,
        filter: {
          or: [
            { property: "Wahoo ID", rich_text: { equals: workoutId } },
            { property: "Strava ID", rich_text: { equals: workoutId } }
          ]
        },
      }).catch(async () => {
        return await notion.databases.query({
          database_id: NOTION_DATABASE_ID,
          filter: {
            property: "Wahoo ID",
            rich_text: { equals: workoutId }
          }
        }).catch(() => ({ results: [] }));
      });

      if (existingPage.results.length === 0) {
        const properties = {
          Name: { title: [{ text: { content: workoutName } }] },
          Distance: { number: distanceInKm },
          Date: { date: { start: startDate } },
          Elapsed: { number: elapsedTimeInHours },
          Media: { number: averageSpeedKmH },
          "Wahoo ID": { rich_text: [{ text: { content: workoutId } }] },
        };

        try {
          await notion.pages.create({
            parent: { database_id: NOTION_DATABASE_ID },
            properties: properties,
          });
          console.log(`✅ Actividad '${workoutName}' (${distanceInKm} km) guardada en Notion.`);
        } catch (notionError) {
          if (notionError.message.includes("Wahoo ID")) {
            delete properties["Wahoo ID"];
            properties["Strava ID"] = { rich_text: [{ text: { content: workoutId } }] };
            await notion.pages.create({
              parent: { database_id: NOTION_DATABASE_ID },
              properties: properties,
            });
            console.log(`✅ Actividad '${workoutName}' guardada en Notion (usando 'Strava ID').`);
          } else {
            console.error(`❌ Error guardando '${workoutName}' en Notion:`, notionError.message);
          }
        }
      } else {
        console.log(`ℹ️ La actividad '${workoutName}' (ID ${workoutId}) ya existe en Notion.`);
      }
    }
  } catch (error) {
    console.error(`❌ Error general de ejecución: ${error.message}`);
  }
}

getActivities();
