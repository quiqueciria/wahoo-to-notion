const axios = require("axios");
const { Client } = require("@notionhq/client");

// Configuración de Wahoo
let WAHOO_ACCESS_TOKEN = process.env.WAHOO_ACCESS_TOKEN;
const WAHOO_REFRESH_TOKEN = process.env.WAHOO_REFRESH_TOKEN;
const WAHOO_CLIENT_ID = process.env.WAHOO_CLIENT_ID;
const WAHOO_CLIENT_SECRET = process.env.WAHOO_CLIENT_SECRET;
const wahooUrl = "https://api.wahooligan.com/v1/workouts";

// Configuración de Notion
const notion = new Client({ auth: process.env.NOTION_INTEGRATION_TOKEN });
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Función para renovar el token de Wahoo con manejo detallado de errores
async function refreshAccessToken() {
  try {
    const params = new URLSearchParams();
    params.append("client_id", WAHOO_CLIENT_ID);
    params.append("client_secret", WAHOO_CLIENT_SECRET);
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", WAHOO_REFRESH_TOKEN);

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
    console.log("✅ Nuevo token de acceso de Wahoo obtenido con éxito.");
    return WAHOO_ACCESS_TOKEN;
  } catch (error) {
    console.error("❌ DETALLE DEL ERROR DE RENOVACIÓN EN WAHOO:");
    console.error(JSON.stringify(error.response?.data || error.message, null, 2));
    throw error;
  }
}

// Función principal de sincronización
async function getActivities() {
  try {
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
      // Extraer workout_summary o el objeto directamente según venga en la respuesta
      const summary = item.workout_summary || item;

      if (!summary || !summary.id) continue;

      const workoutId = summary.id.toString();

      // Métricas desde los nombres reales de la API v1 de Wahoo
      const rawDistance = parseFloat(summary.distance_accum || 0);
      const rawDuration = parseFloat(summary.duration_active_accum || summary.duration_total_accum || 0);
      const rawSpeed = parseFloat(summary.speed_avg || 0);

      const distanceInKm = parseFloat((rawDistance / 1000).toFixed(2));
      const elapsedTimeInHours = parseFloat((rawDuration / 3600).toFixed(2));
      
      // speed_avg viene en m/s -> multiplicar por 3.6 para pasar a km/h
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
        // Objeto de propiedades para Notion
        const properties = {
          Name: {
            title: [{ text: { content: workoutName } }],
          },
          Distance: {
            number: distanceInKm,
          },
          Date: {
            date: { start: startDate },
          },
          Elapsed: {
            number: elapsedTimeInHours,
          },
          Media: {
            number: averageSpeedKmH,
          },
        };

        // Asignar por defecto a 'Wahoo ID'
        properties["Wahoo ID"] = {
          rich_text: [{ text: { content: workoutId } }],
        };

        try {
          await notion.pages.create({
            parent: { database_id: NOTION_DATABASE_ID },
            properties: properties,
          });
          console.log(`✅ Actividad '${workoutName}' (${distanceInKm} km) guardada en Notion.`);
        } catch (notionError) {
          // Fallback por si en Notion la columna todavía se llama 'Strava ID'
          if (notionError.message.includes("Wahoo ID")) {
            delete properties["Wahoo ID"];
            properties["Strava ID"] = { rich_text: [{ text: { content: workoutId } }] };
            await notion.pages.create({
              parent: { database_id: NOTION_DATABASE_ID },
              properties: properties,
            });
            console.log(`✅ Actividad '${workoutName}' guardada en Notion (usando columna 'Strava ID').`);
          } else {
            console.error(`❌ Error guardando '${workoutName}' en Notion:`, notionError.message);
          }
        }
      } else {
        console.log(`ℹ️ La actividad '${workoutName}' (ID ${workoutId}) ya existe en Notion.`);
      }
    }
  } catch (error) {
    if (error.response && error.response.status === 401) {
      console.log("⚠️ Token caducado (401). Intentando renovar token de acceso...");
      WAHOO_ACCESS_TOKEN = await refreshAccessToken();
      // Reintentar la obtención de actividades una vez renovado
      await getActivities();
    } else {
      console.error(`❌ Error general de ejecución: ${error.message}`);
    }
  }
}

// Iniciar script
getActivities();
